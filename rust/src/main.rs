//! opencode2zcode —— 把 OpenCode Zen 的匿名免费模型接进 ZCode。
//!
//! 为什么不是 ZCode 插件：`.zcode-plugin/plugin.json` 只能贡献
//! skills / commands / hooks / mcpServers，既没有宿主静态声明 provider 的
//! 能力，也没有常驻回环服务。所以改成 ZCode 官方支持的那条路：本进程跑回环
//! 代理，并把 provider 声明写进 ZCode 的「个人 Provider 配置」
//! `{数据根}/.zcode/v2/provider_config.json`。ZCode 对该文件每 1 秒轮询一次，
//! 改完热生效，不用重启。
//!
//! 移植自 JasonYu0822/opencode2pi-desktop 的 lib/zen.js + main.js（MIT）。
//! 有意不移植：IP 池 / 代理轮换子系统、Go sidecar。

mod autostart;
mod catalog;
mod detect;
mod http;
mod proxy;
mod zen;
mod zcode;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;

/// 上游根地址；可用 ZEN_BASE_URL 覆盖（指向自建网关或本地 mock 便于自测）。
fn zen_base_url() -> String {
    std::env::var("ZEN_BASE_URL")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "https://opencode.ai/zen".to_string())
        .trim_end_matches('/')
        .to_string()
}

const METADATA_URL: &str = "https://models.dev/api.json";
const DEFAULT_PORT: u16 = 41930;
const PORT_CANDIDATES: [u16; 4] = [DEFAULT_PORT, 41931, 41932, 41933];
const CACHE_FILE_NAME: &str = "opencode2zcode-catalog.json";
const CATALOG_REFRESH: Duration = Duration::from_secs(300);

pub fn script_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."))
}

const HELP: &str = "opencode2zcode — 把 OpenCode Zen 匿名免费模型接进 ZCode

用法：
  opencode2zcode                     起代理并写入/更新 ZCode 个人 Provider 配置
  opencode2zcode --install           装上「随 ZCode 自动启动」（幂等，推荐）
  opencode2zcode --uninstall         卸掉自启钩子并摘掉本工具的 Provider
  opencode2zcode --ensure            检查代理在不在，不在就静默拉起（供钩子调用）
  opencode2zcode --detect            只列出候选数据目录与判据，确认写到哪儿
  opencode2zcode --print-config      只打印将要写入的配置（不落盘、不起服务）
  opencode2zcode --write-config-only 只写配置后退出
  opencode2zcode --remove-provider   只从 ZCode 配置里摘掉本工具的两个 Provider
  opencode2zcode --port 41930        指定回环端口
  opencode2zcode --config <path>     直接指定 provider_config.json 完整路径
  opencode2zcode --with-responses    连 responses 道那一组也写进配置（默认不写，见下）

装完就不用再管了：启动 ZCode 时会自动静默拉起代理，不会有任何窗口。

为什么没有 responses 道那一组：OpenCode 的 /v1/responses 通道对外部调用一律
拒绝（403「免费档只允许在 OpenCode 内部使用」），是上游 provider 的限制，
伪造请求头过不去。默认只暴露确实能用的 chat 道（7 个模型）。上游哪天放开
了，加 --with-responses 就能把它加回来。

配置落点按这个顺序决定：
  --config  >  ZCODE_DATA_BASE_DIR 环境变量  >  自动探测  >  旁路文件  >  用户主目录

自动探测的判据是 {数据根}/.zcode/v2/runtime 是否存在（ZCode 准备运行资源时会建它），
并会扫各固定盘的盘根与盘根下一层目录——因为这个包要能在别人的电脑上直接用。

诊断：curl http://127.0.0.1:41930/healthz";

#[derive(Debug, PartialEq, Eq)]
enum Mode {
    Serve,
    Install,
    Uninstall,
    Ensure,
    Detect,
    Print,
    Write,
    Remove,
    Help,
}

struct Options {
    port: Option<u16>,
    config_path: Option<String>,
    mode: Mode,
    /// 是否把 responses 道那一组也写进配置。默认**否**——那条道现在 100% 调不通，
    /// 写进去只是让模型选择器里多一个点下去必报错的分组。详见 RESPONSES_LANE_NOTE。
    with_responses: bool,
}

fn parse_args() -> Result<Options, String> {
    let mut options = Options { port: None, config_path: None, mode: Mode::Serve, with_responses: false };
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--port" => {
                i += 1;
                let raw = args.get(i).ok_or_else(|| "--port 需要一个端口号".to_string())?;
                options.port = Some(
                    raw.parse::<u16>()
                        .map_err(|_| format!("--port 需要一个端口号，收到 {raw}"))?,
                );
            }
            "--config" => {
                i += 1;
                options.config_path = args.get(i).cloned();
            }
            "--print-config" => options.mode = Mode::Print,
            "--write-config-only" => options.mode = Mode::Write,
            "--remove-provider" => options.mode = Mode::Remove,
            "--install" => options.mode = Mode::Install,
            "--uninstall" => options.mode = Mode::Uninstall,
            "--with-responses" => options.with_responses = true,
            arg if arg == autostart::HOOK_MARKER_ARG || arg == "--ensure" => options.mode = Mode::Ensure,
            "--detect" => options.mode = Mode::Detect,
            "--help" | "-h" => options.mode = Mode::Help,
            other => return Err(format!("未知参数：{other}")),
        }
        i += 1;
    }
    Ok(options)
}

/// 把当前目录暴露的模型同步进 ZCode 配置。
fn apply_catalog(
    catalog: &catalog::ModelCatalog,
    state: &Arc<proxy::State>,
    port: u16,
    config_path: &Path,
    with_responses: bool,
) {
    let chat = zcode::chat_model_entries(catalog);
    let responses = if with_responses {
        zcode::responses_model_entries(catalog)
    } else {
        Vec::new()
    };
    *state.chat_models.lock().unwrap() = chat.iter().map(|m| m.id.clone()).collect();
    *state.responses_models.lock().unwrap() = responses.iter().map(|m| m.id.clone()).collect();
    *state.catalog_status.lock().unwrap() = serde_json::to_value(catalog.snapshot()).unwrap_or(json!({}));

    let existing = zcode::read_existing_config(config_path);
    let config = zcode::build_zcode_config(existing.as_ref(), port, &chat, &responses);
    let serialized = serde_json::to_string(&config).unwrap_or_default();
    // 目录内容真实变化时才重写，避免每 5 分钟白写一次。
    {
        let mut last = state.last_written.lock().unwrap();
        if *last == serialized {
            return;
        }
        *last = serialized;
    }
    if let Err(e) = zcode::write_zcode_config(config_path, &config) {
        eprintln!("[zen] 写配置失败：{e}");
    }
}

fn main() {
    let options = match parse_args() {
        Ok(o) => o,
        Err(e) => {
            eprintln!("{e}\n\n{HELP}");
            std::process::exit(1);
        }
    };

    let dir = script_dir();
    let base = zen_base_url();

    match options.mode {
        Mode::Help => {
            println!("{HELP}");
            return;
        }
        Mode::Ensure => {
            // 钩子专用路径：必须在任何目录探测、任何配置读写之前短路返回，
            // 而且无论成功失败退出码恒为 0，绝不能影响 ZCode 开会话。
            autostart::ensure_proxy_running(&PORT_CANDIDATES, &dir);
            // 直接退出而不是 return：钩子路径上没有需要析构的东西，走
            // process::exit 既跳过运行库收尾，也把「退出码恒为 0」写死。
            std::process::exit(0);
        }
        Mode::Install => {
            autostart::install_autostart();
            return;
        }
        Mode::Uninstall => {
            autostart::uninstall_autostart();
            let resolved = detect::resolve_config_target(&dir, options.config_path.as_deref());
            match zcode::remove_our_providers(zcode::read_existing_config(&resolved.config_path).as_ref()) {
                Some((removed, cleaned)) if removed > 0 => {
                    if let Err(e) = zcode::write_zcode_config(&resolved.config_path, &cleaned) {
                        eprintln!("[zen] 写配置失败：{e}");
                        return;
                    }
                    println!(
                        "[zen] 已从 {} 移除 {removed} 个 Provider（{} / {}）",
                        resolved.config_path.display(),
                        zcode::PROVIDER_ID,
                        zcode::RESPONSES_PROVIDER_ID
                    );
                    println!("[zen] 你的其它 Provider 原样保留。");
                }
                _ => println!("[zen] 配置里没有本工具的 Provider，无需清理。"),
            }
            return;
        }
        Mode::Detect => {
            detect::print_detection(&dir);
            return;
        }
        _ => {}
    }

    let resolved = detect::resolve_config_target(&dir, options.config_path.as_deref());
    let config_path = resolved.config_path.clone();
    let cache_path = config_path.parent().map(|p| p.join(CACHE_FILE_NAME));
    detect::warn_about_config_target(&resolved);

    // 确认过的数据目录记进旁路文件，之后从资源管理器双击也能找对地方。
    if !matches!(resolved.source, detect::Source::Explicit) {
        if let Some(detail) = &resolved.detail {
            if detail.score >= 4 {
                detect::write_sidecar(&dir, &detail.base_dir.to_string_lossy());
            }
        }
    }
    // 走 stderr 不是 stdout：--print-config 承诺 stdout 只有 JSON（「代理日志走
    // stderr，--print-config 的 JSON 走 stdout，方便重定向」），这行要是也进
    // stdout，输出就没法直接管道给 jq 之类了。
    eprintln!("[zen] 配置目标（{}）：{}", resolved.source.label(), config_path.display());

    let state = Arc::new(proxy::State::new());
    let mut catalog = catalog::ModelCatalog::new(cache_path);

    let requested_port = options.port.unwrap_or(DEFAULT_PORT);

    // 服务模式先绑端口：绑端口是毫秒级，拉目录要等网络。让 ZCode 的启动钩子
    // 等目录刷新完是不合理的——钩子超时会拖累整个会话启动。端口先开、目录
    // 后填，/healthz 一开始就应答（status=pending），几秒内自动补齐。
    // 一次性命令（--print-config / --write-config-only）不需要监听，直接往下走。
    let candidates: Vec<u16> = match options.port {
        Some(p) => {
            let mut list = vec![p];
            list.extend(PORT_CANDIDATES.into_iter().filter(|c| *c != p));
            list
        }
        None => PORT_CANDIDATES.to_vec(),
    };
    let bound_port = if options.mode == Mode::Serve {
        let (server, port) = match proxy::bind(&state, &candidates) {
            Ok(pair) => pair,
            Err(e) => {
                eprintln!("[zen] 起服务失败：{e}");
                std::process::exit(1);
            }
        };
        proxy::accept_forever(server, Arc::clone(&state), base.clone());
        Some(port)
    } else {
        None
    };

    // 写配置前先读盘播种，离机启动也能写出真实清单（而不是缩水的静态兜底）。
    catalog.prime(&base);

    if options.mode == Mode::Print {
        let chat = zcode::chat_model_entries(&catalog);
        let responses = if options.with_responses {
            zcode::responses_model_entries(&catalog)
        } else {
            Vec::new()
        };
        let existing = zcode::read_existing_config(&config_path);
        let config = zcode::build_zcode_config(existing.as_ref(), requested_port, &chat, &responses);
        eprintln!("# 目标文件：{}", config_path.display());
        eprintln!("# 下面所有 apiKey 已脱敏；此模式不落盘、不起服务。");
        println!("{}", serde_json::to_string_pretty(&zcode::redact_secrets(&config)).unwrap_or_default());
        return;
    }

    if options.mode == Mode::Remove {
        match zcode::remove_our_providers(zcode::read_existing_config(&config_path).as_ref()) {
            Some((removed, cleaned)) if removed > 0 => {
                if let Err(e) = zcode::write_zcode_config(&config_path, &cleaned) {
                    eprintln!("[zen] 写配置失败：{e}");
                    return;
                }
                println!("[zen] 已从 {} 移除 {removed} 个 Provider", config_path.display());
                println!("[zen] 你的其它 Provider 原样保留。");
            }
            _ => println!("[zen] 配置里没有本工具的 Provider，无需清理。"),
        }
        return;
    }

    if options.mode == Mode::Write {
        apply_catalog(&catalog, &state, requested_port, &config_path, options.with_responses);
        println!("已写入 {}", config_path.display());
        println!(
            "chat {} 个模型 / responses {} 个模型",
            state.chat_models.lock().unwrap().len(),
            state.responses_models.lock().unwrap().len()
        );
        return;
    }

    let port = bound_port.unwrap_or(requested_port);
    apply_catalog(&catalog, &state, port, &config_path, options.with_responses);
    println!("[zen] 已同步 ZCode 配置：{}", config_path.display());
    println!(
        "[zen] chat {} 个 / responses {} 个模型",
        state.chat_models.lock().unwrap().len(),
        state.responses_models.lock().unwrap().len()
    );

    // 目录刷新循环：每 5 分钟一次，只在暴露清单真的变了时重写配置。
    let refresh_state = Arc::clone(&state);
    let refresh_path = config_path.clone();
    let refresh_base = base.clone();
    let refresh_with_responses = options.with_responses;
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(CATALOG_REFRESH);
            let mut next = catalog::ModelCatalog::new(None);
            if next.refresh_once(&refresh_base) {
                apply_catalog(&next, &refresh_state, port, &refresh_path, refresh_with_responses);
            }
        }
    });

    loop {
        std::thread::sleep(Duration::from_secs(3600));
    }
}
