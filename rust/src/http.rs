//! 出站 HTTP：共用一个 reqwest blocking 客户端。
//!
//! 整个工具是 I/O 密集的回环代理，阻塞式客户端配线程模型完全够用，
//! 换来的是没有 async 运行时、没有生命周期标注，逻辑更直白也更不容易写错。

use std::time::Duration;

use reqwest::blocking::Client;
use serde_json::Value;

pub fn client() -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .pool_idle_timeout(Duration::from_secs(90))
        .user_agent("opencode2zcode")
        .build()
        .map_err(|e| e.to_string())
}

/// GET 一个 JSON，带超时；失败返回 Err，调用方决定怎么记 lastError。
pub fn get_json(url: &str, timeout_ms: u64) -> Result<Value, String> {
    let client = client()?;
    client
        .get(url)
        .timeout(Duration::from_millis(timeout_ms))
        .send()
        .and_then(|r| r.json::<Value>())
        .map_err(|e| e.to_string())
}

/// 极简回环健康探测：**不碰 reqwest**。
///
/// 每次 new 一个 reqwest Client 都要重新装载系统根证书（Windows 上是几百
/// 毫秒到数秒），而钩子的探测每 300ms 调一次、每次轮询 4 个端口——用 TLS
/// 客户端探测一个 127.0.0.1 的进程，开销大到能把启动钩子拖满 6 秒。
/// 这里直接开裸 TCP 发一个 GET，够用且是毫秒级。
pub fn probe_loopback(port: u16, timeout_ms: u64) -> bool {
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpStream};
    use std::time::Duration;

    let address: SocketAddr = ([127, 0, 0, 1], port).into();
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(timeout_ms)) else {
        return false;
    };
    stream.set_read_timeout(Some(Duration::from_millis(timeout_ms))).ok();
    stream.set_write_timeout(Some(Duration::from_millis(timeout_ms))).ok();
    let request = format!(
        "GET /healthz HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut response = Vec::new();
    // 只读到能判断出状态码为止，不必等整个 body。
    let _ = stream.take(4096).read_to_end(&mut response);
    let text = String::from_utf8_lossy(&response);
    text.starts_with("HTTP/1.1 200") || text.starts_with("HTTP/1.0 200")
}
