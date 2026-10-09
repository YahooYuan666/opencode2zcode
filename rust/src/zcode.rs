//! ZCode 个人 Provider 配置的读取、合并、写入与摘除。
//!
//! 不变量：**只动本工具那两个 providerId**，用户已有的 GPT / Grok / DeepSeek
//! / 官方 OpenCode Zen 等一律原样保留，`providerOrder` 也保留。

use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

use crate::catalog::{efforts_for, ModelCatalog, Wire};
use crate::zen::ANONYMOUS_KEY;

pub const PROVIDER_ID: &str = "opencode-free";
pub const PROVIDER_NAME: &str = "OpenCode 免费模型";
pub const RESPONSES_PROVIDER_ID: &str = "opencode-free-responses";
pub const RESPONSES_PROVIDER_NAME: &str = "OpenCode 免费模型 · Responses";

pub fn our_ids() -> [&'static str; 2] {
    [PROVIDER_ID, RESPONSES_PROVIDER_ID]
}

/// 这个模型走哪条线。
///
/// 优先信官方目录里该模型自己声明的 SDK（`provider.npm`）：`@ai-sdk/openai`
/// 走 responses，`openai-compatible` 走 chat，anthropic 等本工具代理不了。
/// 目录没说话时才退回按名字猜——muse-spark 走 responses，jev 走本工具没有的
/// systemone 道，其余当 chat。
pub fn lane_for(id: &str, catalog: &ModelCatalog) -> Option<Wire> {
    if let Some(wire) = catalog.metadata(id).and_then(|p| p.wire) {
        return match wire {
            Wire::Unsupported => None,
            other => Some(other),
        };
    }
    let lower = id.to_lowercase();
    if lower.is_empty() || lower.starts_with("jev") {
        return None;
    }
    if lower.starts_with("muse-spark") {
        return Some(Wire::Responses);
    }
    Some(Wire::Chat)
}

#[derive(Clone, Debug)]
pub struct ModelEntry {
    pub id: String,
    pub context_window: f64,
    pub max_tokens: f64,
    pub supports_images: bool,
    pub thinking_levels: Vec<String>,
}

/// models.dev 元数据 → 声明条目；缺元数据时给中性默认值，绝不退化成裸 ID。
/// models.dev 元数据 → 声明条目。
///
/// 元数据拿不到时给中性默认（262144/32768、无图、无思考档位）。这里**不**放编译期
/// 写死的实测表——那份表会随上游增减而陈旧，写进代码里等于让程序永远按某个历史
/// 快照说话。真拿不到元数据时，模型选择器里没有档位可选是**如实反映"数据未知"**，
/// 比给一份可能过期的假档位更诚实（且静默开着，配置不会来回抖动）。
pub fn catalog_entry(id: &str, catalog: &ModelCatalog) -> ModelEntry {
    let Some(meta) = catalog.metadata(id) else {
        return ModelEntry {
            id: id.to_string(),
            context_window: 262144.0,
            max_tokens: 32768.0,
            supports_images: false,
            thinking_levels: Vec::new(),
        };
    };
    ModelEntry {
        id: id.to_string(),
        context_window: meta.context_window,
        max_tokens: meta.max_tokens,
        supports_images: meta.modalities_input.iter().any(|m| m == "image"),
        thinking_levels: efforts_for(Some(meta)),
    }
}

pub fn chat_model_entries(catalog: &ModelCatalog) -> Vec<ModelEntry> {
    catalog
        .list()
        .into_iter()
        .filter(|id| lane_for(id, catalog) == Some(Wire::Chat))
        .map(|id| catalog_entry(&id, catalog))
        .collect()
}

pub fn responses_model_entries(catalog: &ModelCatalog) -> Vec<ModelEntry> {
    catalog
        .list()
        .into_iter()
        .filter(|id| lane_for(id, catalog) == Some(Wire::Responses))
        .map(|id| catalog_entry(&id, catalog))
        .collect()
}

fn build_provider_rule(id: &str, name: &str, api_type: &str, port: u16, model_ids: &[String]) -> Value {
    json!({
        "providerId": id,
        "providerName": name,
        "enabled": true,
        "config": {
            "group": "standard-personal",
            "visibility": "visible",
            "access": { "type": "api-key", "apiKey": ANONYMOUS_KEY },
            "api": { "type": api_type, "baseUrl": format!("http://127.0.0.1:{port}/v1") },
            "personalModelIds": model_ids,
            "modelOrder": model_ids,
        }
    })
}

/**
 * 每个模型的元数据走 smart 车道：ZCode 内置模板与用户自建 Provider 用的都是它，
 * 且接受部分稀疏配置（只补你确实知道的叶子，其余交给 ZCode 自己解析）。
 * 走 manual 车道反而要求把一堆叶子填满，且同一 Provider/Model 不能两条道并存。
 */
fn build_model_rule(provider_id: &str, entry: &ModelEntry) -> Value {
    let mut config = Map::new();
    config.insert(
        "properties".into(),
        json!({
            "contextWindow": entry.context_window,
            "inputFormat": { "supportsImage": entry.supports_images },
        }),
    );
    let mut option_specs = Map::new();
    if !entry.thinking_levels.is_empty() {
        // values 就是模型选择器里那串思考档位；真正的 reasoning_effort 归一在代理层做。
        option_specs.insert("reasoningLevel".into(), json!({ "values": entry.thinking_levels }));
    }
    if entry.max_tokens.is_finite() {
        option_specs.insert("maxOutputTokens".into(), json!({ "max": entry.max_tokens }));
    }
    if !option_specs.is_empty() {
        config.insert("optionSpecs".into(), Value::Object(option_specs));
    }
    json!({ "providerId": provider_id, "modelId": entry.id, "config": Value::Object(config) })
}

fn as_object_array(value: Option<&Value>) -> Vec<Value> {
    value.and_then(Value::as_array).cloned().unwrap_or_default()
}

pub fn read_existing_config(config_path: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(config_path).ok()?;
    serde_json::from_str(&text).ok()
}

/// 组装整份 provider_config.json，保留用户已有的其它 Provider。
pub fn build_zcode_config(
    existing: Option<&Value>,
    port: u16,
    chat_models: &[ModelEntry],
    responses_models: &[ModelEntry],
) -> Value {
    let chat_ids: Vec<String> = chat_models.iter().map(|m| m.id.clone()).collect();
    let mut our_rules = vec![build_provider_rule(
        PROVIDER_ID,
        PROVIDER_NAME,
        "openai-chat-completions",
        port,
        &chat_ids,
    )];
    if !responses_models.is_empty() {
        let responses_ids: Vec<String> = responses_models.iter().map(|m| m.id.clone()).collect();
        our_rules.push(build_provider_rule(
            RESPONSES_PROVIDER_ID,
            RESPONSES_PROVIDER_NAME,
            "openai-responses",
            port,
            &responses_ids,
        ));
    }

    let mut our_model_rules: Vec<Value> = chat_models.iter().map(|m| build_model_rule(PROVIDER_ID, m)).collect();
    our_model_rules.extend(
        responses_models
            .iter()
            .map(|m| build_model_rule(RESPONSES_PROVIDER_ID, m)),
    );

    let prior = existing
        .filter(|e| e.get("schemaVersion").and_then(Value::as_u64) == Some(1))
        .and_then(|e| e.get("config"));
    let ids = our_ids();

    let keep_rules = |value: Option<&Value>| -> Vec<Value> {
        as_object_array(value)
            .into_iter()
            .filter(|rule| {
                rule.get("providerId")
                    .and_then(Value::as_str)
                    .map(|id| !ids.contains(&id))
                    .unwrap_or(false)
            })
            .collect()
    };

    let prior_config = prior.and_then(Value::as_object);
    let provider_rules_prior = prior_config
        .and_then(|c| c.get("providerConfigRules"))
        .and_then(|r| r.get("providerRules"));
    let model_rules_prior = prior_config.and_then(|c| c.get("modelConfigRules"));
    let order_prior = prior_config.and_then(|c| c.get("providerOrder"));

    let kept_rules = keep_rules(provider_rules_prior);
    let kept_provider_model_rules = keep_rules(model_rules_prior.and_then(|m| m.get("providerModelRules")));
    let kept_manual_model_rules = keep_rules(model_rules_prior.and_then(|m| m.get("manualProviderModelRules")));

    let kept_order: Vec<Value> = as_object_array(order_prior)
        .into_iter()
        .filter(|v| {
            v.as_str()
                .map(|s| !ids.contains(&s))
                .unwrap_or(false)
        })
        .collect();

    let mut all_rules = kept_rules;
    all_rules.extend(our_rules.clone());
    let mut all_model_rules = kept_provider_model_rules;
    all_model_rules.extend(our_model_rules);
    let mut all_order = kept_order;
    all_order.extend(our_rules.iter().filter_map(|r| r.get("providerId").cloned()));

    json!({
        "schemaVersion": 1,
        "config": {
            "providerOrder": all_order,
            "providerConfigRules": { "providerRules": all_rules },
            "modelConfigRules": {
                "providerModelRules": all_model_rules,
                "manualProviderModelRules": kept_manual_model_rules,
            },
        }
    })
}

/// 从现有配置里摘掉本工具写入的两个 provider，别的 Provider 一律不动。
/// 复用 build_zcode_config 的过滤口径，保证「装上去的」和「卸掉的」严格对称。
pub fn remove_our_providers(existing: Option<&Value>) -> Option<(usize, Value)> {
    let existing = existing?;
    if existing.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        return None;
    }
    let prior = existing.get("config")?;
    let ids = our_ids();

    let split = |value: Option<&Value>| -> (Vec<Value>, usize) {
        let all = as_object_array(value);
        let kept = all
            .iter()
            .filter(|rule| {
                rule.get("providerId")
                    .and_then(Value::as_str)
                    .map(|id| !ids.contains(&id))
                    .unwrap_or(false)
            })
            .cloned()
            .collect::<Vec<_>>();
        let removed = all.len() - kept.len();
        (kept, removed)
    };

    let provider_rules_prior = prior.get("providerConfigRules").and_then(|r| r.get("providerRules"));
    let (kept_rules, removed_rules) = split(provider_rules_prior);
    let model_rules_prior = prior.get("modelConfigRules");
    let (kept_model_rules, _) = split(model_rules_prior.and_then(|m| m.get("providerModelRules")));
    let (kept_manual_rules, _) = split(model_rules_prior.and_then(|m| m.get("manualProviderModelRules")));

    let order_all = as_object_array(prior.get("providerOrder"));
    let kept_order: Vec<Value> = order_all
        .into_iter()
        .filter(|v| v.as_str().map(|s| !ids.contains(&s)).unwrap_or(false))
        .collect();

    Some((
        removed_rules,
        json!({
            "schemaVersion": 1,
            "config": {
                "providerOrder": kept_order,
                "providerConfigRules": { "providerRules": kept_rules },
                "modelConfigRules": {
                    "providerModelRules": kept_model_rules,
                    "manualProviderModelRules": kept_manual_rules,
                },
            }
        }),
    ))
}

/// 打印用的脱敏：绝不让 --print-config 把别人的 key 打到终端上。
pub fn redact_secrets(config: &Value) -> Value {
    let mut clone = config.clone();
    if let Some(rules) = clone
        .pointer_mut("/config/providerConfigRules/providerRules")
        .and_then(Value::as_array_mut)
    {
        for rule in rules {
            if let Some(key) = rule.pointer_mut("/config/access/apiKey") {
                *key = Value::String("***已隐藏***".into());
            }
        }
    }
    clone
}

/// 原子写（同目录临时文件 + rename），写前留一份带时间戳的备份。
pub fn write_zcode_config(config_path: &Path, config: &Value) -> std::io::Result<()> {
    if let Some(parent) = config_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    if config_path.exists() {
        let stamp = backup_stamp();
        let backup = config_path.with_file_name(format!(
            "{}.bak-{stamp}",
            config_path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "provider_config.json".into())
        ));
        // 备份失败不阻断主流程。
        let _ = std::fs::copy(config_path, backup);
    }
    let temporary: PathBuf = config_path.with_file_name(format!(
        "{}.{}.tmp",
        config_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "provider_config.json".into()),
        std::process::id()
    ));
    let text = format!("{}\n", serde_json::to_string_pretty(config).unwrap_or_default());
    std::fs::write(&temporary, text)?;
    std::fs::rename(&temporary, config_path)
}

pub fn backup_stamp() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{now}").replace([':', '.'], "-")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::Price;
    use std::collections::BTreeMap;

    fn sample_entries() -> (Vec<ModelEntry>, Vec<ModelEntry>) {
        let chat = ModelEntry {
            id: "big-pickle".into(),
            context_window: 200000.0,
            max_tokens: 32000.0,
            supports_images: false,
            thinking_levels: vec!["minimal".into(), "high".into()],
        };
        (vec![chat], Vec::new())
    }

    fn existing_with_other() -> Value {
        json!({
            "schemaVersion": 1,
            "config": {
                "providerOrder": ["someone-elses"],
                "providerConfigRules": { "providerRules": [
                    { "providerId": "someone-elses", "providerName": "别人的" }
                ]},
                "modelConfigRules": { "providerModelRules": [], "manualProviderModelRules": [] }
            }
        })
    }

    #[test]
    fn 别人的_provider_与_order_都保留() {
        let (chat, responses) = sample_entries();
        let merged = build_zcode_config(Some(&existing_with_other()), 41930, &chat, &responses);
        let ids: Vec<String> = merged["config"]["providerConfigRules"]["providerRules"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["providerId"].as_str().unwrap().to_string())
            .collect();
        assert!(ids.contains(&"someone-elses".to_string()), "别人的 provider 应保留");
        assert!(ids.contains(&PROVIDER_ID.to_string()));
        let order: Vec<&str> = merged["config"]["providerOrder"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert!(order.contains(&"someone-elses"), "providerOrder 应保留别人的条目");
    }

    #[test]
    fn 重复构建不产生重复_provider() {
        let (chat, responses) = sample_entries();
        let once = build_zcode_config(None, 41930, &chat, &responses);
        let twice = build_zcode_config(Some(&once), 41930, &chat, &responses);
        let count = |v: &Value| v["config"]["providerConfigRules"]["providerRules"].as_array().unwrap().len();
        assert_eq!(count(&once), count(&twice), "重复写入应幂等");
    }

    #[test]
    fn 摘除与安装严格对称() {
        let (chat, responses) = sample_entries();
        let existing = existing_with_other();
        let installed = build_zcode_config(Some(&existing), 41930, &chat, &responses);
        let (removed, cleaned) = remove_our_providers(Some(&installed)).unwrap();
        assert_eq!(removed, 1, "应摘掉 1 个（本例没 responses 组）");
        let ids: Vec<String> = cleaned["config"]["providerConfigRules"]["providerRules"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["providerId"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(ids, vec!["someone-elses".to_string()], "只剩别人的");
    }

    #[test]
    fn 脱敏不漏掉别人的密钥() {
        let (chat, responses) = sample_entries();
        let existing = json!({
            "schemaVersion": 1,
            "config": { "providerConfigRules": { "providerRules": [
                { "providerId": "gpt", "config": { "access": { "apiKey": "sk-真实密钥" } } }
            ]}}
        });
        let merged = build_zcode_config(Some(&existing), 41930, &chat, &responses);
        let text = serde_json::to_string(&redact_secrets(&merged)).unwrap();
        assert!(!text.contains("sk-真实密钥"), "不该把用户密钥打到终端上");
    }

    #[test]
    fn catalog_entry_用元数据填上下文与档位() {
        let mut prices = BTreeMap::new();
        prices.insert(
            "space-bunny-free".to_string(),
            Price {
                reasoning: true,
                effort_values: vec!["low".into(), "max".into()],
                context_window: 1048576.0,
                max_tokens: 524288.0,
                modalities_input: vec!["text".into(), "image".into()],
                ..Default::default()
            },
        );
        let catalog = ModelCatalog::with_prices(
            prices,
            ["space-bunny-free".to_string()].into_iter().collect(),
        );
        let entry = catalog_entry("space-bunny-free", &catalog);
        assert_eq!(entry.context_window, 1048576.0);
        assert!(entry.supports_images);
        assert_eq!(entry.thinking_levels, vec!["low", "max"]);
    }
}
