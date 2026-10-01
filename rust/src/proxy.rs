//! 回环 HTTP 服务：接收 ZCode 的对话请求，伪装后转发给 Zen，再把 SSE 逐块透传回去。
//!
//! 两端同一套方言，所以不重编码，流式零损耗。
//!
//! HTTP 解析交给 tiny_http 而不是自己手写——这是重写里最容易悄悄写错的地方，
//! 能交给久经考验的实现就别自己来。

use std::io::{BufRead, BufReader, Read};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tiny_http::{Header, Response, Server};

use crate::zen::{build_upstream_body, derive_request_ids_from_wire, disguise_headers, Lane, ANONYMOUS_KEY};

const UPSTREAM_TIMEOUT: Duration = Duration::from_secs(60);
/// 命中这些状态码且确实带了 reasoning_effort 时，摘掉该字段重试一次。
const RETRY_WITHOUT_EFFORT_STATUSES: [u16; 3] = [400, 422, 500];

pub struct State {
    pub port: Mutex<u16>,
    pub requests: AtomicU64,
    pub errors: AtomicU64,
    pub last_error: Mutex<String>,
    pub chat_models: Mutex<Vec<String>>,
    pub responses_models: Mutex<Vec<String>>,
    pub catalog_status: Mutex<Value>,
    /// 上次写进 ZCode 配置的序列化结果，用于「没变化就不重写」。
    pub last_written: Mutex<String>,
}

impl State {
    pub fn new() -> Self {
        Self {
            port: Mutex::new(0),
            requests: AtomicU64::new(0),
            errors: AtomicU64::new(0),
            last_error: Mutex::new(String::new()),
            chat_models: Mutex::new(Vec::new()),
            responses_models: Mutex::new(Vec::new()),
            catalog_status: Mutex::new(json!({ "status": "pending" })),
            last_written: Mutex::new(String::new()),
        }
    }

    pub fn set_port(&self, port: u16) {
        *self.port.lock().unwrap() = port;
    }

    pub fn current_port(&self) -> u16 {
        *self.port.lock().unwrap()
    }

    fn set_error(&self, message: &str) {
        *self.last_error.lock().unwrap() = message.to_string();
        self.errors.fetch_add(1, Ordering::Relaxed);
    }
}

fn header_value(request: &tiny_http::Request, name: &str) -> Option<String> {
    let want = name.to_ascii_lowercase();
    let mut found: Option<String> = None;
    for header in request.headers() {
        if header.field.as_str().as_str().eq_ignore_ascii_case(&want) {
            found = Some(header.value.as_str().to_string());
            break;
        }
    }
    found
}

fn is_loopback_host(host: Option<&str>) -> bool {
    let Some(value) = host else { return false };
    let value = value.trim().to_ascii_lowercase();
    value.starts_with("127.0.0.1")
        || value.starts_with("localhost")
        || value.starts_with("[::1]")
        || value.starts_with("::1")
}

fn is_loopback_origin(origin: Option<&str>) -> bool {
    // 没有 Origin 的（宿主侧的请求）放行，有则必须是回环。
    match origin {
        None => true,
        Some(raw) if raw.is_empty() => true,
        Some(raw) => {
            let after_scheme = raw.split_once("://").map(|(_, r)| r).unwrap_or(raw);
            let host = after_scheme.split('/').next().unwrap_or("");
            let host = host.split(':').next().unwrap_or("");
            matches!(host, "127.0.0.1" | "localhost" | "::1" | "[::1]")
        }
    }
}

pub fn extract_error_message(body_text: &str, status: u16) -> String {
    let mut snippet: String = body_text.chars().take(300).collect();
    if let Ok(parsed) = serde_json::from_str::<Value>(body_text) {
        let candidate = parsed
            .get("message")
            .and_then(Value::as_str)
            .or_else(|| {
                parsed
                    .get("error")
                    .and_then(|e| e.get("message").or_else(|| e.get("code")))
                    .and_then(Value::as_str)
            });
        if let Some(text) = candidate {
            snippet = text.to_string();
        }
    }
    match status {
        403 => format!("上游 403（免费通道门禁或区域限制）：{snippet}"),
        429 => format!("上游 429 限速（匿名通道按 IP 计配额）：{snippet}"),
        _ => format!("上游 {status}：{snippet}"),
    }
}

/// 用 Response::new 而不是 from_data：前者能接任意 Read，
/// from_data 只接受已在内存里的字节，那样 SSE 就没法边收边发了。
fn streaming_response(status: u16, reader: Box<dyn Read + Send + 'static>) -> Response<Box<dyn Read + Send + 'static>> {
    let mut response = Response::new(
        tiny_http::StatusCode(status),
        Vec::new(),
        reader,
        None, // 不给 Content-Length → 走 chunked，流式成立
        None,
    );
    response = response.with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json; charset=utf-8"[..]).unwrap());
    response.with_chunked_threshold(0)
}

fn json_response(status: u16, payload: &Value) -> Response<Box<dyn Read + Send + 'static>> {
    let boxed: Box<dyn Read + Send + 'static> = Box::new(std::io::Cursor::new(payload.to_string().into_bytes()));
    streaming_response(status, boxed)
}

fn build_health(state: &State) -> Value {
    let chat = state.chat_models.lock().unwrap().clone();
    let responses = state.responses_models.lock().unwrap().clone();
    json!({
        "ok": true,
        "port": state.current_port(),
        "chatModels": chat.len(),
        "responsesModels": responses.len(),
        "catalog": state.catalog_status.lock().unwrap().clone(),
        "requests": state.requests.load(Ordering::Relaxed),
        "errors": state.errors.load(Ordering::Relaxed),
        "lastError": state.last_error.lock().unwrap().clone(),
    })
}

fn send_upstream(
    client: &reqwest::blocking::Client,
    url: &str,
    ids: &crate::zen::RequestIds,
    payload: &Value,
) -> Result<reqwest::blocking::Response, String> {
    let mut request = client
        .post(url)
        .header("authorization", format!("Bearer {ANONYMOUS_KEY}"))
        .header("content-type", "application/json")
        .header("accept", "text/event-stream");
    for (name, value) in disguise_headers(ids) {
        request = request.header(name, value);
    }
    request.timeout(UPSTREAM_TIMEOUT).json(payload).send().map_err(|e| e.to_string())
}

/// 上游的一次应答。流式与否由**客户端**决定，不由我们决定。
enum Upstream {
    /// 上游 2xx，返回的是 SSE 流（免费通道要求流式，这条不变）。
    Stream(Box<dyn Read + Send + 'static>),
    /// 非 2xx：把字节原样交回去。
    Whole { status: u16, content_type: String, body: Vec<u8> },
}

/// 转发一次对话请求。
fn forward(
    state: &State,
    zen_base_url: &str,
    upstream_path: &str,
    host_body: &Value,
) -> Result<Upstream, String> {
    // 两条道都要：强制流式 + 归一思考档位 + 补 bash/read 门禁工具。
    // 门禁规则相同，但工具定义的线格式不同、tool_choice 的处理不同，见 zen::Lane。
    let lane = if upstream_path.ends_with("/responses") { Lane::Responses } else { Lane::Chat };
    let body = build_upstream_body(host_body, lane);
    let ids = derive_request_ids_from_wire(&body);

    let client = crate::http::client()?;
    let url = format!("{zen_base_url}{upstream_path}");
    let mut response = send_upstream(&client, &url, &ids, &body)?;

    // 档位是逐模型实测出来的，仍可能撞上某个模型不收某个档位；只在「确实带了
    // reasoning_effort」且上游明确拒绝时，摘掉该字段重试一次。
    if !response.status().is_success()
        && body.get("reasoning_effort").is_some()
        && RETRY_WITHOUT_EFFORT_STATUSES.contains(&response.status().as_u16())
    {
        eprintln!(
            "[zen] reasoning_effort={} 被上游拒绝（HTTP {}），摘掉该字段重试",
            body.get("reasoning_effort").and_then(Value::as_str).unwrap_or(""),
            response.status()
        );
        let _ = response.text();
        let mut retry_body = body.as_object().cloned().unwrap_or_default();
        retry_body.remove("reasoning_effort");
        response = send_upstream(&client, &url, &ids, &Value::Object(retry_body))?;
    }

    if !response.status().is_success() {
        let status = response.status().as_u16();
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("application/json")
            .to_string();
        let text = response.text().unwrap_or_default();
        let message = extract_error_message(&text, status);
        state.set_error(&message);
        eprintln!("[zen] {}", message.chars().take(200).collect::<String>());
        return Ok(Upstream::Whole { status, content_type, body: text.into_bytes() });
    }

    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("text/event-stream")
        .to_string();
    let status = response.status().as_u16();
    // reqwest 的 blocking Response 本身就实现 Read，直接拿来当流。
    Ok(Upstream::Stream(Box::new(response)))
}

pub fn handle_request(mut request: tiny_http::Request, state: &Arc<State>, zen_base_url: &str) {
    let host_header = header_value(&request, "Host");
    let origin_header = header_value(&request, "Origin");
    if !is_loopback_host(host_header.as_deref()) || !is_loopback_origin(origin_header.as_deref()) {
        let _ = request.respond(json_response(403, &json!({ "error": { "message": "loopback requests only" } })));
        return;
    }

    let method = request.method().as_str().to_string();
    let path = request.url().split('?').next().unwrap_or("/").to_string();

    if method == "GET" && (path == "/healthz" || path == "/") {
        let _ = request.respond(json_response(200, &build_health(state)));
        return;
    }

    if method == "GET" && (path == "/v1/models" || path == "/models") {
        let models: Vec<Value> = state
            .chat_models
            .lock()
            .unwrap()
            .iter()
            .map(|id| json!({ "id": id, "object": "model", "name": id }))
            .collect();
        let _ = request.respond(json_response(200, &json!({ "object": "list", "data": models })));
        return;
    }

    let upstream_path = if method == "POST" && path.ends_with("/responses") {
        "/v1/responses"
    } else if method == "POST" && path.ends_with("/chat/completions") {
        "/v1/chat/completions"
    } else {
        let _ = request.respond(json_response(404, &json!({ "error": { "message": "not found" } })));
        return;
    };

    let mut body_bytes = Vec::new();
    if let Err(e) = request.as_reader().read_to_end(&mut body_bytes) {
        state.set_error(&e.to_string());
        let _ = request.respond(json_response(400, &json!({ "error": { "message": "读不到请求体" } })));
        return;
    }
    let host_body: Value = match serde_json::from_slice(&body_bytes) {
        Ok(v) => v,
        Err(e) => {
            state.set_error(&e.to_string());
            let _ = request.respond(
                json_response(400, &json!({ "error": { "message": format!("请求体不是合法 JSON：{e}") } })),
            );
            return;
        }
    };

    state.requests.fetch_add(1, Ordering::Relaxed);
    let wants_stream = host_body.get("stream").and_then(Value::as_bool).unwrap_or(false);
    let lane = if upstream_path.ends_with("/responses") { Lane::Responses } else { Lane::Chat };

    match forward(state, zen_base_url, upstream_path, &host_body) {
        Ok(Upstream::Stream(reader)) if wants_stream => {
            // 客户端自己要流式：逐块透传（同一套方言，不重编码）。
            let boxed: Box<dyn Read + Send + 'static> = Box::new(CursorPassthrough(reader));
            let mut out = streaming_response(200, boxed);
            if let Ok(header) = Header::from_bytes(&b"Content-Type"[..], &b"text/event-stream"[..]) {
                out = out.with_header(header);
            }
            if let Ok(header) = Header::from_bytes(&b"Cache-Control"[..], &b"no-cache"[..]) {
                out = out.with_header(header);
            }
            let _ = request.respond(out);
        }
        Ok(Upstream::Stream(reader)) => {
            // 客户端要非流式：上游仍是流式（免费通道要求），我们在中间拼回完整 JSON。
            let payload = match lane {
                Lane::Chat => reassemble_chat_sse(reader),
                Lane::Responses => {
                    let model = host_body.get("model").and_then(Value::as_str).unwrap_or_default().to_string();
                    reassemble_responses_sse(reader, &model)
                }
            };
            let _ = request.respond(json_response(200, &payload));
        }
        Ok(Upstream::Whole { status, content_type, body }) => {
            let boxed: Box<dyn Read + Send + 'static> = Box::new(std::io::Cursor::new(body));
            let mut response = streaming_response(status, boxed);
            if let Ok(header) = Header::from_bytes(&b"Content-Type"[..], content_type.as_bytes()) {
                response = response.with_header(header);
            }
            let _ = request.respond(response);
        }
        Err(message) => {
            state.set_error(&message);
            let _ = request.respond(
                json_response(502, &json!({ "error": { "message": format!("上游请求失败：{message}") } })),
            );
        }
    }
}

/// 透传包装：把 Box<dyn Read> 包成 Read + Send + 'static 的具体类型。
struct CursorPassthrough(Box<dyn Read + Send>);
impl Read for CursorPassthrough {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        self.0.read(buf)
    }
}

/// 绑定端口。**只负责绑，不负责 accept**——accept 循环是死循环，混在一起的话
/// 调用方永远拿不到端口，后面的配置同步就全成了死代码。
/// 优先绑固定候选端口，这样写进配置的 baseUrl 才稳定。
/// 把上游的 chat SSE 流拼回一个完整的非流式 chat.completion。
///
/// 免费通道要求请求必须是流式的，但客户端（ZCode 的 WebFetch 等）发来的
/// 可能是非流式请求。此前把流式碎片原样甩回去，客户端按 JSON 解析直接
/// 失败——这就是「所有免费模型的 WebFetch 全挂」的根因。
fn reassemble_chat_sse(reader: Box<dyn Read + Send>) -> Value {
    let mut id = String::new();
    let mut created: i64 = 0;
    let mut model = String::new();
    let mut content = String::new();
    let mut reasoning = String::new();
    let mut finish_reason = String::new();
    let mut usage: Option<Value> = None;

    for line in BufReader::new(reader).lines() {
        let Ok(line) = line else { break };
        let Some(data) = line.strip_prefix("data:").map(str::trim) else { continue };
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        let Ok(chunk) = serde_json::from_str::<Value>(data) else { continue };
        if id.is_empty() {
            id = chunk.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
            created = chunk.get("created").and_then(Value::as_i64).unwrap_or(0);
            model = chunk.get("model").and_then(Value::as_str).unwrap_or_default().to_string();
        }
        if let Some(delta) = chunk.pointer("/choices/0/delta") {
            if let Some(piece) = delta.get("content").and_then(Value::as_str) {
                content.push_str(piece);
            }
            if let Some(piece) = delta.get("reasoning").and_then(Value::as_str) {
                reasoning.push_str(piece);
            }
        }
        if let Some(fr) = chunk.pointer("/choices/0/finish_reason").and_then(Value::as_str) {
            if !fr.is_empty() {
                finish_reason = fr.to_string();
            }
        }
        if let Some(u) = chunk.get("usage").filter(|u| u.is_object()) {
            usage = Some(u.clone());
        }
    }
    // 有的模型把全部输出都放进 reasoning 字段；content 为空时拿它顶上，
    // 否则非流式客户端只会看到一个空回复。
    if content.is_empty() && !reasoning.is_empty() {
        content = reasoning.clone();
    }
    let mut message = json!({ "role": "assistant", "content": content });
    if !reasoning.is_empty() && !content.is_empty() {
        message["reasoning_content"] = Value::String(reasoning);
    }
    let mut out = json!({
        "id": if id.is_empty() { "chatcmpl-proxy".to_string() } else { id },
        "object": "chat.completion",
        "created": if created == 0 { now_secs() } else { created },
        "model": model,
        "choices": [{
            "index": 0,
            "message": message,
            "finish_reason": if finish_reason.is_empty() { "stop" } else { finish_reason.as_str() },
        }],
    });
    if let Some(u) = usage {
        out["usage"] = u;
    }
    out
}

/// 把上游的 responses SSE 流拼回一个完整的 response 对象。
fn reassemble_responses_sse(reader: Box<dyn Read + Send>, model: &str) -> Value {
    let mut text = String::new();
    let mut completed: Option<Value> = None;

    for line in BufReader::new(reader).lines() {
        let Ok(line) = line else { break };
        let Some(data) = line.strip_prefix("data:").map(str::trim) else { continue };
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        let Ok(event) = serde_json::from_str::<Value>(data) else { continue };
        match event.get("type").and_then(Value::as_str) {
            Some("response.output_text.delta") => {
                if let Some(piece) = event.get("delta").and_then(Value::as_str) {
                    text.push_str(piece);
                }
            }
            Some("response.completed") => {
                completed = event.get("response").cloned();
            }
            _ => {}
        }
    }
    if let Some(mut response) = completed {
        // 上游给的是权威完整对象；把拼出来的文本兜底进去（有些上游不发
        // output_text，只发 delta）。
        if let Some(arr) = response.get_mut("output").and_then(Value::as_array_mut) {
            let has_text = arr.iter().any(|item| {
                item.get("content")
                    .and_then(Value::as_array)
                    .map(|parts| {
                        parts.iter().any(|p| p.get("type").and_then(Value::as_str) == Some("output_text"))
                    })
                    .unwrap_or(false)
            });
            if !has_text {
                arr.push(json!({
                    "type": "message",
                    "role": "assistant",
                    "status": "completed",
                    "content": [{ "type": "output_text", "text": text }],
                }));
            }
        }
        return response;
    }
    json!({
        "id": format!("resp_proxy_{}", now_secs()),
        "object": "response",
        "created_at": now_secs(),
        "status": "completed",
        "model": model,
        "output": [{
            "type": "message",
            "role": "assistant",
            "status": "completed",
            "content": [{ "type": "output_text", "text": text }],
        }],
    })
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub fn bind(state: &Arc<State>, candidates: &[u16]) -> Result<(Server, u16), String> {
    let mut last_error = String::new();
    for port in candidates {
        match Server::http(&format!("127.0.0.1:{port}")) {
            Ok(server) => {
                state.set_port(*port);
                println!("[zen] 回环代理已监听 127.0.0.1:{port}");
                return Ok((server, *port));
            }
            Err(e) => last_error = e.to_string(),
        }
    }
    Err(format!("没有可用端口（试过 {:?}）：{last_error}", candidates))
}

/// 在后台线程里跑 accept 循环。
pub fn accept_forever(server: Server, state: Arc<State>, zen_base_url: String) {
    std::thread::spawn(move || {
        for request in server.incoming_requests() {
            // 每个请求一个线程：本地回环、连接数个位数，够用且没有生命周期标注，
            // 比 async 好读。
            let state = Arc::clone(&state);
            let zen_base_url = zen_base_url.clone();
            std::thread::spawn(move || handle_request(request, &state, &zen_base_url));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 非回环来源被拒() {
        assert!(is_loopback_host(Some("127.0.0.1:41930")));
        assert!(is_loopback_host(Some("localhost:41930")));
        assert!(!is_loopback_host(Some("evil.example.com")));
        assert!(!is_loopback_host(None));
    }

    #[test]
    fn origin_缺失时放行_有则必须回环() {
        assert!(is_loopback_origin(None));
        assert!(is_loopback_origin(Some("")));
        assert!(is_loopback_origin(Some("http://127.0.0.1:41930")));
        assert!(!is_loopback_origin(Some("https://evil.example.com")));
    }

    #[test]
    fn 错误信息按状态码分类() {
        assert!(extract_error_message("boom", 403).contains("免费通道门禁"));
        assert!(extract_error_message("boom", 429).contains("限速"));
        assert!(extract_error_message("boom", 500).contains("上游 500"));
        assert!(extract_error_message(r#"{"error":{"message":"Model is unavailable"}}"#, 400)
            .contains("Model is unavailable"));
    }

    #[test]
    fn health_反映当前模型数() {
        let state = State::new();
        state.chat_models.lock().unwrap().extend(["a".into(), "b".into()]);
        let health = build_health(&state);
        assert_eq!(health["chatModels"], 2);
        assert_eq!(health["ok"], true);
    }
}

#[cfg(test)]
mod reassemble_tests {
    use super::*;

    #[test]
    fn chat_sse_拼装_分块到达也能拼全() {
        // 完全复刻 mock 的发送方式：第一块没有换行结尾，第二块补完
        let raw = b"data: {\"choices\":[{\"delta\":{\"content\":\"he";
        let raw2 = b"llo\"}}]}\n\n";
        let raw3 = b"data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"total_tokens\":3}}\n\ndata: [DONE]\n\n";
        let mut all = Vec::new();
        all.extend_from_slice(raw);
        all.extend_from_slice(raw2);
        all.extend_from_slice(raw3);
        let out = reassemble_chat_sse(Box::new(std::io::Cursor::new(all)));
        assert_eq!(out["choices"][0]["message"]["content"], "hello", "内容应拼全: {}", out);
        assert_eq!(out["choices"][0]["finish_reason"], "stop");
        assert_eq!(out["usage"]["total_tokens"], 3);
    }
}
