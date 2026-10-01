//! 关联 id + 伪装头 + 免费通道体门禁 + 思考档位归一。
//!
//! 这几块是整个工具里最「反直觉」也最容易改坏的部分，行为必须与 Node 版
//! 逐位一致——`selftest.mjs` 里针对它们有回归测试。

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

/// 匿名通道的固定 Bearer，不是密钥，PI-Desktop 那边也一样写死。
pub const ANONYMOUS_KEY: &str = "public";

/// 伪装成哪个版本的官方 CLI。上游若收紧，改这里。
pub const OPENCODE_CLIENT_VERSION: &str = "1.18.31";

const BASE62_ALPHABET: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/// 实测：匿名通道对不流式、或缺 bash/read 函数工具的 chat 请求直接 403。
const FREE_LANE_GATE_TOOL_NAMES: [&str; 2] = ["bash", "read"];

/// 上游确实会接受的「主动思考」档位。off/none 不在其中，见 effort 模块注释。
pub const ACCEPTED_EFFORT_LADDER: [&str; 6] = ["minimal", "low", "medium", "high", "xhigh", "max"];
pub const DEFAULT_EFFORT_LADDER: [&str; 4] = ["minimal", "low", "medium", "high"];

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

/// 免费通道只认 ses_+12hex+14base62 的形状，别的都确定性哈希进去。
fn canonical_session_id(signal: &str) -> String {
    if is_canonical_session(signal) {
        return signal.to_string();
    }
    let hex = sha256_hex(&format!("ses\0{signal}"));
    let time_part = hex_slice(&hex, 0, 12);
    let tail = u128::from_str_radix(hex_slice(&hex, 12, 32), 16).unwrap_or(0);
    format!("ses_{time_part}{}", base62_fixed(tail, 14))
}

fn is_canonical_session(value: &str) -> bool {
    let Some(rest) = value.strip_prefix("ses_") else {
        return false;
    };
    if rest.len() != 26 {
        return false;
    }
    let (head, tail) = rest.split_at(12);
    head.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
        && tail.chars().all(|c| c.is_ascii_alphanumeric())
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
        request: format!("req_{}", hex_slice(&sha256_hex(&random_hex()), 0, 32)),
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

fn free_lane_gate_tool(name: &str) -> Value {
    json!({
        "type": "function",
        "function": {
            "name": name,
            "description": "Reserved for the host runtime; do not call it.",
            "parameters": { "type": "object", "properties": {} },
        }
    })
}

/// 补齐缺失的门禁工具。原本一个工具都没有时补 tool_choice:"none"，
/// 免得模型真的去调这两个占位桩；宿主自带工具时不动它的 tool_choice。
pub fn ensure_free_lane_shape(body: &Value) -> Value {
    let tools = body.get("tools").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut missing: Vec<&str> = Vec::new();
    for gate in FREE_LANE_GATE_TOOL_NAMES {
        let present = tools.iter().any(|tool| {
            tool.get("function")
                .and_then(|f| f.get("name"))
                .and_then(Value::as_str)
                == Some(gate)
        });
        if !present {
            missing.push(gate);
        }
    }
    if missing.is_empty() {
        return body.clone();
    }
    let mut next = body.as_object().cloned().unwrap_or_default();
    let was_empty = tools.is_empty();
    let mut merged = tools;
    for name in missing {
        merged.push(free_lane_gate_tool(name));
    }
    next.insert("tools".into(), Value::Array(merged));
    if was_empty {
        next.insert("tool_choice".into(), Value::String("none".into()));
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

/// 把宿主发来的 chat 体整理成免费通道能收的形状：强制流式、透传受支持的
/// 思考档位（否则不带这个字段）、再套门禁。其余原样转发。
pub fn build_upstream_body(host_body: &Value) -> Value {
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
    ensure_free_lane_shape(&Value::Object(body))
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
        let body = build_upstream_body(&json!({ "model": "x" }));
        let tools = body.get("tools").and_then(Value::as_array).unwrap();
        assert_eq!(tools.len(), 2);
        assert_eq!(body.get("tool_choice").and_then(Value::as_str), Some("none"));
        assert_eq!(body.get("stream").and_then(Value::as_bool), Some(true));
    }

    #[test]
    fn 宿主自带工具时不动_tool_choice() {
        let body = build_upstream_body(&json!({
            "model": "x",
            "tools": [{ "type": "function", "function": { "name": "bash" } }],
            "tool_choice": "auto",
        }));
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
