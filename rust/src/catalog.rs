//! 模型目录：S1（Zen 实时清单）∩ S2（models.dev 判为免费且未下架）。
//!
//! 「免费」的判定与 OpenCode 桌面版逐位对齐，规则和理由见 `decide` 的注释。

use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use crate::zen::{opencode_user_agent, ACCEPTED_EFFORT_LADDER, ANONYMOUS_KEY};

pub const DEFAULT_EFFORT_LADDER: [&str; 4] = ["minimal", "low", "medium", "high"];

const CACHE_TTL_MS: u128 = 7 * 24 * 60 * 60 * 1000;
const CATALOG_TIMEOUT: Duration = Duration::from_secs(30);
const STALE_AFTER_MS: u128 = 10 * 60 * 1000;

#[derive(Clone, Debug, Default)]
pub struct Price {
    pub input: Option<f64>,
    pub output: Option<f64>,
    pub deprecated: bool,
    pub reasoning: bool,
    pub context_window: f64,
    pub max_tokens: f64,
    pub modalities_input: Vec<String>,
    pub effort_values: Vec<String>,
    /// 上游自己声明的线格式：官方目录里该模型的 `provider.npm`。
    /// `None` 表示没有逐模型声明，走段级默认（chat）。
    pub wire: Option<Wire>,
}

/// 一个模型走哪条线。来源是官方目录的 SDK 声明，不是模型名。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Wire {
    /// `@ai-sdk/openai-compatible`：/v1/chat/completions
    Chat,
    /// `@ai-sdk/openai`：/v1/responses
    Responses,
    /// `@ai-sdk/anthropic` 等：本工具没有对应的道，不能代理。
    Unsupported,
}

impl Wire {
    fn as_str(self) -> &'static str {
        match self {
            Wire::Chat => "chat",
            Wire::Responses => "responses",
            Wire::Unsupported => "unsupported",
        }
    }

    fn from_str(value: &str) -> Option<Self> {
        match value {
            "chat" => Some(Wire::Chat),
            "responses" => Some(Wire::Responses),
            "unsupported" => Some(Wire::Unsupported),
            _ => None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Decision {
    pub allowed: bool,
    pub source: &'static str,
    pub known: bool,
}

impl Decision {
    fn deny(source: &'static str, known: bool) -> Self {
        Self { allowed: false, source, known }
    }
    fn allow(source: &'static str, known: bool) -> Self {
        Self { allowed: true, source, known }
    }
}

fn is_free_model(model: &str) -> bool {
    model.to_lowercase().contains("free")
}

/// 官方目录里的 SDK 包名 → 线格式。
///
/// `@ai-sdk/openai` 是 Responses 线，`@ai-sdk/openai-compatible` 是 chat 线，
/// 两者必须先判精确的那个——`openai-compatible` 也含 `openai` 子串。
/// anthropic / google / mistral 这些本工具没有对应的道，标成不可代理。
pub fn decode_wire(npm: Option<&str>) -> Option<Wire> {
    let value = npm?.trim().to_lowercase();
    if value.is_empty() {
        return None;
    }
    if value == "@ai-sdk/openai" || value.ends_with("/openai") {
        return Some(Wire::Responses);
    }
    if value.contains("openai-compatible") {
        return Some(Wire::Chat);
    }
    Some(Wire::Unsupported)
}

/// models.dev 的 opencode 段 → modelId → 元数据。
pub fn decode_models_dev(data: &Value) -> BTreeMap<String, Price> {
    let mut result = BTreeMap::new();
    // 供应商可能裹在 `providers` 下，也可能直接摊在根上——models.dev 两种形状
    // 都出现过。只认一种会让整个元数据判定静默失效（prices_ready 永远为 false），
    // 于是所有名字里带 free 的模型都被放行，下架的也混进来。
    let providers = data
        .get("providers")
        .filter(|v| v.is_object())
        .unwrap_or(data);
    let Some(providers) = providers.as_object() else {
        return result;
    };

    // 优先精确的 opencode 段，其次名字里带 opencode 的段，都不像才放弃。
    let mut keys: Vec<&String> = providers.keys().collect();
    let rank = |k: &str| -> u8 {
        let lower = k.to_lowercase();
        if lower == "opencode" || lower == "opencode-zen" || lower == "opencode_zen" {
            0
        } else if lower.contains("opencode") {
            1
        } else {
            2
        }
    };
    keys.sort_by(|a, b| rank(a).cmp(&rank(b)).then_with(|| a.cmp(b)));

    for key in keys {
        if rank(key) > 1 {
            continue;
        }
        let Some(provider) = providers.get(key.as_str()) else { continue };
        if rank(key) == 1 {
            let identity = format!(
                "{} {}",
                provider.get("id").and_then(Value::as_str).unwrap_or(""),
                provider.get("name").and_then(Value::as_str).unwrap_or("")
            )
            .to_lowercase();
            if !identity.contains("opencode") {
                continue;
            }
        }
        let Some(models) = provider.get("models").and_then(Value::as_object) else { continue };
        for (model_key, raw) in models {
            if !raw.is_object() {
                continue;
            }
            let model_id = raw
                .get("id")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .unwrap_or(model_key.as_str())
                .to_string();
            let cost = raw.get("cost");
            let limit = raw.get("limit");
            let num = |v: Option<&Value>| -> Option<f64> {
                v.and_then(Value::as_f64).filter(|f| f.is_finite())
            };
            let modalities_input: Vec<String> = raw
                .get("modalities")
                .and_then(|m| m.get("input"))
                .and_then(Value::as_array)
                .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
                .unwrap_or_default();

            result.insert(
                model_id,
                Price {
                    input: num(cost.and_then(|c| c.get("input"))),
                    output: num(cost.and_then(|c| c.get("output"))),
                    deprecated: metadata_deprecated(raw),
                    reasoning: raw.get("reasoning").and_then(Value::as_bool) == Some(true),
                    context_window: num(limit.and_then(|l| l.get("context"))).unwrap_or(262144.0),
                    max_tokens: num(limit.and_then(|l| l.get("output"))).unwrap_or(32768.0),
                    modalities_input,
                    effort_values: decode_effort_values(raw.get("reasoning_options")),
                    // 逐模型的 npm 覆盖段级默认；没有逐模型声明就走段级（chat）。
                    wire: decode_wire(
                        raw.pointer("/provider/npm")
                            .and_then(Value::as_str)
                            .or_else(|| provider.get("npm").and_then(Value::as_str)),
                    ),
                },
            );
        }
        if !result.is_empty() {
            return result;
        }
    }
    result
}

fn metadata_deprecated(model: &Value) -> bool {
    if model.get("deprecated").and_then(Value::as_bool) == Some(true) {
        return true;
    }
    let status = model
        .get("status")
        .or_else(|| model.get("lifecycle"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_lowercase();
    if matches!(status.as_str(), "deprecated" | "retired" | "disabled") {
        return true;
    }
    model.get("deprecated_at").map(|v| !v.is_null()).unwrap_or(false)
        || model.get("retirement_date").map(|v| !v.is_null()).unwrap_or(false)
}

fn decode_effort_values(raw: Option<&Value>) -> Vec<String> {
    let Some(Value::Array(options)) = raw else {
        return Vec::new();
    };
    let mut values = Vec::new();
    for option in options {
        let Some(obj) = option.as_object() else { continue };
        if obj.get("type").and_then(Value::as_str) != Some("effort") {
            continue;
        }
        let Some(Value::Array(vals)) = obj.get("values") else { continue };
        for value in vals {
            if let Some(s) = value.as_str().filter(|s| !s.is_empty()) {
                if !values.iter().any(|v: &String| v == s) {
                    values.push(s.to_string());
                }
            }
        }
    }
    values
}

/// 从 models.dev 的 reasoning_options 推出 UI 档位阶梯（去掉上游不收的 off/none）。
pub fn efforts_for(price: Option<&Price>) -> Vec<String> {
    let Some(price) = price else { return Vec::new() };
    if !price.reasoning {
        return Vec::new();
    }
    let mut declared: Vec<String> = Vec::new();
    for value in &price.effort_values {
        let level = if value == "none" { "off" } else { value.as_str() };
        if ACCEPTED_EFFORT_LADDER.contains(&level) && !declared.iter().any(|d| d == level) {
            declared.push(level.to_string());
        }
    }
    if declared.is_empty() {
        return DEFAULT_EFFORT_LADDER.iter().map(|s| s.to_string()).collect();
    }
    declared.sort_by_key(|level| {
        ACCEPTED_EFFORT_LADDER.iter().position(|l| l == level).unwrap_or(usize::MAX)
    });
    declared
}

/// 是否免费——与 OpenCode 桌面版逐位对齐。桌面版的判定就一行
/// （packages/app/src/components/dialog-select-model.tsx）：
///
///   isFree = provider === "opencode" && (!cost || cost.input === 0)
///
/// 两处容易踩的细节：
///   1. 只看 input，**不看 output**；并且「没有 cost 数据」也算免费。
///   2. 桌面版还会排除 status 为 deprecated 的条目。Zen 把下架模型留在公开
///      /models 和目录里（标价仍是 0），不排除的话模型选择器里会出现点下去
///      必报错的选项——实测 mimo-v2.5-free、muse-spark-1.2-contributor-free
///      就是这样被误放进来的。
pub fn decide(model: &str, prices: &BTreeMap<String, Price>, ready: bool) -> Decision {
    let name_free = is_free_model(model);
    let fallback = |source: &'static str| -> Decision {
        if name_free {
            Decision::allow("name_free", false)
        } else {
            Decision::deny(source, false)
        }
    };
    if !ready || prices.is_empty() {
        return fallback("metadata_pending");
    }
    // 目录里查无此模型：不按名字放行。实时清单里混着大量名字带 free 的
    // 付费或未核实模型，名字兜底只在「整份元数据都没拉到」时才有意义。
    let Some(price) = prices.get(model) else {
        return Decision::deny("metadata_model_missing", false);
    };
    // 废弃是硬否决，后面的兜底也不许把它捞回来。
    if price.deprecated {
        return Decision::deny("metadata_deprecated", true);
    }
    if price.input.is_none() || price.input == Some(0.0) {
        return Decision::allow(
            if name_free { "name_and_metadata_free" } else { "metadata_free" },
            true,
        );
    }
    Decision::deny("metadata_paid", true)
}

#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub status: &'static str,
    pub source: &'static str,
    pub total: usize,
    pub exposed: usize,
    pub last_error: String,
}

pub struct ModelCatalog {
    cache_path: Option<PathBuf>,
    /// 最近一次**成功**解析出来的清单与价格（内存快照）。
    /// 拿不到任何数据源时用它顶上——这是"最近一次更新的结果"，不是编译期名单。
    last_good_zen: BTreeSet<String>,
    last_good_prices: BTreeMap<String, Price>,
    zen: BTreeSet<String>,
    prices: BTreeMap<String, Price>,
    prices_ready: bool,
    updated_at_ms: u128,
    live_at_ms: u128,
    last_error: String,
    seeded: bool,
    cached_fingerprint: String,
    last_change_key: String,
    /// 上次拉到的 models.dev ETag。带上 If-None-Match 后，目录没变就回 304，
    /// 不用每 5 分钟重下那 5MB。
    metadata_etag: Option<String>,
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

impl ModelCatalog {
    pub fn new(cache_path: Option<PathBuf>) -> Self {
        Self {
            cache_path,
            last_good_zen: BTreeSet::new(),
            last_good_prices: BTreeMap::new(),
            zen: BTreeSet::new(),
            prices: BTreeMap::new(),
            prices_ready: false,
            updated_at_ms: 0,
            live_at_ms: 0,
            last_error: String::new(),
            seeded: false,
            cached_fingerprint: String::new(),
            last_change_key: String::new(),
            metadata_etag: None,
        }
    }

    fn seed_from_cache(&mut self) {
        // 种子失败（缓存损坏/缺失）不判死刑：prices 始终为空的进程是「中毒」的，
        // 会一辈子写出没有思考档位的裸配置。没拿到元数据就把标记撤掉，
        // 让下一次 5 分钟刷新重试。
        if self.seeded && self.prices_ready {
            return;
        }
        self.seeded = true;
        let Some(path) = &self.cache_path else { return };
        let Ok(text) = std::fs::read_to_string(path) else { return };
        let Ok(raw) = serde_json::from_str::<Value>(&text) else { return };
        if raw.get("version").and_then(Value::as_u64) != Some(1) {
            return;
        }
        let Some(updated_at) = raw.get("updatedAt").and_then(Value::as_f64) else { return };
        let updated_at = updated_at as u128;
        if now_ms().saturating_sub(updated_at) > CACHE_TTL_MS {
            return;
        }
        if let Some(ids) = raw.get("zen").and_then(Value::as_array) {
            let list: Vec<String> = ids
                .iter()
                .filter_map(|v| v.as_str().filter(|s| !s.is_empty()).map(String::from))
                .collect();
            if !list.is_empty() {
                self.zen = list.into_iter().collect();
                self.updated_at_ms = updated_at;
            }
        }
        if let Some(entries) = raw.get("prices").and_then(Value::as_array) {
            let mut map = BTreeMap::new();
            for entry in entries {
                let Some(pair) = entry.as_array() else { continue };
                if pair.len() != 2 {
                    continue;
                }
                let (Some(k), Some(v)) = (pair[0].as_str(), pair[1].as_object()) else { continue };
                if let Some(price) = price_from_value(v) {
                    map.insert(k.to_string(), price);
                }
            }
            if !map.is_empty() {
                self.prices = map;
                self.last_good_prices = self.prices.clone();
                self.prices_ready = true;
                // 缓存里清单和元数据是同一次写出来的，两者都在才构成可信快照。
                if !self.zen.is_empty() {
                    self.last_good_zen = self.zen.clone();
                }
            }
        }
        self.cached_fingerprint = self.fingerprint();
    }

    fn fingerprint(&self) -> String {
        serde_json::to_string(&(
            &self.zen,
            self.prices
                .iter()
                .map(|(k, v)| (k, price_to_value(v)))
                .collect::<Vec<_>>(),
        ))
        .unwrap_or_default()
    }

    fn save_cache(&mut self) {
        let Some(path) = self.cache_path.clone() else { return };
        // 空prices 覆盖好缓存 = 自我中毒循环：本次种子失败→把好缓存写坏→
        // 之后每次重启都从坏缓存种子→永远好不了。没有元数据就别动缓存。
        if self.prices.is_empty() {
            return;
        }
        let fingerprint = self.fingerprint();
        if !self.cached_fingerprint.is_empty() && self.cached_fingerprint == fingerprint {
            return;
        }
        let payload = serde_json::json!({
            "version": 1,
            "updatedAt": now_ms(),
            "zen": self.zen.iter().cloned().collect::<Vec<_>>(),
            "prices": self
                .prices
                .iter()
                .map(|(k, v)| (k.clone(), price_to_value(v)))
                .collect::<Vec<_>>(),
        });
        let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
        if std::fs::write(&temporary, serde_json::to_string(&payload).unwrap_or_default()).is_ok() {
            if std::fs::rename(&temporary, &path).is_ok() {
                self.cached_fingerprint = fingerprint;
            } else {
                let _ = std::fs::remove_file(&temporary);
            }
        }
    }

    /// 拉一次实时目录。返回暴露清单是否发生了变化。
    pub fn refresh_once(&mut self, zen_base_url: &str) -> bool {
        self.seed_from_cache();
        self.refresh_zen(zen_base_url);
        self.refresh_metadata();
        self.save_cache();

        let exposed = self.list();
        // 快照记「这次真的被放行的」，不是整份实时清单。实时清单里混着
        // 付费和未核实的模型，整份记下来会在元数据抖动时被原样放行。
        if !exposed.is_empty() {
            self.last_good_zen = exposed.iter().cloned().collect();
        }
        let key = exposed.join("|");
        let changed = key != self.last_change_key;
        self.last_change_key = key;
        changed
    }

    /// 首次播种不算「变化」，避免还没联网就先写一版缩水配置。
    pub fn prime(&mut self, zen_base_url: &str) {
        self.refresh_once(zen_base_url);
        self.last_change_key = self.list().join("|");
    }

    fn refresh_zen(&mut self, zen_base_url: &str) {
        let client = match crate::http::client() {
            Ok(c) => c,
            Err(e) => {
                self.last_error = e;
                return;
            }
        };
        let url = format!("{zen_base_url}/v1/models");
        let mut request = client.get(&url).header("authorization", format!("Bearer {ANONYMOUS_KEY}"));
        request = request.header("user-agent", opencode_user_agent());
        request = request.header("x-opencode-client", "cli");
        request = request.header("accept", "application/json");
        match request.timeout(CATALOG_TIMEOUT).send() {
            Ok(response) if response.status().is_success() => {
                match response.json::<Value>() {
                    Ok(payload) => {
                        let ids: BTreeSet<String> = payload
                            .get("data")
                            .and_then(Value::as_array)
                            .map(|arr| {
                                arr.iter()
                                    .filter_map(|m| m.get("id").and_then(Value::as_str).map(String::from))
                                    .collect()
                            })
                            .unwrap_or_default();
                        // 空清单不覆盖：上游抖动回了空 body 时，保住上一次的结果。
                        if !ids.is_empty() {
                            self.zen = ids;
                            let now = now_ms();
                            self.updated_at_ms = now;
                            self.live_at_ms = now;
                            self.last_error.clear();
                        }
                    }
                    Err(e) => self.last_error = e.to_string(),
                }
            }
            Ok(response) => {
                self.last_error = format!("models endpoint returned HTTP {}", response.status());
            }
            Err(e) => self.last_error = e.to_string(),
        }
    }

    fn refresh_metadata(&mut self) {
        let client = match crate::http::client() {
            Ok(c) => c,
            Err(e) => {
                if !self.prices_ready {
                    self.last_error = e;
                }
                return;
            }
        };
        // 闭包只负责取数据，不碰 self：304 返回 None，200 返回 (etag, 正文)。
        let result: Result<Option<(Option<String>, Value)>, String> = (|| {
            let mut request = client
                .get(crate::METADATA_URL)
                .header("accept", "application/json")
                .timeout(CATALOG_TIMEOUT);
            if let Some(etag) = &self.metadata_etag {
                request = request.header("if-none-match", etag);
            }
            let response = request.send().map_err(|e| e.to_string())?;
            // 304：目录没变，沿用内存里的那份，不再解析。
            if response.status().as_u16() == 304 {
                return Ok(None);
            }
            if !response.status().is_success() {
                return Err(format!("models.dev returned HTTP {}", response.status()));
            }
            let etag = response
                .headers()
                .get("etag")
                .and_then(|v| v.to_str().ok())
                .map(str::to_string);
            let data = response.json::<Value>().map_err(|e| e.to_string())?;
            Ok(Some((etag, data)))
        })();
        match result {
            Ok(None) => {}
            Ok(Some((etag, data))) => {
                self.metadata_etag = etag;
                let prices = decode_models_dev(&data);
                if prices.is_empty() {
                    if !self.prices_ready {
                        self.last_error = "models.dev contains no OpenCode model metadata".into();
                    }
                } else {
                    self.prices = prices;
                    self.last_good_prices = self.prices.clone();
                    self.prices_ready = true;
                    self.live_at_ms = now_ms();
                }
            }
            Err(e) => {
                if !self.prices_ready {
                    self.last_error = e;
                }
            }
        }
    }

    pub fn decision_for(&self, model: &str) -> Decision {
        let metadata = decide(model, &self.prices, self.prices_ready);
        if metadata.allowed {
            return metadata;
        }
        // 目录已明确判定废弃时，S3 静态清单不再把它捞回来——那正是早先多出
        // mimo-v2.5-free / muse-spark-1.2-contributor-free 的原因。S3 只兜「还说不准」。
        if metadata.source == "metadata_deprecated" {
            return metadata;
        }
        if !metadata.known && self.last_good_zen.contains(model) {
            return Decision::allow("static_verified", false);
        }
        metadata
    }

    /// 暴露的 id：S1 ∩ 允许；元数据缺失时**只**用静态实测清单。
    ///
    /// 元数据不可用时（models.dev 拉不到且缓存也没种子上），不能退回
    /// 「名字带 free 就放行」——那会把目录里标了已下架的模型一起放进来
    /// （点下去必报错），还会让所有条目退化成没有思考档位的裸默认值。
    /// 2026-10-02 的「思考等级调不了」事故就是这条路径：宁可少暴露，
    /// 也不暴露没核实过的。
    pub fn list(&self) -> Vec<String> {
        if self.zen.is_empty() {
            // 实时清单没有：用最近一次成功解析出来的结果。
            let mut out: Vec<String> = self.last_good_zen.iter().cloned().collect();
            out.sort();
            return out;
        }
        if !self.prices_ready {
            // 元数据没就绪：只暴露"上次成功解析过、且此刻仍在实时清单里"的模型。
            // 编译期写死的名单已经去掉——它会随上游增减而陈旧，正是要消除的那类误导。
            let mut out: Vec<String> = self
                .zen
                .iter()
                .filter(|m| self.last_good_zen.contains(*m))
                .cloned()
                .collect();
            out.sort();
            return out;
        }
        let mut out: Vec<String> = self
            .zen
            .iter()
            .filter(|m| self.decision_for(m).allowed)
            .cloned()
            .collect();
        out.sort();
        out
    }

    pub fn metadata(&self, model: &str) -> Option<&Price> {
        self.prices.get(model)
    }

    pub fn snapshot(&self) -> Snapshot {
        let age = now_ms().saturating_sub(self.updated_at_ms);
        let stale = self.updated_at_ms != 0 && age > STALE_AFTER_MS;
        Snapshot {
            status: if self.updated_at_ms == 0 {
                "pending"
            } else if stale {
                "stale"
            } else {
                "ready"
            },
            source: if self.live_at_ms != 0 {
                "live"
            } else if self.updated_at_ms != 0 {
                "cache"
            } else {
                "static"
            },
            total: self.zen.len(),
            exposed: self.list().len(),
            last_error: self.last_error.clone(),
        }
    }

    pub fn cache_path(&self) -> Option<&Path> {
        self.cache_path.as_deref()
    }

    /// 仅供测试注入：构造一份「目录数据已知」的状态，避免单测去打真实网络。
    #[cfg(test)]
    pub fn with_prices(prices: BTreeMap<String, Price>, zen: BTreeSet<String>) -> Self {
        let mut catalog = Self::new(None);
        catalog.prices = prices;
        catalog.prices_ready = true;
        catalog.zen = zen;
        catalog
    }
}

fn price_to_value(p: &Price) -> Value {
    serde_json::json!({
        "input": p.input,
        "output": p.output,
        "deprecated": p.deprecated,
        "reasoning": p.reasoning,
        "contextWindow": p.context_window,
        "maxTokens": p.max_tokens,
        "modalitiesInput": p.modalities_input,
        "effortValues": p.effort_values,
        "wire": p.wire.map(Wire::as_str),
    })
}

fn price_from_value(v: &serde_json::Map<String, Value>) -> Option<Price> {
    Some(Price {
        input: v.get("input").and_then(Value::as_f64),
        output: v.get("output").and_then(Value::as_f64),
        deprecated: v.get("deprecated").and_then(Value::as_bool).unwrap_or(false),
        reasoning: v.get("reasoning").and_then(Value::as_bool).unwrap_or(false),
        context_window: v.get("contextWindow").and_then(Value::as_f64).unwrap_or(262144.0),
        max_tokens: v.get("maxTokens").and_then(Value::as_f64).unwrap_or(32768.0),
        modalities_input: v
            .get("modalitiesInput")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
            .unwrap_or_default(),
        effort_values: v
            .get("effortValues")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
            .unwrap_or_default(),
        wire: v.get("wire").and_then(Value::as_str).and_then(Wire::from_str),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn price(input: Option<f64>, deprecated: bool) -> Price {
        Price {
            input,
            output: Some(0.0),
            deprecated,
            ..Default::default()
        }
    }

    #[test]
    fn 免费判定对齐桌面版() {
        let mut prices = BTreeMap::new();
        // 桌面版：!cost || cost.input === 0
        prices.insert("no-cost-data".to_string(), price(None, false));
        prices.insert("zero-input".to_string(), price(Some(0.0), false));
        // 只看 input，不看 output：output 非 0 也算免费
        prices.insert(
            "input0-output-priced".to_string(),
            Price { input: Some(0.0), output: Some(3.0), ..Default::default() },
        );
        prices.insert("paid".to_string(), price(Some(1.4), false));
        prices.insert("dead".to_string(), price(Some(0.0), true));

        for id in ["no-cost-data", "zero-input", "input0-output-priced"] {
            assert!(decide(id, &prices, true).allowed, "{id} 应判免费");
        }
        assert!(!decide("paid", &prices, true).allowed, "有价的不该判免费");
        // 回归：已下架的 mimo-v2.5-free 曾被误放进清单
        assert_eq!(decide("dead", &prices, true).source, "metadata_deprecated");
        assert!(!decide("dead", &prices, true).allowed, "下架模型必须硬否决");
    }

    #[test]
    fn 目录判定废弃时无论有无兜底都不复活() {
        let mut prices = BTreeMap::new();
        prices.insert("mimo-v2.5-free".to_string(), price(Some(0.0), true));
        prices.insert("muse-spark-1.2-contributor-free".to_string(), price(Some(0.0), true));
        prices.insert("big-pickle".to_string(), price(Some(0.0), false));

        // 有兜底快照时：废弃判定依然压过它（快照只用于"元数据缺失"路径）
        let mut catalog = ModelCatalog::new(None);
        catalog.prices = prices.clone();
        catalog.prices_ready = true;
        catalog.zen = ["mimo-v2.5-free", "muse-spark-1.2-contributor-free", "big-pickle"]
            .iter().map(|s| s.to_string()).collect();
        catalog.last_good_zen = catalog.zen.clone();
        let list = catalog.list();
        assert!(!list.contains(&"mimo-v2.5-free".to_string()), "下架的不该复活");
        assert!(!list.contains(&"muse-spark-1.2-contributor-free".to_string()), "下架的不该复活");
        assert!(list.contains(&"big-pickle".to_string()), "在架的应保留");

        // 无兜底快照时：只按废弃判定走
        let mut bare = ModelCatalog::new(None);
        bare.prices = prices;
        bare.prices_ready = true;
        bare.zen = catalog.zen.clone();
        let list2 = bare.list();
        assert_eq!(list2, vec!["big-pickle".to_string()]);
    }

    #[test]
    fn 没有任何数据源时返回空清单() {
        // 编译期写死名单已移除：没有实时清单、没有缓存、没有上次结果 → 空。
        // 宁可空着（用户看得见"没数据"），也不给一份会过期的假名单。
        let catalog = ModelCatalog::new(None);
        assert!(catalog.list().is_empty(), "无数据源时不该凭空造出清单");
    }

    #[test]
    fn 元数据缺失时只保留上次成功解析过的() {
        let mut catalog = ModelCatalog::new(None);
        catalog.zen = ["kept-free", "brand-new-free", "paid-x"]
            .iter().map(|s| s.to_string()).collect();
        catalog.last_good_zen = ["kept-free"].iter().map(|s| s.to_string()).collect();
        // prices_ready = false
        assert_eq!(catalog.list(), vec!["kept-free".to_string()]);
    }

    #[test]
    fn 线路按官方声明的_sdk_归类不看名字() {
        // openai-compatible 也含 openai 子串，必须先判精确的那个。
        assert_eq!(decode_wire(Some("@ai-sdk/openai")), Some(Wire::Responses));
        assert_eq!(decode_wire(Some("@ai-sdk/openai-compatible")), Some(Wire::Chat));
        assert_eq!(decode_wire(Some("@ai-sdk/anthropic")), Some(Wire::Unsupported));
        assert_eq!(decode_wire(None), None);
        assert_eq!(decode_wire(Some("  ")), None);

        // 名字像 chat 模型，但官方声明它走 responses：声明说了算。
        let mut prices = BTreeMap::new();
        prices.insert(
            "looks-like-chat-free".to_string(),
            Price { input: Some(0.0), wire: Some(Wire::Responses), ..Default::default() },
        );
        // 官方声明本工具代理不了的，不进任何一条道。
        prices.insert(
            "anthropic-shaped-free".to_string(),
            Price { input: Some(0.0), wire: Some(Wire::Unsupported), ..Default::default() },
        );
        let catalog = ModelCatalog::with_prices(
            prices,
            ["looks-like-chat-free", "anthropic-shaped-free"]
                .iter()
                .map(|s| s.to_string())
                .collect(),
        );
        assert_eq!(crate::zcode::lane_for("looks-like-chat-free", &catalog), Some(Wire::Responses));
        assert_eq!(crate::zcode::lane_for("anthropic-shaped-free", &catalog), None);
        // 目录没说话时才退回按名字猜。
        assert_eq!(crate::zcode::lane_for("muse-spark-x", &catalog), Some(Wire::Responses));
        assert_eq!(crate::zcode::lane_for("plain-free", &catalog), Some(Wire::Chat));
        assert_eq!(crate::zcode::lane_for("jev-something", &catalog), None);
    }

    #[test]
    fn 档位阶梯去掉上游不收的档位() {
        let p = Price {
            reasoning: true,
            effort_values: vec!["none".into(), "low".into(), "high".into(), "max".into(), "bogus".into()],
            ..Default::default()
        };
        assert_eq!(efforts_for(Some(&p)), vec!["low", "high", "max"]);
        // 不支持推理的模型没有档位
        assert!(efforts_for(Some(&Price::default())).is_empty());
        // 声明为空时给默认阶梯
        let empty = Price { reasoning: true, ..Default::default() };
        assert_eq!(efforts_for(Some(&empty)).len(), DEFAULT_EFFORT_LADDER.len());
    }
}

#[cfg(test)]
mod seed_tests {
    use super::*;

    #[test]
    fn 真实缓存文件能种子出完整元数据() {
        let path = "D:/Program/.zcode/v2/opencode2zcode-catalog.json";
        if !Path::new(path).exists() {
            return; // 机器上没有缓存就跳过
        }
        let mut catalog = ModelCatalog::new(Some(PathBuf::from(path)));
        // 只触发种子，不打网络：直接调内部的 seed 逻辑等价物
        catalog.seed_from_cache();
        assert!(catalog.prices_ready, "缓存里有 prices，seed 后 prices_ready 必须为 true");
        let sb = catalog.metadata("space-bunny-free");
        assert!(sb.is_some(), "space-bunny-free 应该在缓存里");
        let sb = sb.unwrap();
        assert_eq!(sb.context_window, 1048576.0, "缓存里的完整值应被读出，实际: {:?}", sb);
        assert_eq!(sb.effort_values.len(), 5, "space-bunny 应有 5 个档位");
        // 已下架模型必须带 deprecated 标记
        let dead = catalog.metadata("mimo-v2.5-free");
        assert!(dead.map(|p| p.deprecated).unwrap_or(false), "缓存里 mimo-v2.5-free 应标 deprecated");
    }
}

#[cfg(test)]
mod outage_tests {
    use super::*;

    #[test]
    fn 元数据缺失时只保留上次成功过的_不放未核实的新模型() {
        let mut catalog = ModelCatalog::new(None);
        // 事故现场：实时清单在（zen 有值），元数据一个都没有，也没有兜底快照
        catalog.zen = [
            "big-pickle",
            "mimo-v2.5-free",          // 目录里已下架，但名字带 free
            "made-up-future-free",     // 上游新加的、谁也没核实过
        ]
        .iter().map(|s| s.to_string()).collect();
        // 无兜底快照 → 只保留有元数据判定依据的（这里没有）→ 空
        // 静默开着，不写一份假配置。
        assert!(catalog.list().is_empty(), "无元数据无快照时不该造清单: {:?}", catalog.list());
    }

    #[test]
    fn 空prices绝不写缓存() {
        let dir = std::env::temp_dir().join("o2z-cache-guard");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("cache.json");
        // 先放一份好缓存
        std::fs::write(
            &path,
            r#"{"version":1,"updatedAt":1,"zen":["big-pickle"],"prices":[["big-pickle",{"input":0,"output":0,"deprecated":false,"reasoning":true,"contextWindow":1,"maxTokens":1,"modalitiesInput":[],"effortValues":[]}]]}"#,
        )
        .unwrap();
        let mut catalog = ModelCatalog::new(Some(path.clone()));
        catalog.refresh_once("http://127.0.0.1:1"); // 两个源都不可达
        let after = std::fs::read_to_string(&path).unwrap();
        assert!(after.contains("\"prices\":[[") , "好缓存不许被空prices覆盖: {}", after);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn seed失败后下次刷新会重试() {
        // 直接测 seed 语义本身，不碰网络（refresh_once 里的 models.dev 是
        // 真实地址，可达与否随网络波动，不适合做断言依据）。
        let dir = std::env::temp_dir().join("o2z-seed-retry");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("cache.json");
        std::fs::write(&path, "not json at all").unwrap(); // 坏缓存
        let mut catalog = ModelCatalog::new(Some(path.clone()));
        catalog.seed_from_cache();
        assert!(!catalog.prices_ready, "坏缓存不应种子出元数据");
        // 模拟坏缓存被修好（比如另一个健康实例写回了好数据）
        std::fs::write(
            &path,
            &format!(r#"{{"version":1,"updatedAt":{},"zen":["big-pickle"],"prices":[["big-pickle",{{"input":0,"output":0,"deprecated":false,"reasoning":true,"contextWindow":1,"maxTokens":1,"modalitiesInput":[],"effortValues":[]}}]]}}"#, now_ms()),
        )
        .unwrap();
        catalog.seed_from_cache();
        assert!(catalog.prices_ready, "seed 失败不该判死刑，下次要重试");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
