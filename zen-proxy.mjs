#!/usr/bin/env node
/**
 * opencode2zcode — 把 OpenCode Zen 的匿名免费模型接进 ZCode。
 *
 * 移植自 JasonYu0822/opencode2pi-desktop 的 lib/zen.js + main.js（MIT）。
 * 那边的伪装细节又来自 FishBottle7/opencode2dsh 与 jasonxu114514/opencode2api。
 * 这里保留的是：CLI 一致的伪装头、规范形状的 ses_ 会话 id、免费通道体门禁、
 * reasoning_effort 归一、S1∩S2 模型目录、SSE 逐块透传、磁盘目录缓存。
 * 有意不移植：IP 池 / 代理轮换子系统、Go sidecar。
 *
 * 为什么不能用 ZCode 插件做：
 *   ZCode 的 .zcode-plugin/plugin.json 只能贡献 skills / commands / hooks /
 *   mcpServers，既没有 pi-desktop 的 contributes.providers（宿主静态声明
 *   provider），也没有 contributes.services（常驻回环服务）。所以这里改成
 *   ZCode 官方支持的那条路：本进程跑回环代理，并把 provider 声明写进 ZCode 的
 *   「个人 Provider 配置」{~}/.zcode/v2/provider_config.json。ZCode 对该文件
 *   每 1 秒轮询一次，改完热生效，不用重启。
 *
 * 用法：
 *   node zen-proxy.mjs                 # 起代理 + 写配置
 *   node zen-proxy.mjs --print-config  # 只打印将要写入的配置，不落盘不起服务
 *   node zen-proxy.mjs --write-config-only
 *   node zen-proxy.mjs --port 41930 --config <path>
 */

import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

/**
 * 本脚本所在目录；旁路文件与配置定位都相对它。
 *
 * 要同时兼容三种形态：ESM 源码直跑、打成单文件 exe（SEA 里 import.meta 是空
 * 对象，esbuild 的 CJS 兜底也给不出 url）、以及被 SEA 塞进 exe 的 CJS 包。
 * SEA 里 __dirname 正好等于 exe 所在目录，所以拿它当兜底最省事。
 */
function resolveScriptDir(metaUrl, dirnameFallback) {
  if (typeof metaUrl === 'string' && metaUrl.length > 0) {
    try {
      return path.dirname(fileURLToPath(metaUrl));
    } catch {
      /* 落到下面 */
    }
  }
  if (typeof dirnameFallback === 'string' && dirnameFallback.length > 0) return dirnameFallback;
  return process.cwd();
}

// eslint-disable-next-line no-undef
const SCRIPT_DIR = resolveScriptDir(import.meta?.url, typeof __dirname === 'string' ? __dirname : '');

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 上游根地址；可用 ZEN_BASE_URL 覆盖（指向自建网关或本地 mock 便于自测）。 */
const ZEN_BASE_URL = (process.env.ZEN_BASE_URL?.trim() || 'https://opencode.ai/zen').replace(
  /\/+$/,
  '',
);
const METADATA_URL = 'https://models.dev/api.json';
// OpenCode 官方机器可读目录，和 models.dev 是同一份数据的两个镜像。
// 线路判定以它为准（每个模型自带 provider.npm），models.dev 只是镜像兜底。
const CAPABILITIES_URL = 'https://models.opencode.ai/api.json';

/** 匿名通道的固定 Bearer，不是密钥，PI-Desktop 那边也一样写死。 */
const ANONYMOUS_KEY = 'public';

/** 伪装成哪个版本的官方 CLI。上游若收紧，改这里。 */
const OPENCODE_CLIENT_VERSION = '1.18.31';

const DEFAULT_PORT = 41930;
const PORT_CANDIDATES = [DEFAULT_PORT, 41931, 41932, 41933];

const CATALOG_TIMEOUT_MS = 30_000;
const CATALOG_REFRESH_MS = 300_000;
const CATALOG_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const UPSTREAM_HEADER_TIMEOUT_MS = 60_000;

/** 上游因 body 不合规拒绝时的状态码；命中则摘掉 reasoning_effort 重试一次。 */
const RETRY_WITHOUT_EFFORT_STATUSES = [400, 422, 500];

const PROVIDER_ID = 'opencode-free';
const PROVIDER_NAME = 'OpenCode 免费模型';
const RESPONSES_PROVIDER_ID = 'opencode-free-responses';
const RESPONSES_PROVIDER_NAME = 'OpenCode 免费模型 · Responses';

const CACHE_FILE_NAME = 'opencode2zcode-catalog.json';

/**
 * 断网兜底不再用编译期写死的名单：那份名单随上游增减而陈旧，写进代码等于
 * 让程序永远按某个历史快照说话。拿不到实时数据时，用磁盘缓存里最近一次
 * 成功解析的结果顶上；缓存也没有就先空着，不编造。
 */

// ---------------------------------------------------------------------------
// 关联 id + 伪装头（对应 ids.ts）
// ---------------------------------------------------------------------------

const CANONICAL_SESSION_PATTERN = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const BASE62_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function base62Fixed(value, width) {
  const base = 62n;
  let n = value;
  const out = new Array(width);
  for (let i = width - 1; i >= 0; i -= 1) {
    out[i] = BASE62_ALPHABET.charAt(Number(n % base));
    n /= base;
  }
  return out.join('');
}

/** sha256("prefix\0value") 取前 12 字节，稳定且不可逆。 */
function stableID(prefix, value) {
  const sum = createHash('sha256').update(`${prefix}\x00${value}`).digest();
  return `${prefix}_${sum.subarray(0, 12).toString('hex')}`;
}

function randomID(prefix, size) {
  return `${prefix}_${randomBytes(size).toString('hex')}`;
}

/** 会话信号 = 第一条 user 消息内容的 JSON，同一对话恒定。 */
function conversationSeed(messages) {
  for (const message of messages || []) {
    if (!message || message.role !== 'user') continue;
    const encoded = JSON.stringify(message.content ?? null);
    if (encoded !== 'null' && encoded.length > 0) return encoded;
  }
  return '';
}

/** 免费通道只认 ses_+12hex+14base62 的形状，别的都确定性哈希进去。 */
function canonicalSessionID(signal) {
  if (CANONICAL_SESSION_PATTERN.test(signal)) return signal;
  const sum = createHash('sha256').update(`ses\x00${signal}`).digest();
  const timePart = sum.subarray(0, 6).toString('hex');
  const randomPart = base62Fixed(BigInt(`0x${sum.subarray(6, 16).toString('hex')}`), 14);
  return `ses_${timePart}${randomPart}`;
}

function deriveRequestIDs(messages) {
  let signal = conversationSeed(messages);
  if (signal === '' || signal === '{}') signal = randomID('fallback', 16);
  return {
    session: canonicalSessionID(signal),
    request: randomID('req', 16),
    project: stableID('prj', 'opencode2zcode:default-project'),
  };
}

function opencodeUserAgent() {
  return `opencode/${OPENCODE_CLIENT_VERSION} (${process.platform} ${process.arch}; node${process.versions.node})`;
}

/** 每次上游请求都带的完整伪装头。 */
function disguiseHeaders(ids) {
  return {
    'user-agent': opencodeUserAgent(),
    'x-opencode-client': 'cli',
    'x-opencode-session': ids.session,
    'x-session-affinity': ids.session,
    'X-Session-Id': ids.session,
    'x-opencode-request': ids.request,
    'x-opencode-project': ids.project,
  };
}

/**
 * chat 与 responses 两种线格式都归一到同一份关联 id：
 * chat 看 messages，responses 看 input（字符串或 item 数组）。
 */
function deriveRequestIDsFromWire(body) {
  if (body && Array.isArray(body.messages)) return deriveRequestIDs(body.messages);
  const input = body && body.input;
  if (typeof input === 'string') return deriveRequestIDs([{ role: 'user', content: input }]);
  if (Array.isArray(input)) {
    const messages = input
      .map((item) => {
        if (typeof item === 'string') return { role: 'user', content: item };
        if (!item || typeof item !== 'object') return null;
        const role = item.role === 'assistant' ? 'assistant' : 'user';
        const content =
          typeof item.content === 'string'
            ? item.content
            : Array.isArray(item.content)
              ? item.content.map((part) => (part && typeof part.text === 'string' ? part.text : '')).join('')
              : typeof item.text === 'string'
                ? item.text
                : '';
        return { role, content };
      })
      .filter(Boolean);
    return deriveRequestIDs(messages);
  }
  return deriveRequestIDs([]);
}

// ---------------------------------------------------------------------------
// 免费通道体门禁（对应 messages.ts）
// ---------------------------------------------------------------------------

/** 实测：匿名通道对不流式、或缺 bash/read 函数工具的 chat 请求直接 403。 */
const FREE_LANE_GATE_TOOL_NAMES = ['bash', 'read'];

/** 门禁工具的描述与参数：描述和参数上游不检查，两种线格式统一用同一份文案。 */
const GATE_DESCRIPTION = 'Reserved for the host runtime; do not call it.';

/** chat/completions 的线格式：工具定义嵌在 `function` 里。 */
function freeLaneGateToolChat(name) {
  return {
    type: 'function',
    function: { name, description: GATE_DESCRIPTION, parameters: { type: 'object', properties: {} } },
  };
}

/** responses 的线格式：**扁平**，`name` 直接挂在工具上。
 *  套错格式会被上游判 400（tools[0] missing required field name）。 */
function freeLaneGateToolResponses(name) {
  return { type: 'function', name, description: GATE_DESCRIPTION, parameters: { type: 'object', properties: {} } };
}

/**
 * 补齐缺失的门禁工具。
 *
 * chat 道：原本一个工具都没有时补 tool_choice:"none"，免得模型真去调这两个
 * 占位桩。
 * responses 道：**绝对不能碰 tool_choice**。那个端点只接受 "auto" /
 * "required" / 具体工具名，给 "none" 会直接 400。踩过的坑——最早判定
 * 「responses 道没救」就是因为照搬了 chat 道的 tool_choice:"none"，
 * 而它恰好是致命的那个。
 */
function ensureFreeLaneShape(body, lane) {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const nameOf = (tool) => {
    if (!tool || typeof tool !== 'object') return undefined;
    if (lane === 'responses') return tool.name ?? (tool.function && tool.function.name);
    return (tool.function && tool.function.name) ?? tool.name;
  };
  const names = new Set(tools.map(nameOf));
  const missing = FREE_LANE_GATE_TOOL_NAMES.filter((name) => !names.has(name));
  const next = { ...body };

  if (missing.length > 0) {
    const build = lane === 'responses' ? freeLaneGateToolResponses : freeLaneGateToolChat;
    next.tools = [...tools, ...missing.map(build)];
    if (tools.length === 0 && lane === 'chat') next.tool_choice = 'none';
  }
  if (lane === 'responses' && next.tool_choice === 'none') delete next.tool_choice;
  return next;
}

// ---------------------------------------------------------------------------
// 思考档位归一
// ---------------------------------------------------------------------------

/** 上游确实会接受的「主动思考」档位。off/none 不在其中，见下。 */
const ACCEPTED_EFFORT_LADDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const DEFAULT_EFFORT_LADDER = ['minimal', 'low', 'medium', 'high'];

/**
 * 实测（2026-10，逐模型探测）上游的档位并不统一：
 *   big-pickle      off/none=400，minimal…max=200
 *   space-bunny     off/none=400，minimal/high/max=200
 *   nemotron-3.5    off=400，none/minimal/high/max=200
 *   mimo-v2.5       off=500，none/high=200（minimal/max 时好时坏，上游抖动）
 * 原项目当时把 off/缺失/未知一律写成 "none"，今天这样会直接把请求打成 400，
 * 所以这里改成：只透传上游确实认的主动档位；off / none / 缺失 / 未知一律
 * **省略该字段**，退回厂商默认（这些免费模型基本都是 always-think，
 * 本来也没有可靠的办法真正关掉思考）。handleUpstream 里还有一次摘字段重试兜底。
 */
function upstreamEffort(hostValue) {
  if (hostValue === undefined || hostValue === null || hostValue === '') return undefined;
  return ACCEPTED_EFFORT_LADDER.includes(hostValue) ? hostValue : undefined;
}

/** 从 models.dev 的 reasoning_options 推出 UI 档位阶梯（去掉上游不收的 off/none）。 */
function effortsFor(capability) {
  if (!capability || !capability.reasoning) return [];
  const declared = [];
  for (const value of capability.effortValues || []) {
    const level = value === 'none' ? 'off' : value;
    if (ACCEPTED_EFFORT_LADDER.includes(level) && !declared.includes(level)) declared.push(level);
  }
  if (declared.length === 0) return DEFAULT_EFFORT_LADDER.slice();
  return declared.sort(
    (a, b) => ACCEPTED_EFFORT_LADDER.indexOf(a) - ACCEPTED_EFFORT_LADDER.indexOf(b),
  );
}

/**
 * 把宿主发来的 chat 体整理成免费通道能收的形状：强制流式、透传受支持的思考
 * 档位（否则不带这个字段）、再套门禁。其余原样转发。
 */
function buildUpstreamBody(hostBody, lane) {
  const source = hostBody && typeof hostBody === 'object' ? hostBody : {};
  const body = { ...source, stream: true };
  const effort = upstreamEffort(source.reasoning_effort);
  if (effort === undefined) {
    delete body.reasoning_effort;
  } else {
    body.reasoning_effort = effort;
  }
  return ensureFreeLaneShape(body, lane);
}

// ---------------------------------------------------------------------------
// 模型目录（对应 catalog.ts）
// ---------------------------------------------------------------------------

function isFreeModel(model) {
  return String(model).toLowerCase().includes('free');
}

function metadataDeprecated(model) {
  if (model.deprecated === true) return true;
  const status = String(model.status ?? model.lifecycle ?? '').toLowerCase();
  if (status === 'deprecated' || status === 'retired' || status === 'disabled') return true;
  return model.deprecated_at != null || model.retirement_date != null;
}

/**
 * 官方目录里的 SDK 包名 → 线格式。
 * `@ai-sdk/openai` 是 responses，`openai-compatible` 是 chat，两者必须先判
 * 精确的那个——后者也含 `openai` 子串。anthropic 等本工具没有对应的道。
 */
function decodeWire(npm) {
  const value = String(npm ?? '').trim().toLowerCase();
  if (value.length === 0) return undefined;
  if (value === '@ai-sdk/openai' || value.endsWith('/openai')) return 'responses';
  if (value.includes('openai-compatible')) return 'chat';
  return 'unsupported';
}

function decodeEffortValues(raw) {
  if (!Array.isArray(raw)) return { effortValues: [] };
  const values = [];
  for (const option of raw) {
    if (!option || typeof option !== 'object') continue;
    if (option.type !== 'effort' || !Array.isArray(option.values)) continue;
    for (const value of option.values) {
      if (typeof value === 'string' && value.length > 0 && !values.includes(value)) values.push(value);
    }
  }
  return { effortValues: values };
}

/** models.dev 的 OpenCode 段 → Map(modelId → 元数据)。 */
function decodeModelsDev(data) {
  const result = new Map();
  if (!data || typeof data !== 'object') return result;
  const rank = (key) => {
    const lower = key.toLowerCase();
    if (lower === 'opencode' || lower === 'opencode-zen' || lower === 'opencode_zen') return 0;
    if (lower.includes('opencode')) return 1;
    return 2;
  };
  const keys = Object.keys(data).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  for (const key of keys) {
    if (rank(key) > 1) continue;
    const provider = data[key];
    if (!provider || typeof provider !== 'object') continue;
    if (rank(key) === 1) {
      const identity = `${provider.id ?? ''} ${provider.name ?? ''}`.toLowerCase().trim();
      if (!identity.includes('opencode')) continue;
    }
    const models = provider.models;
    if (!models || typeof models !== 'object') continue;
    for (const [modelKey, raw] of Object.entries(models)) {
      if (!raw || typeof raw !== 'object') continue;
      const modelId = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : modelKey;
      const cost = raw.cost ?? {};
      const limit = raw.limit ?? {};
      const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
      result.set(modelId, {
        input: num(cost.input),
        output: num(cost.output),
        deprecated: metadataDeprecated(raw),
        reasoning: raw.reasoning === true,
        contextWindow: num(limit && limit.context) ?? 262144,
        maxTokens: num(limit && limit.output) ?? 32768,
        modalitiesInput: Array.isArray(raw.modalities && raw.modalities.input)
          ? raw.modalities.input.map(String)
          : [],
        // 逐模型的 npm 覆盖段级默认；没有逐模型声明就走段级（chat）。
        wire: decodeWire(raw.provider?.npm ?? provider.npm),
        ...decodeEffortValues(raw.reasoning_options),
      });
    }
    if (result.size > 0) return result;
  }
  return result;
}

/**
 * 是否免费——与 OpenCode 桌面版逐位对齐。桌面版的判定就一行
 * （packages/app/src/components/dialog-select-model.tsx）：
 *
 *   isFree = provider === "opencode" && (!cost || cost.input === 0)
 *
 * 两处容易踩的细节：
 *   1. 只看 input，**不看 output**；并且「没有 cost 数据」也算免费。
 *      早先这里要求 input 和 output 都为 0，比桌面版严，会漏掉模型。
 *   2. 桌面版还会排除 status 为 deprecated 的条目。Zen 把下架模型留在公开
 *      /models 和目录里（标价仍是 0），不排除的话模型选择器里会出现点下去
 *      必报错的选项——实测 mimo-v2.5-free、muse-spark-1.2-contributor-free
 *      就是这样被误放进来的。
 */
function decide(model, prices, ready) {
  const nameFree = isFreeModel(model);
  const fallback = (source) =>
    nameFree ? { allowed: true, source: 'name_free', known: false } : { allowed: false, source, known: false };
  if (!ready || prices.size === 0) return fallback('metadata_pending');
  const price = prices.get(model);
  // 目录里查无此模型：不按名字放行。实时清单里混着大量名字带 free 的
  // 付费或未核实模型，名字兜底只在「整份元数据都没拉到」时才有意义。
  if (!price) return { allowed: false, source: 'metadata_model_missing', known: false };
  // 废弃是硬否决，后面的兜底也不许把它捞回来。
  if (price.deprecated) return { allowed: false, source: 'metadata_deprecated', known: true };
  if (price.input === undefined || price.input === 0) {
    return { allowed: true, source: nameFree ? 'name_and_metadata_free' : 'metadata_free', known: true };
  }
  return { allowed: false, source: 'metadata_paid', known: true };
}

async function withTimeout(promise, ms, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** S1：带伪装头拉 Zen 的实时目录。 */
async function fetchZenModels(fetchImpl) {
  const response = await withTimeout(
    fetchImpl(`${ZEN_BASE_URL}/v1/models`, {
      headers: {
        authorization: `Bearer ${ANONYMOUS_KEY}`,
        'user-agent': opencodeUserAgent(),
        'x-opencode-client': 'cli',
        accept: 'application/json',
      },
    }),
    CATALOG_TIMEOUT_MS,
    'models catalog fetch',
  );
  if (!response.ok) throw new Error(`models endpoint returned HTTP ${response.status}`);
  const payload = await response.json();
  const models = [];
  for (const item of payload && payload.data ? payload.data : []) {
    if (item && typeof item.id === 'string' && item.id.length > 0) models.push(item.id);
  }
  if (models.length === 0) throw new Error('models endpoint returned an empty list');
  return models;
}

class ModelCatalog {
  #fetchImpl;
  #onChange;
  #cachePath;
  #cacheState = null;
  #cacheSeeded = false;
  #liveAt = 0;
  #changeKey = '';
  #zen = new Set();
  #updatedAt = 0;
  #prices = new Map();
  #pricesReady = false;
  /** 最近一次成功解析出来的清单与价格（内存快照）。编译期名单已移除。 */
  #lastGoodZen = new Set();
  #lastGoodPrices = new Map();
  /** 上次拉到的目录 ETag，下次带 If-None-Match，没变就回 304。 */
  #metadataEtag = null;
  #lastError = '';
  #timer = null;
  #stopped = false;
  #refreshing = false;

  constructor(fetchImpl, onChange, options = {}) {
    this.#fetchImpl = fetchImpl;
    this.#onChange = typeof onChange === 'function' ? onChange : null;
    this.#cachePath = typeof options.cachePath === 'string' && options.cachePath.length > 0 ? options.cachePath : null;
  }

  /** 先读盘播种，离线启动也能保住上次的真实清单，不退化成静态兜底。 */
  #seedFromCache() {
    // 种子失败不判死刑：prices 始终为空的进程会一辈子写出没有思考档位的
    // 裸配置。没拿到元数据就撤掉标记，让下一次刷新重试（与 Rust 版一致）。
    if (this.#cacheSeeded && this.#pricesReady) return;
    this.#cacheSeeded = true;
    if (!this.#cachePath) return;
    let raw = null;
    try {
      raw = JSON.parse(fs.readFileSync(this.#cachePath, 'utf8'));
    } catch {
      return;
    }
    if (!raw || raw.version !== 1) return;
    if (!Number.isFinite(raw.updatedAt) || Date.now() - raw.updatedAt > CATALOG_CACHE_TTL_MS) return;
    const ids = Array.isArray(raw.zen) ? raw.zen.filter((id) => typeof id === 'string' && id.length > 0) : [];
    const prices = Array.isArray(raw.prices) ? new Map(raw.prices) : new Map();
    if (ids.length === 0 && prices.size === 0) return;
    if (ids.length > 0) {
      this.#zen = new Set(ids);
      this.#updatedAt = raw.updatedAt;
    }
    if (prices.size > 0) {
      this.#prices = prices;
      this.#lastGoodPrices = new Map(prices);
      this.#pricesReady = true;
      // 缓存里清单和元数据是同一次写出来的，两者都在才构成可信快照。
      if (ids.length > 0) this.#lastGoodZen = new Set(ids);
    }
    this.#cacheState = { fingerprint: this.#cacheFingerprint() };
  }

  #cachePayload() {
    const sortPairs = (pairs) => [...pairs].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return { zen: [...this.#zen].sort(), prices: sortPairs(this.#prices.entries()) };
  }

  #cacheFingerprint() {
    const payload = this.#cachePayload();
    return JSON.stringify([payload.zen, payload.prices]);
  }

  /** 只有数据真的变了才落盘，避免每 5 分钟白写一次。 */
  #saveCache() {
    if (!this.#cachePath) return;
    // 空 prices 覆盖好缓存 = 自我中毒循环：种子失败→写坏缓存→以后每次重启
    // 都从坏缓存种子。没有元数据就别动缓存（与 Rust 版一致）。
    if (this.#prices.size === 0) return;
    const fingerprint = this.#cacheFingerprint();
    if (this.#cacheState && this.#cacheState.fingerprint === fingerprint) return;
    try {
      const payload = { version: 1, updatedAt: Date.now(), ...this.#cachePayload() };
      const temporary = `${this.#cachePath}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(payload), 'utf8');
      fs.renameSync(temporary, this.#cachePath);
      this.#cacheState = { fingerprint };
    } catch {
      // 缓存写不进去不是致命问题，实时目录照常工作。
    }
  }

  async start() {
    this.#stopped = false;
    await this.refreshOnce();
    let attempts = 0;
    while (this.#zen.size === 0 && attempts < 4 && !this.#stopped) {
      attempts += 1;
      await new Promise((resolve) => setTimeout(resolve, 15_000));
      if (this.#stopped) return;
      await this.refreshOnce();
    }
    if (this.#stopped) return;
    this.#timer = setInterval(() => void this.refreshOnce(), CATALOG_REFRESH_MS);
    if (this.#timer.unref) this.#timer.unref();
  }

  stop() {
    this.#stopped = true;
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  async refreshOnce() {
    if (this.#refreshing) return;
    this.#refreshing = true;
    try {
      this.#seedFromCache();
      await Promise.allSettled([this.#refreshZen(), this.#refreshMetadata()]);
      this.#saveCache();
      // 只在暴露清单真的变了时回调一次，重复刷新保持安静。
      const exposed = this.list();
      // 快照记「这次真的被放行的」，而不是整份实时清单。实时清单里混着
      // 付费和未核实的模型，整份记下来会在元数据抖动时被原样放行。
      if (exposed.length > 0) this.#lastGoodZen = new Set(exposed);
      const key = exposed.join('|');
      if (key !== this.#changeKey) {
        const first = this.#changeKey === '';
        this.#changeKey = key;
        if (!first && this.#onChange) {
          try {
            this.#onChange();
          } catch {
            /* 回调绝不能弄坏刷新 */
          }
        }
      }
    } finally {
      this.#refreshing = false;
    }
  }

  async #refreshZen() {
    try {
      const ids = await fetchZenModels(this.#fetchImpl);
      // 空清单不覆盖：上游抖动回了空 body 时，保住上一次的结果。
      if (ids.length === 0) return;
      this.#zen = new Set(ids);
      this.#updatedAt = Date.now();
      this.#liveAt = this.#updatedAt;
      this.#lastError = '';
    } catch (err) {
      this.#lastError = err && err.message ? err.message : String(err);
    }
  }

  /**
   * 拉元数据。优先官方目录（models.opencode.ai），它带每个模型的 provider.npm，
   * 线路判定靠它；拉不到再退回 models.dev 镜像。两者形状相同，同一套解析。
   * 带上上次的 ETag：目录没变就回 304，不再重下那 5MB。
   */
  async #refreshMetadata() {
    const sources = [CAPABILITIES_URL, METADATA_URL];
    let lastError = null;
    for (const url of sources) {
      try {
        const headers = { accept: 'application/json' };
        if (this.#metadataEtag) headers['if-none-match'] = this.#metadataEtag;
        const response = await withTimeout(
          this.#fetchImpl(url, { headers }),
          CATALOG_TIMEOUT_MS,
          'model metadata fetch',
        );
        if (response.status === 304) return;
        if (!response.ok) throw new Error(`metadata endpoint returned HTTP ${response.status}`);
        const prices = decodeModelsDev(await response.json());
        if (prices.size === 0) throw new Error('metadata contains no OpenCode models');
        this.#prices = prices;
        this.#lastGoodPrices = new Map(prices);
        this.#pricesReady = true;
        this.#liveAt = Date.now();
        this.#metadataEtag = response.headers.get('etag') || this.#metadataEtag;
        return;
      } catch (err) {
        lastError = err && err.message ? err.message : String(err);
      }
    }
    if (!this.#pricesReady && lastError) this.#lastError = lastError;
  }

  decision(model) {
    const metadata = decide(model, this.#prices, this.#pricesReady);
    if (metadata.allowed) return metadata;
    // 目录已明确判定废弃时，S3 静态清单不再把它捞回来——那正是早先多出
    // mimo-v2.5-free / muse-spark-1.2-contributor-free 的原因。S3 只兜「还说不准」。
    if (metadata.source === 'metadata_deprecated') return metadata;
    if (!metadata.known && this.#lastGoodZen.has(model)) {
      return { allowed: true, source: 'static_verified', known: false };
    }
    return metadata;
  }

  /**
   * 暴露的 id：S1 ∩ 允许；数据不可用时用**最近一次成功解析的结果**。
   * 「名字带 free 就放行」会把已下架模型放进来（点下去必报错）——宁可少暴露。
   * 编译期写死的名单已移除：它随上游增减而陈旧，正是要消除的那类误导。
   */
  list() {
    if (this.#zen.size === 0) return [...this.#lastGoodZen].sort();
    if (!this.#pricesReady) {
      // 元数据缺失：只保留"上次成功解析过、且此刻仍在实时清单里"的。
      return [...this.#zen].filter((m) => this.#lastGoodZen.has(m)).sort();
    }

    const out = [];
    for (const model of this.#zen) {
      if (this.decision(model).allowed) out.push(model);
    }
    return out.sort();
  }

  reasoningCapability(model) {
    const price = this.#prices.get(model);
    if (!price) return undefined;
    return { reasoning: price.reasoning === true, effortValues: price.effortValues ?? [] };
  }

  metadata(model) {
    return this.#prices.get(model);
  }

  snapshot() {
    const age = this.#updatedAt === 0 ? Infinity : Date.now() - this.#updatedAt;
    const stale = this.#updatedAt !== 0 && age > 10 * 60 * 1000;
    return {
      status: this.#updatedAt === 0 ? 'pending' : stale ? 'stale' : 'ready',
      source: this.#liveAt !== 0 ? 'live' : this.#updatedAt !== 0 ? 'cache' : 'static',
      total: this.#zen.size,
      exposed: this.list().length,
      lastError: this.#lastError,
    };
  }
}

// ---------------------------------------------------------------------------
// 分道与元数据
// ---------------------------------------------------------------------------

/**
 * 这个模型走哪条线。优先信官方目录里它自己声明的 SDK：`@ai-sdk/openai`
 * 走 responses，`openai-compatible` 走 chat，anthropic 等本工具代理不了。
 * 目录没说话时才退回按名字猜——muse-spark 走 responses，jev 走本工具没有的
 * systemone 道，其余当 chat。
 */
function laneFor(id, catalog) {
  const declared = catalog.metadata(id)?.wire;
  if (declared === 'unsupported') return null;
  if (declared === 'chat' || declared === 'responses') return declared;
  const value = String(id ?? '').toLowerCase();
  if (value.length === 0 || value.startsWith('jev')) return null;
  if (value.startsWith('muse-spark')) return 'responses';
  return 'chat';
}

/**
 * models.dev 元数据 → 声明条目。
 *
 * 元数据拿不到时给中性默认。这里**不**放编译期写死的实测表——那份表会随上游增减
 * 而陈旧，写进代码等于让程序永远按某个历史快照说话。真实档位来自上游的
 * reasoning_options，写死一份反而会在上游改档位时变成误导。
 */
function catalogEntry(id, catalog) {
  const meta = catalog.metadata(id);
  if (!meta) {
    return { id, contextWindow: 262144, maxTokens: 32768, supportsImages: false, thinkingLevels: [] };
  }
  return {
    id,
    contextWindow: meta.contextWindow,
    maxTokens: meta.maxTokens,
    supportsImages: Array.isArray(meta.modalitiesInput) ? meta.modalitiesInput.includes('image') : false,
    thinkingLevels: effortsFor(catalog.reasoningCapability(id)),
  };
}

function chatModelEntries(catalog) {
  const out = [];
  for (const id of catalog.list()) {
    if (laneFor(id, catalog) !== 'chat') continue;
    out.push(catalogEntry(id, catalog));
  }
  return out;
}

function responsesModelEntries(catalog) {
  const out = [];
  for (const id of catalog.list()) {
    if (laneFor(id, catalog) !== 'responses') continue;
    out.push(catalogEntry(id, catalog));
  }
  return out;
}

// ---------------------------------------------------------------------------
// ZCode 个人 Provider 配置
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 定位 ZCode 的数据目录（这个包要能在别人的电脑上跑，所以不能写死路径）
// ---------------------------------------------------------------------------

const SIDECAR_FILE_NAME = 'zcode-data-dir.txt';

/**
 * 个人 Provider 配置的落点，与 ZCode 的 getAppConfigDir() 一致：
 *   {ZCODE_DATA_BASE_DIR}/.zcode/v2/provider_config.json
 *
 * 麻烦点在于 ZCODE_DATA_BASE_DIR **不是持久环境变量**——注册表里没有，
 * 只是 ZCode 启动自己子进程时注入的。从资源管理器双击 .cmd 拿不到它，
 * 于是会静默落到用户主目录，而 ZCode 读的是另一个目录，设置里就不出现分组。
 *
 * 所以这里改为主动探测：给若干个「可能是 ZCode 数据根」的候选目录打分，
 * 拿得分最高的那个。判据是 {root}/v2/runtime —— ZCode 准备运行资源时会建它。
 */
function candidateZcodeRoots() {
  const out = [];
  const push = (value) => {
    if (!value) return;
    let resolved;
    try {
      resolved = path.resolve(value);
    } catch {
      return;
    }
    if (!out.includes(resolved)) out.push(resolved);
  };

  // 环境变量最权威（AI 在 ZCode 自己终端里跑时一定有）。
  const envBase = process.env.ZCODE_DATA_BASE_DIR?.trim();
  if (envBase) push(path.join(envBase, '.zcode'));
  push(path.join(os.homedir(), '.zcode'));

  // 再扫各固定盘：盘根、以及盘根下一层目录。够覆盖 ZCODE_DATA_BASE_DIR 被改到
  // 别的盘/别的目录的情况，成本也就是几百次 existsSync。
  const CAP = 500;
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    if (out.length >= CAP) break;
    const root = `${letter}:\\`;
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue; // 盘不存在或不可读
    }
    push(path.join(root, '.zcode'));
    for (const entry of entries) {
      if (out.length >= CAP) break;
      if (!entry.isDirectory()) continue;
      push(path.join(root, entry.name, '.zcode'));
    }
  }
  return out;
}

/** 给一个候选 .zcode 根打分；runtime 是最强信号。 */
function scoreZcodeRoot(root) {
  const appConfigDir = path.join(root, 'v2');
  let score = 0;
  const evidence = [];
  if (fs.existsSync(path.join(appConfigDir, 'runtime'))) {
    score += 4;
    evidence.push('v2/runtime');
  }
  if (fs.existsSync(path.join(appConfigDir, 'provider_config.json'))) {
    score += 2;
    evidence.push('v2/provider_config.json');
  }
  let newest = 0;
  for (const name of ['tasks-index.sqlite', 'setting.json', 'config.json']) {
    try {
      newest = Math.max(newest, fs.statSync(path.join(appConfigDir, name)).mtimeMs);
    } catch {
      /* 缺这个文件不算问题 */
    }
  }
  if (newest > 0) evidence.push(`v2 最近写入 ${new Date(newest).toISOString()}`);
  return { root, baseDir: path.dirname(root), appConfigDir, score, evidence, newest };
}

/** 全部候选，按分数降序；给 --detect 看明细用。 */
function rankZcodeRoots() {
  return candidateZcodeRoots()
    .map(scoreZcodeRoot)
    .sort((a, b) => b.score - a.score || b.newest - a.newest);
}

/** 拿得分最高的候选；只有带 runtime 的（score >= 4）才算认得出来。 */
function detectZcodeDataDir() {
  const best = rankZcodeRoots()[0];
  return best && best.score >= 4 ? best : null;
}

/** 旁路文件：把探测到的数据目录记下来，供 .cmd 双击时读取。 */
function sidecarPath() {
  return path.join(SCRIPT_DIR, SIDECAR_FILE_NAME);
}

function writeSidecar(baseDir) {
  try {
    const target = sidecarPath();
    if (fs.existsSync(target) && fs.readFileSync(target, 'utf8').trim() === baseDir) return;
    fs.writeFileSync(target, `${baseDir}\n`, 'utf8');
  } catch {
    // 脚本目录可能只读；写不进去不影响本次运行。
  }
}

function readSidecar() {
  try {
    const value = fs.readFileSync(sidecarPath(), 'utf8').trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/** 决定配置写到哪里：显式 --config > 环境变量 > 探测 > 旁路文件 > 用户主目录。 */
function resolveConfigTarget(explicitPath) {
  if (explicitPath) {
    return { configPath: explicitPath, source: 'explicit', detail: null };
  }
  const appConfigFileName = 'provider_config.json';

  const envBase = process.env.ZCODE_DATA_BASE_DIR?.trim();
  if (envBase) {
    const root = path.join(envBase, '.zcode');
    return {
      configPath: path.join(root, 'v2', appConfigFileName),
      source: 'env',
      detail: scoreZcodeRoot(root),
    };
  }

  const detected = detectZcodeDataDir();
  if (detected) {
    return {
      configPath: path.join(detected.appConfigDir, appConfigFileName),
      source: 'detected',
      detail: detected,
    };
  }

  // 旁路文件只在探测失败时兜底，而且同样要过 runtime 校验——否则把这个包连同
  // 旁路文件一起拷到别的电脑，会照着旧的机器路径去写。
  const sidecarBase = readSidecar();
  if (sidecarBase) {
    const root = path.join(sidecarBase, '.zcode');
    const detail = scoreZcodeRoot(root);
    if (detail.score >= 4) {
      return {
        configPath: path.join(root, 'v2', appConfigFileName),
        source: 'sidecar',
        detail,
      };
    }
  }

  return {
    configPath: path.join(os.homedir(), '.zcode', 'v2', appConfigFileName),
    source: 'homedir',
    detail: null,
  };
}

/** 落到可疑目录时大声报警——这个坑一旦踩中，设置里就是不出现模型分组，很难猜。 */
function warnAboutConfigTarget(resolved) {
  if (resolved.source === 'explicit') return;
  if (resolved.detail && resolved.detail.score >= 4) return;

  console.warn('[zen] 警告：没能确认 ZCode 正在使用的数据目录。');
  console.warn(`[zen]       本次会写到：${resolved.configPath}`);
  console.warn('[zen]       如果 ZCode 读的不是这里，设置里就不会出现「OpenCode 免费模型」。');
  console.warn('[zen]       跑 `node zen-proxy.mjs --detect` 看候选目录明细；');
  console.warn('[zen]       或用 --config <完整路径> 直接指定 provider_config.json。');
}

function buildProviderRule({ id, name, apiType, port, modelIds }) {
  return {
    providerId: id,
    providerName: name,
    enabled: true,
    config: {
      group: 'standard-personal',
      visibility: 'visible',
      access: { type: 'api-key', apiKey: ANONYMOUS_KEY },
      api: { type: apiType, baseUrl: `http://127.0.0.1:${port}/v1` },
      personalModelIds: modelIds,
      modelOrder: modelIds,
    },
  };
}

/**
 * 每个模型的元数据走 smart 车道：ZCode 内置模板与用户自建 Provider 用的都是它，
 * 且接受部分稀疏配置（只补你确实知道的叶子，其余交给 ZCode 自己解析）。
 * 走 manual 车道反而要求把一堆叶子填满，且同一 Provider/Model 不能两条道并存。
 */
function buildModelRule(providerId, entry) {
  const config = {
    properties: {
      contextWindow: entry.contextWindow,
      inputFormat: { supportsImage: entry.supportsImages === true },
    },
  };
  const optionSpecs = {};
  if (Array.isArray(entry.thinkingLevels) && entry.thinkingLevels.length > 0) {
    // values 就是模型选择器里那串思考档位；真正的 reasoning_effort 归一在代理层做。
    optionSpecs.reasoningLevel = { values: entry.thinkingLevels };
  }
  if (Number.isFinite(entry.maxTokens)) {
    optionSpecs.maxOutputTokens = { max: entry.maxTokens };
  }
  if (Object.keys(optionSpecs).length > 0) config.optionSpecs = optionSpecs;
  return { providerId, modelId: entry.id, config };
}

/** 打印用的脱敏：绝不让 --print-config 把别人的 key 打到终端上。 */
function redactSecrets(config) {
  const clone = JSON.parse(JSON.stringify(config));
  for (const rule of clone.config?.providerConfigRules?.providerRules ?? []) {
    if (rule?.config?.access?.apiKey) rule.config.access.apiKey = '***已隐藏***';
  }
  return clone;
}

/** 组装整份 provider_config.json，保留用户已有的其它 Provider。 */
function buildZcodeConfig({ existing, port, chatModels, responsesModels }) {
  const ourRules = [
    buildProviderRule({
      id: PROVIDER_ID,
      name: PROVIDER_NAME,
      apiType: 'openai-chat-completions',
      port,
      modelIds: chatModels.map((m) => m.id),
    }),
  ];
  if (responsesModels.length > 0) {
    ourRules.push(
      buildProviderRule({
        id: RESPONSES_PROVIDER_ID,
        name: RESPONSES_PROVIDER_NAME,
        apiType: 'openai-responses',
        port,
        modelIds: responsesModels.map((m) => m.id),
      }),
    );
  }

  const ourModelRules = [
    ...chatModels.map((m) => buildModelRule(PROVIDER_ID, m)),
    ...responsesModels.map((m) => buildModelRule(RESPONSES_PROVIDER_ID, m)),
  ];

  const priorConfig = existing && existing.schemaVersion === 1 && existing.config ? existing.config : {};
  const ourIds = new Set(ourRules.map((rule) => rule.providerId));

  // 保留用户已有的 Provider；只替换我们自己那两个 providerId。
  const keptRules = Array.isArray(priorConfig.providerConfigRules?.providerRules)
    ? priorConfig.providerConfigRules.providerRules.filter(
        (rule) => rule && !ourIds.has(rule.providerId),
      )
    : [];
  const keptProviderModelRules = Array.isArray(priorConfig.modelConfigRules?.providerModelRules)
    ? priorConfig.modelConfigRules.providerModelRules.filter(
        (rule) => rule && !ourIds.has(rule.providerId),
      )
    : [];
  const keptManualModelRules = Array.isArray(priorConfig.modelConfigRules?.manualProviderModelRules)
    ? priorConfig.modelConfigRules.manualProviderModelRules.filter(
        (rule) => rule && !ourIds.has(rule.providerId),
      )
    : [];

  const priorOrder = Array.isArray(priorConfig.providerOrder)
    ? priorConfig.providerOrder.filter((id) => typeof id === 'string' && !ourIds.has(id))
    : [];

  return {
    schemaVersion: 1,
    config: {
      providerOrder: [...priorOrder, ...ourRules.map((rule) => rule.providerId)],
      providerConfigRules: { providerRules: [...keptRules, ...ourRules] },
      modelConfigRules: {
        providerModelRules: [...keptProviderModelRules, ...ourModelRules],
        manualProviderModelRules: keptManualModelRules,
      },
    },
  };
}

/**
 * 从现有配置里摘掉本工具写入的两个 provider，别的 Provider 一律不动。
 * 复用 buildZcodeConfig 的过滤口径，保证「装上去的」和「卸掉的」严格对称。
 */
function removeOurProviders(existing) {
  const ourIds = new Set([PROVIDER_ID, RESPONSES_PROVIDER_ID]);
  if (!existing || existing.schemaVersion !== 1 || !existing.config) return null;
  const prior = existing.config;

  const rules = Array.isArray(prior.providerConfigRules?.providerRules)
    ? prior.providerConfigRules.providerRules.filter((rule) => rule && !ourIds.has(rule.providerId))
    : [];
  const modelRules = Array.isArray(prior.modelConfigRules?.providerModelRules)
    ? prior.modelConfigRules.providerModelRules.filter((rule) => rule && !ourIds.has(rule.providerId))
    : [];
  const manualRules = Array.isArray(prior.modelConfigRules?.manualProviderModelRules)
    ? prior.modelConfigRules.manualProviderModelRules.filter((rule) => rule && !ourIds.has(rule.providerId))
    : [];
  const order = Array.isArray(prior.providerOrder)
    ? prior.providerOrder.filter((id) => typeof id === 'string' && !ourIds.has(id))
    : [];

  const removed =
    (Array.isArray(prior.providerConfigRules?.providerRules) ? prior.providerConfigRules.providerRules.length : 0) -
    rules.length;

  return {
    removed,
    config: {
      providerOrder: order,
      providerConfigRules: { providerRules: rules },
      modelConfigRules: {
        providerModelRules: modelRules,
        manualProviderModelRules: manualRules,
      },
    },
  };
}

function writeZcodeConfig(configPath, config) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  if (fs.existsSync(configPath)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = `${configPath}.bak-${stamp}`;
    try {
      fs.copyFileSync(configPath, backup);
    } catch {
      /* 备份失败不阻断主流程 */
    }
  }
  const temporary = `${configPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, configPath);
}

// ---------------------------------------------------------------------------
// 回环 HTTP 服务
// ---------------------------------------------------------------------------

const state = {
  port: null,
  requests: 0,
  errors: 0,
  lastError: '',
  chatModels: [],
  responsesModels: [],
  catalogStatus: { status: 'pending' },
};

function isLoopbackHost(host) {
  if (typeof host !== 'string') return false;
  const value = host.trim().toLowerCase();
  return (
    value.startsWith('127.0.0.1') ||
    value.startsWith('localhost') ||
    value.startsWith('[::1]') ||
    value.startsWith('::1')
  );
}

function isLoopbackOrigin(origin) {
  // 没有 Origin 的（CLI 侧的 Node 请求）放行，有则必须是回环。
  if (origin === undefined || origin === null || origin === '') return true;
  try {
    const { hostname } = new URL(String(origin));
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  } catch {
    return false;
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function currentModelIds() {
  return state.chatModels.map((m) => m.id);
}

function extractErrorMessage(bodyText, status) {
  let snippet = String(bodyText || '').slice(0, 300);
  try {
    const parsed = JSON.parse(bodyText);
    snippet = (parsed && (parsed.message || (parsed.error && (parsed.error.message || parsed.error.code)))) || snippet;
  } catch {
    /* 保留原始片段 */
  }
  if (status === 403) return `上游 403（免费通道门禁或区域限制）：${snippet}`;
  if (status === 429) return `上游 429 限速（匿名通道按 IP 计配额）：${snippet}`;
  return `上游 ${status}：${snippet}`;
}

async function handleUpstream(req, res, upstreamPath) {
  let hostBody;
  try {
    hostBody = JSON.parse(await readBody(req));
  } catch (error) {
    state.errors += 1;
    state.lastError = error.message;
    sendJson(res, 400, { error: { message: `请求体不是合法 JSON：${error.message}` } });
    return;
  }

  // chat 道：强制流式 + 归一思考档位 + 补 bash/read 门禁工具。
  // responses 道：只强制流式，其余原样（muse-spark 由 Zen 自己的 /v1/responses 服务）。
  // 两条道都要过同一道门禁（请求体里必须有 bash 和 read），但线格式不同：
  // responses 的工具定义是扁平的，而且不能带 tool_choice。详见 ensureFreeLaneShape。
  const isResponsesLane = upstreamPath.endsWith('/responses');
  const body = buildUpstreamBody(hostBody, isResponsesLane ? 'responses' : 'chat');
  const ids = deriveRequestIDsFromWire(body);

  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  req.on('aborted', onClose);
  res.on('close', onClose);
  const headerTimer = setTimeout(() => {
    if (!res.headersSent) controller.abort();
  }, UPSTREAM_HEADER_TIMEOUT_MS);

  state.requests += 1;
  const send = (payload) =>
    fetch(`${ZEN_BASE_URL}${upstreamPath}`, {
      method: 'POST',
      headers: {
        ...disguiseHeaders(ids),
        authorization: `Bearer ${ANONYMOUS_KEY}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

  try {
    let response = await send(body);
    // 档位是逐模型实测出来的，仍可能撞上某个模型不收某个档位；只在「确实带了
    // reasoning_effort」且上游明确拒绝时，摘掉该字段重试一次。
    if (
      !response.ok &&
      body.reasoning_effort !== undefined &&
      RETRY_WITHOUT_EFFORT_STATUSES.includes(response.status)
    ) {
      console.error(
        `[zen] reasoning_effort=${body.reasoning_effort} 被上游拒绝（HTTP ${response.status}），摘掉该字段重试`,
      );
      await response.text().catch(() => '');
      const retryBody = { ...body };
      delete retryBody.reasoning_effort;
      response = await send(retryBody);
    }
    clearTimeout(headerTimer);

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      state.errors += 1;
      state.lastError = extractErrorMessage(bodyText, response.status);
      console.error(`[zen] ${state.lastError.slice(0, 200)}`);
      if (!res.headersSent) {
        res.writeHead(response.status, {
          'Content-Type': response.headers.get('content-type') || 'application/json',
        });
      }
      res.end(bodyText);
      return;
    }

    // 免费通道要求请求必须流式，但客户端不一定想要流式响应。客户端没要流式时
    // 在中间把 SSE 拼回完整 JSON——否则非流式调用方（ZCode 的 WebFetch 等）
    // 拿到一串 data: 碎片，按 JSON 解析直接失败。
    const wantsStream = hostBody?.stream === true;

    if (!wantsStream) {
      const raw = await response.text();
      const payload = isResponsesLane
          ? reassembleResponsesSse(raw, hostBody?.model)
          : reassembleChatSse(raw);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(payload));
      return;
    }

    // SSE 逐块透传：两端都是同一套方言，不需要重编码，流式零损耗。
    res.writeHead(response.status, {
      'Content-Type': response.headers.get('content-type') || 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    if (!response.body) {
      res.end();
      return;
    }
    const upstream = Readable.fromWeb(response.body);
    upstream.on('error', () => {
      if (!res.writableEnded) res.end();
    });
    res.on('close', () => upstream.destroy());
    upstream.pipe(res);
  } catch (error) {
    clearTimeout(headerTimer);
    state.errors += 1;
    state.lastError = error && error.message ? error.message : String(error);
    console.error(`[zen] 代理错误：${state.lastError}`);
    if (!res.headersSent) {
      sendJson(res, 502, { error: { message: `上游请求失败：${state.lastError}` } });
    } else if (!res.writableEnded) {
      res.end();
    }
  }
}

/**
 * 把上游的 chat SSE 文本拼回完整的非流式 chat.completion。
 * 免费通道要求请求流式，但客户端（ZCode 的 WebFetch 等）发来的可能是
 * 非流式请求——此前把碎片原样甩回去，客户端按 JSON 解析直接失败。
 */
function reassembleChatSse(raw) {
  let content = '';
  let reasoning = '';
  let finishReason = '';
  let usage = null;
  for (const line of String(raw ?? '').split('\n')) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '' || data === '[DONE]') continue;
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    const delta = chunk?.choices?.[0]?.delta;
    if (delta) {
      if (typeof delta.content === 'string') content += delta.content;
      if (typeof delta.reasoning === 'string') reasoning += delta.reasoning;
    }
    const fr = chunk?.choices?.[0]?.finish_reason;
    if (typeof fr === 'string' && fr.length > 0) finishReason = fr;
    if (chunk?.usage && typeof chunk.usage === 'object') usage = chunk.usage;
  }
  // 有的模型把全部输出都放进 reasoning 字段；content 为空时拿它顶上，
  // 否则非流式客户端只会看到一个空回复。
  if (content === '' && reasoning !== '') content = reasoning;
  const message = { role: 'assistant', content };
  if (reasoning !== '' && content !== '') message.reasoning_content = reasoning;
  const payload = {
    id: 'chatcmpl-proxy',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: '',
    choices: [{ index: 0, message, finish_reason: finishReason === '' ? 'stop' : finishReason }],
  };
  if (usage) payload.usage = usage;
  return payload;
}

/** 把上游的 responses SSE 文本拼回完整的 response 对象。 */
function reassembleResponsesSse(raw, model) {
  let text = '';
  let completed = null;
  for (const line of String(raw ?? '').split('\n')) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '' || data === '[DONE]') continue;
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    if (event?.type === 'response.output_text.delta' && typeof event.delta === 'string') {
      text += event.delta;
    } else if (event?.type === 'response.completed' && event.response) {
      completed = event.response;
    }
  }
  if (completed) {
    // 上游给的是权威完整对象；把拼出来的文本兜底进去（有些上游不发
    // output_text，只发 delta）。
    const output = Array.isArray(completed.output) ? completed.output : [];
    const hasText = output.some((item) =>
      Array.isArray(item?.content) && item.content.some((p) => p?.type === 'output_text'),
    );
    if (!hasText) {
      output.push({
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text }],
      });
    }
    completed.output = output;
    return completed;
  }
  return {
    id: `resp_proxy_${Math.floor(Date.now() / 1000)}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: model ?? '',
    output: [
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text }],
      },
    ],
  };
}

function handleRequest(req, res) {
  if (!isLoopbackHost(req.headers.host) || !isLoopbackOrigin(req.headers.origin)) {
    sendJson(res, 403, { error: { message: 'loopback requests only' } });
    return;
  }

  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const pathname = url.pathname;

  if (req.method === 'GET' && (pathname === '/healthz' || pathname === '/')) {
    sendJson(res, 200, {
      ok: true,
      port: state.port,
      chatModels: currentModelIds().length,
      responsesModels: state.responsesModels.length,
      catalog: state.catalogStatus,
      requests: state.requests,
      errors: state.errors,
      lastError: state.lastError,
    });
    return;
  }

  if (req.method === 'GET' && (pathname === '/v1/models' || pathname === '/models')) {
    sendJson(res, 200, {
      object: 'list',
      data: currentModelIds().map((id) => ({ id, object: 'model', name: id })),
    });
    return;
  }

  const isResponses = req.method === 'POST' && pathname.endsWith('/responses');
  const isChat = req.method === 'POST' && pathname.endsWith('/chat/completions');
  if (!isResponses && !isChat) {
    sendJson(res, 404, { error: { message: 'not found' } });
    return;
  }

  void handleUpstream(req, res, isResponses ? '/v1/responses' : '/v1/chat/completions');
}

/** 优先绑固定候选端口，这样写进配置的 baseUrl 才稳定。 */
function listen(server, candidates) {
  return new Promise((resolve, reject) => {
    const ports = [...new Set(candidates.filter((p) => Number.isInteger(p) && p >= 0))];
    const tryPort = (index) => {
      if (index >= ports.length) {
        reject(new Error('没有可用端口'));
        return;
      }
      const onError = (error) => {
        if (error.code === 'EADDRINUSE') {
          server.removeListener('listening', onListening);
          tryPort(index + 1);
          return;
        }
        reject(error);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve(server.address().port);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(ports[index], '127.0.0.1');
    };
    tryPort(0);
  });
}

// ---------------------------------------------------------------------------
// 随 ZCode 自动启动
// ---------------------------------------------------------------------------

/**
 * 装上「随 ZCode 自动启动」：往 ZCode 的 CLI 配置里写一条 SessionStart 钩子。
 *
 * ZCode 的钩子必须写绝对路径（`${ZCODE_PROJECT_DIR}` 指的是用户打开的工作区，
 * 不是本工具的位置，用不上），所以这里把**当前这个程序的路径**记进配置。
 * 由此带来一条规则：装完就别再挪动它；挪了重跑一次即可，本函数是幂等的，
 * 而且会顺手清掉指向已不存在位置的旧钩子。
 *
 * 这条钩子是不是 opencode2zcode 的，认的是**文件名**（ensure-proxy.mjs 或
 * opencode2zcode.exe）而不是完整路径。按完整路径认的话，目录一改名就会被当成
 * 「没装过」，于是一条新的加上去、那条死钩子留在配置里，每次开 ZCode 都白跑一次。
 */

const HOOK_TIMEOUT_MS = 12_000;
/**
 * 认领钩子用的文件名。注意里面**包含已经废弃的 ensure-proxy.mjs / install.mjs**
 * ——早几版装过的人配置里留着指向它们的钩子，那些文件早没了。不把旧名字列进来，
 * 它们会被当成「别人的钩子」永远留着，而那条钩子每次开 ZCode 都会去跑一个
 * 不存在的文件。列进来是为了让重装/卸载能顺手清理掉。
 */
const HOOK_BASENAMES = new Set([
  'zen-proxy.mjs',
  'opencode2zcode.exe',
  'ensure-proxy.mjs',
  'install.mjs',
]);
const HOOK_MARKER_ARG = 'opencode2zcode-hook';
const HOOK_CONFIG_RELATIVE = ['.zcode', 'cli', 'config.json'];
const PROXY_LOCK_FILE = '.proxy-start.lock';

/** 当前是不是打成 exe 在跑（SEA 里 process.execPath 就是 exe 本身）。 */
function runningAsExe() {
  return path.basename(process.execPath).toLowerCase() === 'opencode2zcode.exe';
}

/**
 * 写进 ZCode 配置的路径要好看也要稳。Windows 有时会把 process.execPath 缩成
 * 8.3 短名（C:\Users\ADMINI~1\…），那种路径在禁用短名、或目录被重建后就失效，
 * 所以统一换成真实长路径。
 */
function stableExecutablePath() {
  try {
    return fs.realpathSync.native(process.execPath);
  } catch {
    return process.execPath;
  }
}

/** 把自己叫起来的 argv：源码形态是 node + 脚本路径，exe 形态直接跑 exe。 */
function selfInvocation(extraArgs) {
  if (runningAsExe()) return { command: stableExecutablePath(), args: [...extraArgs] };
  const script = process.argv[1] || path.join(SCRIPT_DIR, 'zen-proxy.mjs');
  return { command: process.execPath, args: [script, ...extraArgs] };
}

function zcodeCliConfigPath() {
  const home = process.env.USERPROFILE?.trim() || os.homedir();
  return path.join(home, ...HOOK_CONFIG_RELATIVE);
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonWithBackup(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    try {
      fs.copyFileSync(file, `${file}.bak-${stamp}`);
    } catch {
      /* 备份失败不阻断 */
    }
  }
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, file);
}

function hookArgsOf(entry) {
  const list = Array.isArray(entry?.hooks) ? entry.hooks : [];
  for (const hook of list) {
    if (Array.isArray(hook?.args)) return hook.args;
  }
  return [];
}

function isOurHook(entry) {
  return hookArgsOf(entry).some((arg) => {
    if (typeof arg !== 'string') return false;
    if (arg === HOOK_MARKER_ARG) return true;
    return HOOK_BASENAMES.has(path.basename(arg).toLowerCase());
  });
}

/** 钩子指向的东西还在不在。不在就是条死钩子，装的时候顺手清掉。 */
function hookTargetExists(entry) {
  for (const arg of hookArgsOf(entry)) {
    if (typeof arg !== 'string' || arg === HOOK_MARKER_ARG) continue;
    if (HOOK_BASENAMES.has(path.basename(arg).toLowerCase())) return fs.existsSync(arg);
  }
  return true;
}

/**
 * 钩子该怎么把本程序叫起来。打成 exe 时直接跑 exe（目标机上没 node 也能用），
 * 源码形态则是 node + 本脚本 + --ensure。两种都靠脚本文件名认领。
 */
function hookInvocation() {
  return selfInvocation(runningAsExe() ? [HOOK_MARKER_ARG] : ['--ensure']);
}

function installAutostart() {
  const configPath = zcodeCliConfigPath();
  const config = readJsonSafe(configPath) ?? {};
  config.hooks = config.hooks && typeof config.hooks === 'object' ? config.hooks : {};
  config.hooks.enabled = true;
  const events =
    config.hooks.events && typeof config.hooks.events === 'object' ? config.hooks.events : {};
  const existing = Array.isArray(events.SessionStart) ? events.SessionStart : [];
  const invocation = hookInvocation();

  const entry = {
    hooks: [
      { type: 'process', command: invocation.command, args: invocation.args, timeoutMs: HOOK_TIMEOUT_MS },
    ],
  };

  // 别人的钩子原样留下；我们自己那条永远只留一条，且永远指向当前这个程序。
  const foreign = existing.filter((item) => !isOurHook(item));
  const stale = existing.filter((item) => isOurHook(item) && !hookTargetExists(item));

  events.SessionStart = [entry, ...foreign];
  config.hooks.events = events;
  writeJsonWithBackup(configPath, config);

  if (stale.length > 0) {
    console.log(`[autostart] 清掉了 ${stale.length} 条指向已不存在位置的旧钩子。`);
  }
  console.log(`[autostart] 已写入 SessionStart 钩子：${configPath}`);
  console.log(`[autostart] 钩子命令：${invocation.command} ${invocation.args.join(' ')}`);
  console.log('[autostart] 从现在起，启动 ZCode 会自动静默拉起代理，不用再双击任何东西。');
  console.log('[autostart] 注意：上面这个路径是写死的。以后若移动或改名了，');
  console.log('[autostart]        到新位置重跑一次 --install 即可（旧的会被自动替换）。');
}

function uninstallAutostart() {
  const configPath = zcodeCliConfigPath();
  const config = readJsonSafe(configPath);
  if (!config?.hooks?.events?.SessionStart) {
    console.log('[autostart] 配置里没有 SessionStart 钩子，无需卸载。');
    return;
  }
  const before = config.hooks.events.SessionStart.length;
  const kept = config.hooks.events.SessionStart.filter((entry) => !isOurHook(entry));
  const removed = before - kept.length;

  if (removed === 0) {
    console.log('[autostart] 没有属于 opencode2zcode 的钩子（别人的钩子一个没动）。');
    return;
  }

  if (kept.length === 0) delete config.hooks.events.SessionStart;
  else config.hooks.events.SessionStart = kept;
  if (Object.keys(config.hooks.events).length === 0) delete config.hooks.events;
  // 事件清空后剩下的 hooks.enabled 只是个空开关，装之前没有就整个撤掉。
  if (config.hooks.events === undefined) delete config.hooks;

  writeJsonWithBackup(configPath, config);
  console.log(`[autostart] 已移除 ${removed} 条自启钩子：${configPath}`);
  console.log('[autostart] 其它 mcp / plugins / hooks 配置保持原样。');
}

// ---------------------------------------------------------------------------
// 静默拉起：SessionStart 钩子触发时走这条路
// ---------------------------------------------------------------------------

/**
 * ZCode 一启动就检查代理在不在，不在就静默拉起。
 *
 * 几条被 ZCode 钩子契约逼出来的硬约束：
 *   - 钩子**永远同步执行**，`async: true` 不生效。所以本函数自己负责
 *     「快速判断 → 需要时才等一小会儿 → 无论如何都退出 0」。
 *   - 绝不能 block 或 deny 会话：任何异常都吞掉。
 *   - 拉起的子进程必须 detached + windowsHide，否则用户会看见一个黑窗口凭空弹出。
 *   - 单实例保护：并发启动多个 ZCode 会话时只允许一个真正拉起。否则第二个实例
 *     会绑到 41931 并把配置里的 baseUrl 改掉，用户会突然发现模型不能用。
 */

const LOCK_STALE_SECONDS = 20;
const ENSURE_TIMEOUT_MS = 6000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function probePort(port, timeoutMs = 700) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return false;
    const body = await response.json();
    return Boolean(body && body.ok === true);
  } catch {
    return false;
  }
}

async function anyProxyAlive() {
  for (const port of PORT_CANDIDATES) {
    if (await probePort(port)) return port;
  }
  return null;
}

/** 抢排他锁；抢到返回 true。文件不存在或已过期都视为可抢。 */
function acquireLock(lockFile) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(lockFile, `${process.pid}\n`, { flag: 'wx' });
      return true;
    } catch (error) {
      if (!error || error.code !== 'EEXIST') return false;
      let age = Infinity;
      try {
        age = (Date.now() - fs.statSync(lockFile).mtimeMs) / 1000;
      } catch {
        age = Infinity;
      }
      if (age > LOCK_STALE_SECONDS) {
        // 陈锁：上一次拉起过程崩了留下的，清掉重抢。
        try {
          fs.unlinkSync(lockFile);
        } catch {
          /* 抢不到就算了 */
        }
        continue;
      }
      return false;
    }
  }
  return false;
}

function releaseLock(lockFile) {
  try {
    fs.unlinkSync(lockFile);
  } catch {
    /* 本来就没有 */
  }
}

/** 把本程序以「彻底脱离、无窗口」的方式再拉起一份（不带 --ensure，进去就是服务模式）。 */
function spawnSelfDetached() {
  const self = selfInvocation([]);
  const child = spawn(self.command, self.args, {
    cwd: SCRIPT_DIR,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}

async function ensureProxyRunning() {
  const lockFile = path.join(SCRIPT_DIR, PROXY_LOCK_FILE);
  if (await anyProxyAlive()) return;

  if (!acquireLock(lockFile)) {
    // 别的实例正在拉起，等它一下就到点了。
    const deadline = Date.now() + ENSURE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(400);
      if (await anyProxyAlive()) return;
    }
    return;
  }

  try {
    // 拿到锁之后再确认一次：可能正好在等锁期间别人已经拉起来了。
    if (await anyProxyAlive()) return;
    spawnSelfDetached();
    const deadline = Date.now() + ENSURE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(300);
      if (await anyProxyAlive()) return;
    }
  } finally {
    releaseLock(lockFile);
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const options = { port: null, configPath: null, mode: 'serve', withResponses: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port') {
      options.port = Number.parseInt(argv[++i] ?? '', 10);
    } else if (arg === '--config') {
      options.configPath = argv[++i] ?? null;
    } else if (arg === '--print-config') {
      options.mode = 'print';
    } else if (arg === '--write-config-only') {
      options.mode = 'write';
    } else if (arg === '--remove-provider') {
      options.mode = 'remove';
    } else if (arg === '--with-responses') {
      options.withResponses = true;
    } else if (arg === '--install') {
      options.mode = 'install';
    } else if (arg === '--uninstall') {
      options.mode = 'uninstall';
    } else if (arg === HOOK_MARKER_ARG || arg === '--ensure') {
      options.mode = 'ensure';
    } else if (arg === '--detect') {
      options.mode = 'detect';
    } else if (arg === '--help' || arg === '-h') {
      options.mode = 'help';
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return options;
}

const HELP = `opencode2zcode — 把 OpenCode Zen 匿名免费模型接进 ZCode

用法：
  node zen-proxy.mjs                     起代理并写入/更新 ZCode 个人 Provider 配置
  node zen-proxy.mjs --install           装上「随 ZCode 自动启动」（幂等，推荐）
  node zen-proxy.mjs --uninstall         卸掉自启钩子并摘掉本工具的 Provider
  node zen-proxy.mjs --ensure            检查代理在不在，不在就静默拉起（供钩子调用）
  node zen-proxy.mjs --detect            只列出候选数据目录与判据，确认写到哪儿
  node zen-proxy.mjs --print-config      只打印将要写入的配置（不落盘、不起服务）
  node zen-proxy.mjs --write-config-only 只写配置后退出
  node zen-proxy.mjs --remove-provider   只从 ZCode 配置里摘掉本工具的两个 Provider
  node zen-proxy.mjs --port 41930        指定回环端口
  node zen-proxy.mjs --config <path>     直接指定 provider_config.json 完整路径
  node zen-proxy.mjs --with-responses    兼容旧命令行（responses 组现在默认就写）

装完就不用再管了：启动 ZCode 时会自动静默拉起代理，不会有任何窗口。
人类用户直接双击 install-autostart.cmd 即可（它就是 --install 的壳）。

配置落点按这个顺序决定：
  --config  >  ZCODE_DATA_BASE_DIR 环境变量  >  自动探测  >  旁路文件  >  用户主目录

自动探测的判据是 {数据根}/.zcode/v2/runtime 是否存在（ZCode 准备运行资源时会建它），
并会扫各固定盘的盘根与盘根下一层目录——因为这个包要能在别人的电脑上直接用。

诊断：curl http://127.0.0.1:41930/healthz`;

const SOURCE_LABELS = {
  explicit: '手动指定',
  env: '环境变量 ZCODE_DATA_BASE_DIR',
  detected: '自动探测',
  sidecar: '上次探测记录',
  homedir: '用户主目录兜底',
};

/** --detect：把候选目录和判据全列出来，方便在别人电脑上确认。 */
function printDetection() {
  const ranked = rankZcodeRoots();
  const interesting = ranked.filter((item) => item.score > 0);
  const ignored = ranked.length - interesting.length;

  console.log('ZCode 数据目录候选（✓ = 带 v2/runtime，即认得出来）：');
  if (interesting.length === 0) console.log('  （没有得分 > 0 的候选）');
  for (const item of interesting) {
    console.log(`  ${item.score >= 4 ? '✓' : ' '} [${item.score}] ${item.appConfigDir}`);
    if (item.evidence.length > 0) console.log(`          证据：${item.evidence.join('、')}`);
  }
  if (ignored > 0) console.log(`  （另有 ${ignored} 个 0 分候选已忽略）`);

  const best = ranked[0];
  const decided = best && best.score >= 4 ? best : null;
  console.log('');
  console.log(`环境变量 ZCODE_DATA_BASE_DIR：${process.env.ZCODE_DATA_BASE_DIR?.trim() || '（未设置）'}`);
  console.log(`旁路文件：${readSidecar() ?? '（无）'}`);
  console.log(`           ${sidecarPath()}`);
  console.log('');
  console.log(`结论：${decided ? `采用 ${decided.appConfigDir}` : '没探测到 —— 请用 --config 指定'}`);
  console.log(`配置将写入：${resolveConfigTarget(null).configPath}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.mode === 'help') {
    console.log(HELP);
    return;
  }

  // 钩子专用路径：必须在任何目录探测、任何配置读写之前短路返回，
  // 而且无论成功失败退出码恒为 0，绝不能影响 ZCode 开会话。
  if (options.mode === 'ensure') {
    try {
      await ensureProxyRunning();
    } catch {
      /* 吞掉一切 */
    }
    return;
  }

  if (options.mode === 'install') {
    installAutostart();
    return;
  }

  if (options.mode === 'uninstall') {
    uninstallAutostart();
    const target = resolveConfigTarget(options.configPath ?? null);
    const result = removeOurProviders(readExistingConfig(target.configPath));
    if (result && result.removed > 0) {
      writeZcodeConfig(target.configPath, { schemaVersion: 1, config: result.config });
      lastWritten = '';
      console.log(
        `[zen] 已从 ${target.configPath} 移除 ${result.removed} 个 Provider（${PROVIDER_ID} / ${RESPONSES_PROVIDER_ID}）`,
      );
      console.log('[zen] 你的其它 Provider 原样保留。');
    } else {
      console.log('[zen] 配置里没有本工具的 Provider，无需清理。');
    }
    return;
  }

  if (options.mode === 'detect') {
    printDetection();
    return;
  }

  const resolved = resolveConfigTarget(options.configPath ?? null);
  const configPath = resolved.configPath;
  const cachePath = path.join(path.dirname(configPath), CACHE_FILE_NAME);
  warnAboutConfigTarget(resolved);

  // 确认过的数据目录记进旁路文件，之后从资源管理器双击 .cmd 也能找对地方。
  if (resolved.source !== 'explicit' && resolved.detail && resolved.detail.score >= 4) {
    writeSidecar(resolved.detail.baseDir);
  }
  console.log(`[zen] 配置目标（${SOURCE_LABELS[resolved.source] ?? resolved.source}）：${configPath}`);

  let server = null;
  let port = options.port ?? DEFAULT_PORT;
  const catalog = new ModelCatalog((url, init) => globalThis.fetch(url, init), () => {
    applyCatalog(port, configPath);
  }, { cachePath });

  function applyCatalog(currentPort, targetConfigPath) {
    state.chatModels = chatModelEntries(catalog);
    state.responsesModels = responsesModelEntries(catalog);
    state.catalogStatus = catalog.snapshot();
    const existing = readExistingConfig(targetConfigPath);
    const config = buildZcodeConfig({
      existing,
      port: currentPort,
      chatModels: state.chatModels,
      responsesModels: state.responsesModels,
    });
    rewriteConfig(targetConfigPath, config);
  }

  // 一次性命令先拉目录（离线时也用缓存种子写出真实清单，而不是缩水兜底）。
  // 服务模式则先绑端口再拉目录：models.dev 不可达时一次刷新要等 30 秒超时，
  // 让 ZCode 的启动钩子干等是不合理的——端口先开（healthz 应答 pending），
  // 目录随后补齐。与 Rust 版行为一致。
  if (options.mode === 'print' || options.mode === 'write') {
    await catalog.refreshOnce();
  }

  if (options.mode === 'print') {
    const config = buildZcodeConfig({
      existing: readExistingConfig(configPath),
      port,
      chatModels: chatModelEntries(catalog),
      responsesModels: responsesModelEntries(catalog),
    });
    console.error(`# 目标文件：${configPath}`);
    console.error('# 下面所有 apiKey 已脱敏；此模式不落盘、不起服务。');
    console.log(JSON.stringify(redactSecrets(config), null, 2));
    return;
  }

  if (options.mode === 'write') {
    applyCatalog(port, configPath);
    console.log(`已写入 ${configPath}`);
    console.log(`chat ${state.chatModels.length} 个模型 / responses ${state.responsesModels.length} 个模型`);
    return;
  }

  if (options.mode === 'remove') {
    const result = removeOurProviders(readExistingConfig(configPath));
    if (!result) {
      console.log(`[zen] ${configPath} 不存在或不是本工具写的配置，无需清理。`);
      return;
    }
    if (result.removed === 0) {
      console.log(`[zen] 配置里没有本工具的 Provider，无需清理。`);
      return;
    }
    writeZcodeConfig(configPath, { schemaVersion: 1, config: result.config });
    lastWritten = '';
    console.log(`[zen] 已从 ${configPath} 移除 ${result.removed} 个 Provider（${PROVIDER_ID} / ${RESPONSES_PROVIDER_ID}）`);
    console.log('[zen] 你的其它 Provider 原样保留。');
    return;
  }

  server = createServer(handleRequest);
  port = await listen(server, options.port ? [options.port, ...PORT_CANDIDATES] : PORT_CANDIDATES);
  state.port = port;
  console.log(`[zen] 回环代理已监听 127.0.0.1:${port}`);

  await catalog.refreshOnce();
  applyCatalog(port, configPath);
  console.log(`[zen] 已同步 ZCode 配置：${configPath}`);
  console.log(`[zen] chat ${state.chatModels.length} 个 / responses ${state.responsesModels.length} 个模型`);

  void catalog.start().catch((error) => console.error(`[zen] 目录刷新失败：${error && error.message}`));

  const shutdown = () => {
    console.log('\n[zen] 正在退出');
    catalog.stop();
    if (server) server.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function readExistingConfig(configPath) {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return null;
  }
}

let lastWritten = '';
function rewriteConfig(configPath, config) {
  const serialized = JSON.stringify(config);
  if (serialized === lastWritten) return;
  lastWritten = serialized;
  try {
    writeZcodeConfig(configPath, config);
  } catch (error) {
    console.error(`[zen] 写配置失败：${error && error.message}`);
  }
}

main().catch((error) => {
  console.error(`[zen] 启动失败：${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
