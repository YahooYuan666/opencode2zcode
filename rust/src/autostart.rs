//! 随 ZCode 自动启动：装 / 卸 `SessionStart` 钩子，以及钩子触发的静默拉起。

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

use crate::http;

const HOOK_TIMEOUT_MS: u64 = 12_000;
/// 认领钩子用的可执行文件名。**刻意包含已废弃的 ensure-proxy.mjs / install.mjs**
/// ——早几版装过的人配置里留着指向它们的钩子，那些文件早没了。不把旧名字列进来，
/// 它们会被当成「别人的钩子」永远留着，而那条钩子每次开 ZCode 都会去跑一个
/// 不存在的文件。列进来是为了让重装/卸载能顺手清理掉。
const HOOK_BASENAMES: [&str; 4] = ["opencode2zcode.exe", "ensure-proxy.mjs", "install.mjs", "zen-proxy.mjs"];
/// exe 形态的标记参数，源码形态用 `--ensure`。
pub const HOOK_MARKER_ARG: &str = "opencode2zcode-hook";
pub const PROXY_LOCK_FILE: &str = ".proxy-start.lock";

pub const ENSURE_TIMEOUT_MS: u64 = 6_000;
const LOCK_STALE_SECONDS: u64 = 20;

pub fn zcode_cli_config_path() -> PathBuf {
    crate::detect::home_dir().join(".zcode").join("cli").join("config.json")
}

fn read_json_safe(file: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(file).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_json_with_backup(file: &Path, value: &Value) -> std::io::Result<()> {
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if file.exists() {
        let stamp = crate::zcode::backup_stamp();
        let name = file.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let _ = std::fs::copy(file, file.with_file_name(format!("{name}.bak-{stamp}")));
    }
    let temporary = file.with_file_name(format!("{}.{}.tmp", file.display(), std::process::id()));
    std::fs::write(&temporary, format!("{}\n", serde_json::to_string_pretty(value).unwrap_or_default()))?;
    std::fs::rename(&temporary, file)
}

fn hook_args_of(entry: &Value) -> Vec<String> {
    entry
        .get("hooks")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|h| h.get("args").and_then(Value::as_array))
                .flatten()
                .filter_map(|a| a.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

fn basename_lower(value: &str) -> String {
    Path::new(value)
        .file_name()
        .map(|n| n.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

pub fn is_our_hook(entry: &Value) -> bool {
    hook_args_of(entry)
        .iter()
        .any(|arg| arg == HOOK_MARKER_ARG || HOOK_BASENAMES.contains(&basename_lower(arg).as_str()))
}

/// 钩子指向的东西还在不在。不在就是条死钩子，装的时候顺手清掉。
fn hook_target_exists(entry: &Value) -> bool {
    for arg in hook_args_of(entry) {
        if arg == HOOK_MARKER_ARG {
            continue;
        }
        if HOOK_BASENAMES.contains(&basename_lower(&arg).as_str()) {
            return Path::new(&arg).exists();
        }
    }
    true
}

/// 写进 ZCode 配置的路径要好看也要稳。Windows 有时会把 exe 路径缩成
/// 8.3 短名（C:\Users\ADMINI~1\…），那种路径在目录被重建后就失效，
/// 所以先用 canonicalize 换成长路径。
///
/// 但 canonicalize 会带上 `\\?\` 扩展长度前缀。那个前缀写进配置是有害的：
/// 别的工具按字符串比对路径时对不上，有些程序干脆不认这种写法，要摘掉。
fn stable_exe_path() -> PathBuf {
    let raw = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("opencode2zcode.exe"));
    let resolved = std::fs::canonicalize(&raw).unwrap_or(raw);
    let text = resolved.to_string_lossy().to_string();
    const VERBATIM: &str = r"\\?\";
    const VERBATIM_UNC: &str = r"\\?\UNC\";
    let stripped = if let Some(rest) = text.strip_prefix(VERBATIM_UNC) {
        format!(r"\\{rest}")
    } else {
        text.strip_prefix(VERBATIM).unwrap_or(&text).to_string()
    };
    PathBuf::from(stripped)
}

/// exe 形态下钩子直接跑 exe；源码形态跑 `node zen-proxy.mjs --ensure`。
pub fn hook_invocation() -> (String, Vec<String>) {
    if std::env::args().next().map(|a| basename_lower(&a).contains(".exe")).unwrap_or(false)
        || basename_lower(&std::env::current_exe().unwrap_or_default().to_string_lossy()).contains(".exe")
    {
        return (
            stable_exe_path().display().to_string(),
            vec![HOOK_MARKER_ARG.to_string()],
        );
    }
    let script = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("zen-proxy.mjs"));
    let node = std::env::var("NODE").unwrap_or_else(|_| "node".into());
    (node, vec![script.display().to_string(), "--ensure".to_string()])
}

pub fn install_autostart() {
    let config_path = zcode_cli_config_path();
    let mut config = read_json_safe(&config_path).unwrap_or_else(|| json!({}));

    if !config.get("hooks").map(|h| h.is_object()).unwrap_or(false) {
        config["hooks"] = json!({});
    }
    config["hooks"]["enabled"] = Value::Bool(true);
    if !config["hooks"]
        .get("events")
        .map(|e| e.is_object())
        .unwrap_or(false)
    {
        config["hooks"]["events"] = json!({});
    }

    let existing: Vec<Value> = config["hooks"]["events"]
        .get("SessionStart")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let (command, args) = hook_invocation();

    let entry = json!({
        "hooks": [{
            "type": "process",
            "command": command,
            "args": args,
            "timeoutMs": HOOK_TIMEOUT_MS,
        }]
    });

    // 别人的钩子原样留下；我们自己那条永远只留一条，且永远指向当前这个程序。
    let mut foreign: Vec<Value> = Vec::new();
    let mut stale = 0usize;
    for item in existing {
        if is_our_hook(&item) {
            if !hook_target_exists(&item) {
                stale += 1;
            }
        } else {
            foreign.push(item);
        }
    }

    let mut session_start = vec![entry];
    session_start.extend(foreign);
    config["hooks"]["events"]["SessionStart"] = Value::Array(session_start);

    if let Err(e) = write_json_with_backup(&config_path, &config) {
        eprintln!("[autostart] 写配置失败：{e}");
        return;
    }
    if stale > 0 {
        println!("[autostart] 清掉了 {stale} 条指向已不存在位置的旧钩子。");
    }
    println!("[autostart] 已写入 SessionStart 钩子：{}", config_path.display());
    let (command, args) = hook_invocation();
    println!("[autostart] 钩子命令：{command} {}", args.join(" "));
    println!("[autostart] 从现在起，启动 ZCode 会自动静默拉起代理，不用再双击任何东西。");
    println!("[autostart] 注意：上面这个路径是写死的。以后若移动或改名了，");
    println!("[autostart]        到新位置重跑一次 --install 即可（旧的会被自动替换）。");
}

pub fn uninstall_autostart() {
    let config_path = zcode_cli_config_path();
    let Some(mut config) = read_json_safe(&config_path) else {
        println!("[autostart] 读不到 ZCode 配置，无需卸载。");
        return;
    };
    let Some(existing) = config
        .pointer("/hooks/events/SessionStart")
        .and_then(Value::as_array)
        .cloned()
    else {
        println!("[autostart] 配置里没有 SessionStart 钩子，无需卸载。");
        return;
    };

    let kept: Vec<Value> = existing.iter().filter(|e| !is_our_hook(e)).cloned().collect();
    let removed = existing.len() - kept.len();
    if removed == 0 {
        println!("[autostart] 没有属于 opencode2zcode 的钩子（别人的钩子一个没动）。");
        return;
    }

    let events = config["hooks"]["events"].as_object_mut().unwrap();
    if kept.is_empty() {
        events.remove("SessionStart");
    } else {
        events.insert("SessionStart".into(), Value::Array(kept));
    }
    // 事件清空后剩下的 hooks.enabled 只是个空开关，装之前没有就整个撤掉。
    if events.is_empty() {
        config["hooks"].as_object_mut().unwrap().remove("events");
    }
    if config["hooks"].as_object().map(|h| h.is_empty()).unwrap_or(false) {
        config.as_object_mut().unwrap().remove("hooks");
    }

    if let Err(e) = write_json_with_backup(&config_path, &config) {
        eprintln!("[autostart] 写配置失败：{e}");
        return;
    }
    println!("[autostart] 已移除 {removed} 条自启钩子：{}", config_path.display());
    println!("[autostart] 其它 mcp / plugins / hooks 配置保持原样。");
}

// ---------------------------------------------------------------------------
// 静默拉起
// ---------------------------------------------------------------------------

fn sleep(ms: u64) {
    std::thread::sleep(std::time::Duration::from_millis(ms));
}

/// 探测用的连接超时。这个值**必须短**：在装有防火墙 / 虚拟网卡过滤驱动的
/// Windows 上，连一个没在监听的回环端口不会立刻返回「连接被拒绝」，而是
/// 安静地耗满整个超时。500ms × 4 个候选端口顺序探测 = 2 秒，足以把 ZCode
/// 的启动钩子拖到超时。有进程在监听时 connect 是瞬时的，短超时完全够用。
const PROBE_TIMEOUT_MS: u64 = 150;

pub fn probe_port(port: u16) -> bool {
    http::probe_loopback(port, PROBE_TIMEOUT_MS)
}

/// 并发探测所有候选端口。串行的最坏情况是「超时 × 端口数」，而钩子每秒
/// 都会走到这里，串起来足以让会话启动明显变慢。
pub fn any_proxy_alive(ports: &[u16]) -> bool {
    let (tx, rx) = std::sync::mpsc::channel();
    let mut spawned = 0usize;
    for port in ports {
        let tx = tx.clone();
        let port = *port;
        spawned += 1;
        std::thread::spawn(move || {
            let alive = probe_port(port);
            let _ = tx.send(alive);
        });
    }
    drop(tx);
    let mut alive = false;
    for _ in 0..spawned {
        if rx.recv().unwrap_or(false) {
            alive = true;
        }
    }
    alive
}

fn lock_is_stale(lock_file: &Path) -> bool {
    std::fs::metadata(lock_file)
        .and_then(|m| m.modified())
        .map(|t| {
            t.elapsed()
                .map(|d| d.as_secs() >= LOCK_STALE_SECONDS)
                .unwrap_or(true)
        })
        .unwrap_or(true)
}

fn acquire_lock(lock_file: &Path) -> bool {
    for _ in 0..2 {
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(lock_file)
        {
            Ok(_) => return true,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                if lock_is_stale(lock_file) {
                    // 陈锁：上一次拉起过程崩了留下的，清掉重抢。
                    let _ = std::fs::remove_file(lock_file);
                    continue;
                }
                return false;
            }
            Err(_) => return false,
        }
    }
    false
}

fn release_lock(lock_file: &Path) {
    let _ = std::fs::remove_file(lock_file);
}

/// 把本程序以「彻底脱离、无窗口」的方式再拉起一份（不带标记参数，进去就是服务模式）。
fn spawn_self_detached() -> std::io::Result<()> {
    let mut command = if std::env::args().next().map(|a| a.to_lowercase().ends_with(".exe")).unwrap_or(false) {
        let mut c = std::process::Command::new(stable_exe_path());
        c.current_dir(crate::script_dir());
        c
    } else {
        let script = std::env::args().nth(1).unwrap_or_else(|| "zen-proxy.mjs".into());
        let node = std::env::var("NODE").unwrap_or_else(|_| "node".into());
        let mut c = std::process::Command::new(node);
        c.arg(script).current_dir(crate::script_dir());
        c
    };
    // CREATE_NO_WINDOW：不要因父进程有控制台就弹出黑窗口。
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map(|_| ())
}

/**
 * ZCode 一启动就检查代理在不在，不在就静默拉起。
 *
 * 几条被 ZCode 钩子契约逼出来的硬约束：
 *   - 钩子**永远同步执行**，`async: true` 不生效。所以本函数自己负责
 *     「快速判断 → 需要时才等一小会儿 → 无论如何都退出 0」。
 *   - 绝不能 block 或 deny 会话：任何异常都吞掉。
 *   - 子进程用 CREATE_NO_WINDOW 拉起，用户不会看见任何窗口。
 *   - 单实例保护：并发启动多个 ZCode 会话时只允许一个真正拉起。否则第二个实例
 *     会绑到 41931 并把配置里的 baseUrl 改掉，用户会突然发现模型不能用。
 */
pub fn ensure_proxy_running(ports: &[u16], script_dir: &std::path::Path) {
    let lock_file = script_dir.join(PROXY_LOCK_FILE);
    if any_proxy_alive(ports) {
        return;
    }

    if !acquire_lock(&lock_file) {
        // 别的实例正在拉起，等它一下就到点了。
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(ENSURE_TIMEOUT_MS);
        while std::time::Instant::now() < deadline {
            sleep(400);
            if any_proxy_alive(ports) {
                return;
            }
        }
        return;
    }

    // 拿到锁之后再确认一次：可能正好在等锁期间别人已经拉起来了。
    if any_proxy_alive(ports) {
        release_lock(&lock_file);
        return;
    }
    let _ = spawn_self_detached();
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(ENSURE_TIMEOUT_MS);
    while std::time::Instant::now() < deadline {
        sleep(300);
        if any_proxy_alive(ports) {
            break;
        }
    }
    release_lock(&lock_file);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 认得出各种形态的自家钩子() {
        let exe = json!({"hooks":[{"args":["D:\\a\\opencode2zcode.exe","opencode2zcode-hook"]}]});
        assert!(is_our_hook(&exe));
        let legacy_ensure = json!({"hooks":[{"args":["D:\\a\\ensure-proxy.mjs"]}]});
        assert!(is_our_hook(&legacy_ensure), "废弃的旧钩子也要能认出来好清理");
        let legacy_install = json!({"hooks":[{"args":["node","D:\\a\\install.mjs"]}]});
        assert!(is_our_hook(&legacy_install));
        let foreign = json!({"hooks":[{"args":["node","D:\\other\\thing.mjs"]}]});
        assert!(!is_our_hook(&foreign), "别人的钩子不能被误认");
    }

    #[test]
    fn 指向已删文件的旧钩子判定为失效() {
        let dead = json!({"hooks":[{"args":["D:\\definitely\\not\\here\\ensure-proxy.mjs"]}]});
        assert!(is_our_hook(&dead));
        assert!(!hook_target_exists(&dead), "目标不存在应判定为死钩子");
        let alive = json!({"hooks":[{"args":[std::env::current_exe().unwrap().display().to_string()]}]});
        assert!(hook_target_exists(&alive), "自身应判定为存在");
    }

    #[test]
    fn 标记参数也算自家() {
        let marker = json!({"hooks":[{"args":["opencode2zcode-hook"]}]});
        assert!(is_our_hook(&marker));
    }
}
