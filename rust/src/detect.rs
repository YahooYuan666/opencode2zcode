//! 定位 ZCode 的数据目录。
//!
//! 麻烦点在于 `ZCODE_DATA_BASE_DIR` **不是持久环境变量**——注册表里没有，
//! 只是 ZCode 启动自己子进程时注入的。从资源管理器双击启动器拿不到它，
//! 于是会静默落到用户主目录，而 ZCode 读的是另一个目录，设置里就不出现分组。
//! 所以这里改为主动探测：给若干「可能是 ZCode 数据根」的候选打分。

use std::path::{Path, PathBuf};

const SIDECAR_FILE_NAME: &str = "zcode-data-dir.txt";
const APP_CONFIG_FILE_NAME: &str = "provider_config.json";

#[derive(Clone, Debug)]
pub struct Candidate {
    pub root: PathBuf,
    pub base_dir: PathBuf,
    pub app_config_dir: PathBuf,
    pub score: i32,
    pub evidence: Vec<String>,
    pub newest_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Source {
    Explicit,
    Env,
    Detected,
    Sidecar,
    Homedir,
}

impl Source {
    pub fn label(&self) -> &'static str {
        match self {
            Source::Explicit => "手动指定",
            Source::Env => "环境变量 ZCODE_DATA_BASE_DIR",
            Source::Detected => "自动探测",
            Source::Sidecar => "上次探测记录",
            Source::Homedir => "用户主目录兜底",
        }
    }
}

#[derive(Clone, Debug)]
pub struct Resolved {
    pub config_path: PathBuf,
    pub source: Source,
    pub detail: Option<Candidate>,
}

pub fn sidecar_path(script_dir: &Path) -> PathBuf {
    script_dir.join(SIDECAR_FILE_NAME)
}

pub fn write_sidecar(script_dir: &Path, base_dir: &str) {
    let target = sidecar_path(script_dir);
    if let Ok(existing) = std::fs::read_to_string(&target) {
        if existing.trim() == base_dir {
            return;
        }
    }
    // 脚本目录可能只读；写不进去不影响本次运行。
    let _ = std::fs::write(target, format!("{base_dir}\n"));
}

pub fn read_sidecar(script_dir: &Path) -> Option<String> {
    let value = std::fs::read_to_string(sidecar_path(script_dir)).ok()?;
    let trimmed = value.trim().to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

fn env_base() -> Option<String> {
    std::env::var("ZCODE_DATA_BASE_DIR")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

pub fn home_dir() -> PathBuf {
    std::env::var("USERPROFILE")
        .ok()
        .map(PathBuf::from)
        .or_else(|| std::env::var("HOME").ok().map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("."))
}

/// 候选 .zcode 根：环境变量、用户主目录，再扫各固定盘的盘根与盘根下一层目录。
pub fn candidate_zcode_roots() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let mut push = |value: PathBuf, out: &mut Vec<PathBuf>| {
        let resolved = value.clone();
        if !out.contains(&resolved) {
            out.push(resolved);
        }
    };

    if let Some(base) = env_base() {
        push(PathBuf::from(base).join(".zcode"), &mut out);
    }
    push(home_dir().join(".zcode"), &mut out);

    // 扫各固定盘：盘根、以及盘根下一层目录。够覆盖 ZCODE_DATA_BASE_DIR 被改到
    // 别的盘/别的目录的情况，成本也就是几百次 exists。
    const CAP: usize = 500;
    for letter in "CDEFGHIJKLMNOPQRSTUVWXYZ".chars() {
        if out.len() >= CAP {
            break;
        }
        let root = format!("{letter}:\\");
        let Ok(entries) = std::fs::read_dir(&root) else {
            continue; // 盘不存在或不可读
        };
        push(PathBuf::from(&root).join(".zcode"), &mut out);
        for entry in entries.flatten() {
            if out.len() >= CAP {
                break;
            }
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            if let Some(name) = entry.file_name().to_str() {
                push(PathBuf::from(&root).join(name).join(".zcode"), &mut out);
            }
        }
    }
    out
}

fn mtime_ms(path: &Path) -> Option<u64> {
    std::fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
}

/// 给一个候选 .zcode 根打分；runtime 是最强信号。
pub fn score_zcode_root(root: &Path) -> Candidate {
    let app_config_dir = root.join("v2");
    let mut score = 0;
    let mut evidence = Vec::new();
    if app_config_dir.join("runtime").exists() {
        score += 4;
        evidence.push("v2/runtime".into());
    }
    if app_config_dir.join(APP_CONFIG_FILE_NAME).exists() {
        score += 2;
        evidence.push("v2/provider_config.json".into());
    }
    let mut newest = 0u64;
    for name in ["tasks-index.sqlite", "setting.json", "config.json"] {
        if let Some(ms) = mtime_ms(&app_config_dir.join(name)) {
            newest = newest.max(ms);
        }
    }
    if newest > 0 {
        evidence.push(format!("v2 最近写入 {}", iso_or_raw(newest)));
    }
    Candidate {
        base_dir: root.parent().unwrap_or(root).to_path_buf(),
        root: root.to_path_buf(),
        app_config_dir,
        score,
        evidence,
        newest_ms: newest,
    }
}

fn iso_or_raw(ms: u64) -> String {
    // 不引入 chrono：直接给毫秒时间戳也够排错用。
    format!("{ms}")
}

pub fn rank_zcode_roots() -> Vec<Candidate> {
    let mut ranked: Vec<Candidate> = candidate_zcode_roots().iter().map(|p| score_zcode_root(p)).collect();
    ranked.sort_by(|a, b| b.score.cmp(&a.score).then(b.newest_ms.cmp(&a.newest_ms)));
    ranked
}

fn detect_zcode_data_dir() -> Option<Candidate> {
    rank_zcode_roots().into_iter().find(|c| c.score >= 4)
}

/// 决定配置写到哪里：显式 --config > 环境变量 > 探测 > 旁路文件 > 用户主目录。
pub fn resolve_config_target(script_dir: &Path, explicit: Option<&str>) -> Resolved {
    if let Some(path) = explicit {
        return Resolved {
            config_path: PathBuf::from(path),
            source: Source::Explicit,
            detail: None,
        };
    }

    if let Some(base) = env_base() {
        let root = PathBuf::from(base).join(".zcode");
        let detail = score_zcode_root(&root);
        return Resolved {
            config_path: detail.app_config_dir.join(APP_CONFIG_FILE_NAME),
            source: Source::Env,
            detail: Some(detail),
        };
    }

    if let Some(found) = detect_zcode_data_dir() {
        return Resolved {
            config_path: found.app_config_dir.join(APP_CONFIG_FILE_NAME),
            source: Source::Detected,
            detail: Some(found),
        };
    }

    // 旁路文件只在探测失败时兜底，而且同样要过 runtime 校验——否则把这个包连同
    // 旁路文件一起拷到别的电脑，会照着旧的机器路径去写。
    if let Some(sidecar_base) = read_sidecar(script_dir) {
        let root = PathBuf::from(sidecar_base).join(".zcode");
        let detail = score_zcode_root(&root);
        if detail.score >= 4 {
            return Resolved {
                config_path: detail.app_config_dir.join(APP_CONFIG_FILE_NAME),
                source: Source::Sidecar,
                detail: Some(detail),
            };
        }
    }

    Resolved {
        config_path: home_dir().join(".zcode").join("v2").join(APP_CONFIG_FILE_NAME),
        source: Source::Homedir,
        detail: None,
    }
}

/// 落到可疑目录时大声报警——这个坑一旦踩中，设置里就是不出现模型分组，很难猜。
pub fn warn_about_config_target(resolved: &Resolved) {
    if resolved.source == Source::Explicit {
        return;
    }
    if resolved.detail.as_ref().map(|d| d.score >= 4).unwrap_or(false) {
        return;
    }
    eprintln!("[zen] 警告：没能确认 ZCode 正在使用的数据目录。");
    eprintln!("[zen]       本次会写到：{}", resolved.config_path.display());
    eprintln!("[zen]       如果 ZCode 读的不是这里，设置里就不会出现「OpenCode 免费模型」。");
    eprintln!("[zen]       跑 `opencode2zcode --detect` 看候选目录明细；");
    eprintln!("[zen]       或用 --config <完整路径> 直接指定 provider_config.json。");
}

/// --detect：把候选目录和判据全列出来，方便在别人电脑上确认。
pub fn print_detection(script_dir: &Path) {
    let ranked = rank_zcode_roots();
    let interesting: Vec<&Candidate> = ranked.iter().filter(|c| c.score > 0).collect();
    let ignored = ranked.len() - interesting.len();

    println!("ZCode 数据目录候选（✓ = 带 v2/runtime，即认得出来）：");
    if interesting.is_empty() {
        println!("  （没有得分 > 0 的候选）");
    }
    for item in interesting {
        println!(
            "  {} [{}] {}",
            if item.score >= 4 { "✓" } else { " " },
            item.score,
            item.app_config_dir.display()
        );
        if !item.evidence.is_empty() {
            println!("          证据：{}", item.evidence.join("、"));
        }
    }
    if ignored > 0 {
        println!("  （另有 {ignored} 个 0 分候选已忽略）");
    }

    println!();
    println!(
        "环境变量 ZCODE_DATA_BASE_DIR：{}",
        env_base().unwrap_or_else(|| "（未设置）".into())
    );
    println!(
        "旁路文件：{}",
        read_sidecar(script_dir).unwrap_or_else(|| "（无）".into())
    );
    println!("           {}", sidecar_path(script_dir).display());
    println!();
    let decided = ranked.iter().find(|c| c.score >= 4);
    println!(
        "结论：{}",
        decided.map(|d| format!("采用 {}", d.app_config_dir.display()))
            .unwrap_or_else(|| "没探测到 —— 请用 --config 指定".into())
    );
    println!("配置将写入：{}", resolve_config_target(script_dir, None).config_path.display());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 显式路径优先级最高() {
        let dir = std::env::temp_dir();
        let resolved = resolve_config_target(&dir, Some("D:/x/provider_config.json"));
        assert_eq!(resolved.source, Source::Explicit);
        assert_eq!(resolved.config_path, PathBuf::from("D:/x/provider_config.json"));
    }

    #[test]
    fn 探测排序按分数降序() {
        let ranked = rank_zcode_roots();
        for pair in ranked.windows(2) {
            assert!(pair[0].score >= pair[1].score, "分数应降序");
        }
    }

    #[test]
    fn 旁路文件指向的目录没有runtime时不被采信() {
        let dir = std::env::temp_dir().join("o2z-detect-test");
        let _ = std::fs::create_dir_all(&dir);
        let bogus = dir.join("nowhere-at-all");
        write_sidecar(&dir, bogus.to_str().unwrap());
        let resolved = resolve_config_target(&dir, None);
        assert_ne!(
            resolved.source,
            Source::Sidecar,
            "指向不存在 runtime 的旁路文件不该被采信"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
