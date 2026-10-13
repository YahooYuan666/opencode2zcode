//! 关联 id + 伪装头 + 免费通道体门禁 + 思考档位归一。
//!
//! 这几块是整个工具里最「反直觉」也最容易改坏的部分，行为必须与 Node 版
//! 逐位一致——`selftest.mjs` 里针对它们有回归测试。

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

/// 匿名通道的固定 Bearer，不是密钥，PI-Desktop 那边也一样写死。
pub const ANONYMOUS_KEY: &str = "public";

/// 伪装成哪个版本的官方 CLI。上游若收紧，改这里。
pub const OPENCODE_CLIENT_VERSION: &str = "1.18.31";

const BASE62_ALPHABET: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/// 实测（2026-10-01 对真实上游逐项回放）：匿名通道对不流式、或缺 bash/read
/// 函数工具的请求一律 403。chat 道与 responses 道都要有这两个工具。
const FREE_LANE_GATE_TOOL_NAMES: [&str; 2] = ["bash", "read"];

/// 上游确实会接受的「主动思考」档位。off/none 不在其中，见 effort 模块注释。
pub const ACCEPTED_EFFORT_LADDER: [&str; 6] = ["minimal", "low", "medium", "high", "xhigh", "max"];
pub const DEFAULT_EFFORT_LADDER: [&str; 4] = ["minimal", "low", "medium", "high"];

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn base62_fixed(mut value: u128, width: usize) -> String {
    let base: u128 = 62;
    let mut out: Vec<u8> = vec![b'0'; width];
    for i in (0..width).rev() {
        out[i] = BASE62_ALPHABET[(value % base) as usize];
        value /= base;
    }
    String::from_utf8(out).unwrap_or_default()
}

fn sha256_hex(data: &str) -> String {
    let digest = Sha256::digest(data.as_bytes());
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// sha256("prefix\0value") 取前 12 字节十六进制，稳定且不可逆。
fn stable_id(prefix: &str, value: &str) -> String {
    let hex = &sha256_hex(&format!("{prefix}\0{value}"));
    format!("{prefix}_{}", &hex[..24])
}

fn hex_slice(hex: &str, start: usize, end: usize) -> &str {
    // 上面 hex 是 ASCII，索引即字节索引；调用方保证 start/end 落在字符边界内。
    &hex[start..end]
}

/// 会话信号 = 第一条 user 消息内容的 JSON，同一对话恒定。
fn conversation_seed(messages: &[Value]) -> String {
    for message in messages {
        let role = message.get("role").and_then(Value::as_str).unwrap_or("");
        if role != "user" {
            continue;
        }
        let content = message.get("content").cloned().unwrap_or(Value::Null);
        let encoded = serde_json::to_string(&content).unwrap_or_else(|_| "null".into());
        if encoded != "null" && !encoded.is_empty() {
            return encoded;
        }
    }
    String::new()
}

/// 官方客户端 Identifier.descending() 生成的时间戳前缀：
/// ~(Date.now() * 0x1000 + 1) 截断到 48 位取 12 位十六进制，由于末位 counter=1，
/// 低 12 位取反后必然以 "ffe" 结尾。
pub fn inverted_timestamp_hex(now: u64) -> String {
    let current = (now as u128) * 0x1000 + 1;
    let inverted = (!current) & 0xFFFFFFFFFFFF;
    format!("{inverted:012x}")
}

/// 检查 session 前缀是否是合法的官方降序时间戳（2026-10-13 上游新增时间校验）
fn is_descending_time_part(time_part: &str) -> bool {
    if time_part.len() != 12 {
        return false;
    }
    // 官方接受 counter 1-63，也就是以 f[c-f][0-9a-f] 结尾
    let bytes = time_part.as_bytes();
    bytes.iter().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        && bytes[9] == b'f'
        && (b'c'..=b'f').contains(&bytes[10])
}

fn is_canonical_session(value: &str) -> bool {
    let Some(rest) = value.strip_prefix("ses_") else {
        return false;
    };
    if rest.len() != 26 {
        return false;
    }
    let (head, tail) = rest.split_at(12);
    is_descending_time_part(head) && tail.chars().all(|c| c.is_ascii_alphanumeric())
}

const SESSION_MEMO_LIMIT: usize = 1024;
static SESSION_MEMO: Mutex<Option<VecDeque<(String, String)>>> = Mutex::new(None);

/// 免费通道要求真实的倒序时钟时间戳（2026-10-13 上游收紧）。
/// 为了防止多轮对话或重试因毫秒漂移丢失会话缓存和配额亲和，
/// 按会话种子 signal 进行 memo 缓存（上限 1024）。
fn canonical_session_id(signal: &str) -> String {
    if is_canonical_session(signal) {
        return signal.to_string();
    }

    let mut lock = SESSION_MEMO.lock().unwrap();
    let memo = lock.get_or_insert_with(VecDeque::new);

    for (k, v) in memo.iter() {
        if k == signal {
            return v.clone();
        }
    }

    let sum = sha256_hex(&format!("ses\0{signal}"));
    let time_part = inverted_timestamp_hex(now_millis());
    let tail = u128::from_str_radix(hex_slice(&sum, 12, 32), 16).unwrap_or(0);
    let session = format!("ses_{time_part}{}", base62_fixed(tail, 14));

    if memo.len() >= SESSION_MEMO_LIMIT {
        memo.pop_front();
    }
    memo.push_back((signal.to_string(), session.clone()));

    session
}

/// 官方客户端格式的 request ID：`msg_` + 递增正序时间戳(12位hex) + 14位Base62随机串
fn mint_canonical_request_id() -> String {
    let current = (now_millis() as u128) * 0x1000 + 1;
    let time_part = format!("{:012x}", current & 0xFFFFFFFFFFFF);
    let rand_val = u128::from_str_radix(&random_hex()[..30], 16).unwrap_or(0);
    format!("msg_{time_part}{}", base62_fixed(rand_val, 14))
}

pub struct RequestIds {
    pub session: String,
    pub request: String,
    pub project: String,
}

fn derive_request_ids(messages: &[Value]) -> RequestIds {
    let mut signal = conversation_seed(messages);
    if signal.is_empty() || signal == "{}" {
        signal = format!("fallback_{}", hex_slice(&sha256_hex(&signal_or_random()), 0, 32));
    }
    RequestIds {
        session: canonical_session_id(&signal),
        request: mint_canonical_request_id(),
        project: stable_id("prj", "opencode2zcode:default-project"),
    }
}

/// 没有可用信号时用的随机量。Node 版用 randomBytes(16)，这里用系统随机源。
fn signal_or_random() -> String {
    random_hex()
}

fn random_hex() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    // 关联 id 不承担安全职责（上游只做形状校验），但仍避免同一时刻多进程撞值。
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id() as u128;
    let mixed = nanos ^ (pid << 64) ^ (&nanos as *const u128 as usize as u128);
    format!("{mixed:032x}")
}

pub fn opencode_user_agent() -> String {
    format!(
        "opencode/{} ({} {}; node{})",
        OPENCODE_CLIENT_VERSION,
        std::env::consts::OS,
        std::env::consts::ARCH,
        "20"
    )
}

/// 每次上游请求都带的完整伪装头。
pub fn disguise_headers(ids: &RequestIds) -> Vec<(&'static str, String)> {
    vec![
        ("user-agent", opencode_user_agent()),
        ("x-opencode-client", "cli".into()),
        ("x-opencode-session", ids.session.clone()),
        ("x-session-affinity", ids.session.clone()),
        ("x-session-id", ids.session.clone()),
        ("x-opencode-request", ids.request.clone()),
        ("x-opencode-project", ids.project.clone()),
    ]
}

/// chat 与 responses 两种线格式都归一到同一份关联 id：
/// chat 看 messages，responses 看 input（字符串或 item 数组）。
pub fn derive_request_ids_from_wire(body: &Value) -> RequestIds {
    if let Some(messages) = body.get("messages").and_then(Value::as_array) {
        return derive_request_ids(messages);
    }
    match body.get("input") {
        Some(Value::String(text)) => derive_request_ids(&[json!({ "role": "user", "content": text })]),
        Some(Value::Array(items)) => {
            let messages: Vec<Value> = items
                .iter()
                .filter_map(|item| match item {
                    Value::String(text) => Some(json!({ "role": "user", "content": text })),
                    Value::Object(map) => {
                        let role = if map.get("role").and_then(Value::as_str) == Some("assistant") {
                            "assistant"
                        } else {
                            "user"
                        };
                        let content = match map.get("content") {
                            Some(Value::String(text)) => text.clone(),
                            Some(Value::Array(parts)) => parts
                                .iter()
                                .map(|part| {
                                    part.get("text")
                                        .and_then(Value::as_str)
                                        .unwrap_or_default()
                                        .to_string()
                                })
                                .collect::<String>(),
                            _ => map
                                .get("text")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_string(),
                        };
                        Some(json!({ "role": role, "content": content }))
                    }
                    _ => None,
                })
                .collect();
            derive_request_ids(&messages)
        }
        _ => derive_request_ids(&[]),
    }
}

/// 门禁工具的描述与参数：描述和参数上游不检查，两种线格式统一用同一份文案。
const GATE_DESCRIPTION: &str = "Reserved for the host runtime; do not call it.";

/// chat/completions 的线格式：工具定义嵌在 `function` 里。
fn free_lane_gate_tool_chat(name: &str) -> Value {
    json!({
        "type": "function",
        "function": {
            "name": name,
            "description": GATE_DESCRIPTION,
            "parameters": { "type": "object", "properties": {} },
        }
    })
}

/// responses 的线格式：**扁平**，`name` 直接挂在工具上。
/// 套错格式会被上游判 400（`tools[0] missing required field name`）。
fn free_lane_gate_tool_responses(name: &str) -> Value {
    json!({
        "type": "function",
        "name": name,
        "description": GATE_DESCRIPTION,
        "parameters": { "type": "object", "properties": {} },
    })
}

/// 补齐缺失的门禁工具。
///
/// chat 道：原本一个工具都没有时补 `tool_choice: "none"`，免得模型真去调这两个
/// 占位桩。
/// responses 道：**绝对不能碰 `tool_choice`**。上游那个端点只接受
/// `"auto"` / `"required"` / 具体工具名，给 `"none"` 会直接 400
/// （`only ... are supported`）。这是踩过的坑——最早判定「responses 道没救」
/// 就是因为照搬了 chat 道的 `tool_choice: "none"`，而它恰好是致命的那个。
pub fn ensure_free_lane_shape(body: &Value, lane: Lane) -> Value {
    let tools = body.get("tools").and_then(Value::as_array).cloned().unwrap_or_default();
    fn name_of<'a>(tool: &'a Value, lane: Lane) -> Option<&'a str> {
        match lane {
            // 两种线格式都要认，宿主或上游可能用了其中一种
            Lane::Chat => tool
                .get("function")
                .and_then(|f| f.get("name"))
                .and_then(Value::as_str)
                .or_else(|| tool.get("name").and_then(Value::as_str)),
            Lane::Responses => tool
                .get("name")
                .and_then(Value::as_str)
                .or_else(|| {
                    tool.get("function").and_then(|f| f.get("name")).and_then(Value::as_str)
                }),
        }
    }
    let mut missing: Vec<&str> = Vec::new();
    for gate in FREE_LANE_GATE_TOOL_NAMES {
        if !tools.iter().any(|tool| name_of(tool, lane) == Some(gate)) {
            missing.push(gate);
        }
    }
    let mut next = body.as_object().cloned().unwrap_or_default();

    if !missing.is_empty() {
        let was_empty = tools.is_empty();
        let mut merged = tools;
        for name in missing {
            merged.push(match lane {
                Lane::Chat => free_lane_gate_tool_chat(name),
                Lane::Responses => free_lane_gate_tool_responses(name),
            });
        }
        next.insert("tools".into(), Value::Array(merged));
        if was_empty && lane == Lane::Chat {
            next.insert("tool_choice".into(), Value::String("none".into()));
        }
    }

    if lane == Lane::Responses {
        // 宿主带过来的 "none" 同样要摘掉，否则必 400。
        if next.get("tool_choice").and_then(Value::as_str) == Some("none") {
            next.remove("tool_choice");
        }
    }
    Value::Object(next)
}

/// 只透传上游确实认的主动档位；off / none / 缺失 / 未知一律省略该字段。
pub fn upstream_effort(host_value: Option<&str>) -> Option<&'static str> {
    let raw = host_value?;
    if raw.is_empty() {
        return None;
    }
    ACCEPTED_EFFORT_LADDER.iter().find(|level| **level == raw).copied()
}

/// 上游的两条线格式。门禁规则相同，但工具定义的形状和 `tool_choice` 的处理不同。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Lane {
    Chat,
    Responses,
}

/// 把宿主发来的请求体整理成免费通道能收的形状：强制流式、透传受支持的思考档位
/// （否则不带这个字段）、再套门禁。其余原样转发。
pub fn build_upstream_body(host_body: &Value, lane: Lane) -> Value {
    let source = host_body.as_object().cloned().unwrap_or_default();
    let mut body: Map<String, Value> = source;
    body.insert("stream".into(), Value::Bool(true));
    match upstream_effort(body.get("reasoning_effort").and_then(Value::as_str)) {
        None => {
            body.remove("reasoning_effort");
        }
        Some(effort) => {
            body.insert("reasoning_effort".into(), Value::String(effort.into()));
        }
    }
    ensure_free_lane_shape(&Value::Object(body), lane)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 被动档位透传_off_and_none_dropped() {
        assert_eq!(upstream_effort(Some("high")), Some("high"));
        assert_eq!(upstream_effort(Some("max")), Some("max"));
        // 回归：原样透传 none 会被上游打成 400
        assert_eq!(upstream_effort(Some("none")), None);
        assert_eq!(upstream_effort(Some("off")), None);
        assert_eq!(upstream_effort(Some("turbo")), None);
        assert_eq!(upstream_effort(None), None);
        assert_eq!(upstream_effort(Some("")), None);
    }

    #[test]
    fn 门禁工具被补齐且无工具时关掉调用() {
        let body = build_upstream_body(&json!({ "model": "x" }), Lane::Chat);
        let tools = body.get("tools").and_then(Value::as_array).unwrap();
        assert_eq!(tools.len(), 2);
        assert_eq!(body.get("tool_choice").and_then(Value::as_str), Some("none"));
        assert_eq!(body.get("stream").and_then(Value::as_bool), Some(true));
    }

    #[test]
    fn 宿主自带工具时不动_tool_choice() {
        let body = build_upstream_body(
            &json!({
                "model": "x",
                "tools": [{ "type": "function", "function": { "name": "bash" } }],
                "tool_choice": "auto",
            }),
            Lane::Chat,
        );
        let tools = body.get("tools").and_then(Value::as_array).unwrap();
        assert_eq!(tools.len(), 2, "只补缺的 read");
        assert_eq!(body.get("tool_choice").and_then(Value::as_str), Some("auto"));
    }

    #[test]
    fn 会话_id_形状规范且同一对话恒定() {
        let messages = vec![json!({ "role": "user", "content": "hello" })];
        let a = derive_request_ids(&messages);
        let b = derive_request_ids(&messages);
        assert_eq!(a.session, b.session, "同一对话应恒定");
        assert!(is_canonical_session(&a.session), "形状应为 ses_+12hex+14base62，实际 {}", a.session);
        assert_eq!(&a.session[13..16], "ffe", "真实倒序时钟末3位必须为 ffe");
        assert!(a.request.starts_with("msg_"), "请求ID格式必须为 msg_，实际 {}", a.request);
    }

    #[test]
    fn 真实倒序时钟算法对齐官方() {
        let hex = inverted_timestamp_hex(1_791_895_680_000);
        assert_eq!(&hex[9..12], "ffe", "counter=1 时取反末3位必须是 ffe");
        assert!(is_descending_time_part(&hex));
    }

    #[test]
    fn 伪装头齐全() {
        let ids = derive_request_ids(&[json!({ "role": "user", "content": "hi" })]);
        let headers = disguise_headers(&ids);
        let names: Vec<&str> = headers.iter().map(|(k, _)| *k).collect();
        for want in ["user-agent", "x-opencode-client", "x-opencode-session", "x-opencode-request", "x-opencode-project"] {
            assert!(names.contains(&want), "缺头 {want}");
        }
    }
}
