#!/usr/bin/env node
/**
 * opencode2zcode 渠道连通性检测工具
 *
 * 核心功能：
 * 1. 自动枚举 OpenCode Zen 的所有免费模型（Chat 频道与 Responses 频道）。
 * 2. 逐一发起实测请求，精准区分：
 *    - ✅ 正常可用 (ACTIVE)
 *    - 🌍 网络位置/地区受限 (REGION_BLOCKED)：因 IP 地区被拒绝，切换节点可恢复
 *    - 🚫 渠道已下线/已废弃 (CHANNEL_REMOVED)：官方已移除或废弃，换节点也无法使用
 *    - ⏳ 端点未就绪/临时排队 (ENDPOINT_NOT_READY)：如刚公布的预览模型或临时限流
 *    - 🔒 门禁校验失败 (GATE_FAILED)
 *    - 🔌 本地代理未启动 (PROXY_UNREACHABLE)
 * 3. 生成直观的 Markdown 诊断报告或机器可读 JSON。
 *
 * 用法：
 *   node tools/probe-channels.mjs
 *   node tools/probe-channels.mjs --json
 *   node tools/probe-channels.mjs --model exo-free
 *   node tools/probe-channels.mjs --port 41930
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, '..');

/**
 * 出境请求走系统代理（Clash 之类）。Node 的 fetch 不读 Windows 注册表，
 * 不设的话出境直连会被墙，榜单这类只有墙外才有的接口就拉不到。
 *
 * 注意：NODE_USE_ENV_PROXY 只在进程启动时读一次，启动后在脚本里设是无效的。
 * 所以这里用自举：如果还没设代理变量，就读注册表拿到地址，带上变量重新拉起
 * 自己（最多一次，用 O2Z_PROXY_BOOTSTRAP 防循环）。回环不受影响：NO_PROXY 护着
 * localhost/127.0.0.1，本地代理探测和回环代理直连。
 */
function readSystemProxy() {
  if (process.env.https_proxy || process.env.HTTPS_PROXY || process.env.NODE_USE_ENV_PROXY) return null;
  if (process.env.O2Z_PROXY_BOOTSTRAP) return null;
  let server = '';
  try {
    const key = ['HKCU', 'Software', 'Microsoft', 'Windows', 'CurrentVersion', 'Internet Settings'].join('\\');
    const out = execFileSync(
      'reg',
      ['query', key, '/v', 'ProxyServer'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const m = out.match(/ProxyServer\s+REG_SZ\s+(\S+)/);
    server = (m?.[1] || '').trim();
  } catch {}
  if (!server) return null;
  // "http=..;https=..;socks=.." 取 https 段，裸 "host:port" 直接用。
  let target = server;
  for (const part of server.split(';')) {
    const p = part.trim();
    if (p.startsWith('https=')) { target = p.slice('https='.length); break; }
    if (!p.includes('=')) target = p;
  }
  if (!/^https?:\/\//i.test(target)) target = `http://${target}`;
  return target;
}

async function bootstrapViaSystemProxy() {
  const target = readSystemProxy();
  if (!target) return false;
  const { spawnSync } = await import('node:child_process');
  const env = {
    ...process.env,
    https_proxy: target,
    HTTPS_PROXY: target,
    http_proxy: target,
    HTTP_PROXY: target,
    NO_PROXY: 'localhost,127.0.0.1',
    no_proxy: 'localhost,127.0.0.1',
    NODE_USE_ENV_PROXY: '1',
    O2Z_PROXY_BOOTSTRAP: '1',
  };
  const r = spawnSync(process.execPath, [process.argv[1], ...process.argv.slice(2)], {
    env,
    stdio: 'inherit',
  });
  process.exit(r.status ?? 0);
  return true;
}
await bootstrapViaSystemProxy();

// 默认配置
const DEFAULT_PORT = 41930;
const DEFAULT_TIMEOUT_MS = 25000;

function parseArgs(argv) {
  const options = {
    port: DEFAULT_PORT,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    json: false,
    targetModel: null,
    verbose: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port') {
      options.port = parseInt(argv[++i], 10) || DEFAULT_PORT;
    } else if (arg === '--timeout') {
      options.timeoutMs = parseInt(argv[++i], 10) || DEFAULT_TIMEOUT_MS;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--model') {
      options.targetModel = argv[++i] || null;
    } else if (arg === '--verbose' || arg === '-v') {
      options.verbose = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
OpenCode 免费模型渠道连通性检测工具

参数:
  --port <number>    本地代理端口 (默认: 41930)
  --model <id>       只检测指定模型 (例如: --model exo-free)
  --timeout <ms>     单模型超时时间 (默认: 25000ms)
  --json             输出 JSON 结构化数据
  --verbose, -v      打印详细诊断信息
  --help, -h         显示帮助信息
`);
      process.exit(0);
    }
  }

  return options;
}

// 检查本地代理健康状态
async function checkProxyHealth(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return { online: false, status: res.status };
    const data = await res.json();
    return { online: true, data };
  } catch (err) {
    return { online: false, error: err.message };
  }
}

// 获取待检测的模型列表
async function discoverModels(port, targetModel, options = {}) {
  const models = [];

  // 1. 尝试从本地代理获取已暴露的 chat 模型
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`, {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = await res.json();
      for (const m of data.data || []) {
        if (!models.some((item) => item.id === m.id)) {
          models.push({ id: m.id, lane: 'chat' });
        }
      }
    }
  } catch {}

  // 2. 从本地 ZCode provider_config.json 读取已配置模型（特别是 responses 渠道）
  const candidates = [
    process.env.ZCODE_DATA_BASE_DIR
      ? path.join(process.env.ZCODE_DATA_BASE_DIR, '.zcode', 'v2', 'provider_config.json')
      : null,
    'D:/Program/.zcode/v2/provider_config.json',
    path.join(process.env.USERPROFILE || '', '.zcode', 'v2', 'provider_config.json'),
  ].filter(Boolean);

  for (const cfgPath of candidates) {
    if (fs.existsSync(cfgPath)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        const rules = cfg.config?.providerConfigRules?.providerRules || [];
        for (const r of rules) {
          if (r.providerId === 'opencode-free-responses') {
            for (const mid of r.config?.personalModelIds || []) {
              if (!models.some((item) => item.id === mid)) {
                models.push({ id: mid, lane: 'responses' });
              }
            }
          } else if (r.providerId === 'opencode-free') {
            for (const mid of r.config?.personalModelIds || []) {
              if (!models.some((item) => item.id === mid)) {
                models.push({ id: mid, lane: 'chat' });
              }
            }
          }
        }
        break;
      } catch {}
    }
  }

  // 3. 上游直连发现（关键）：代理只暴露「它判定为免费且未下架」的模型，
  //    所以有些已死的模型代理**故意不暴露**。要测全「OpenCode 提供的所有渠道」，
  //    必须自己拉一遍 Zen 实时清单 + models.dev 判定，否则测不到已下架的那些。
  await discoverFromUpstream(models, options);

  if (targetModel) {
    const matched = models.filter((m) => m.id.toLowerCase().includes(targetModel.toLowerCase()));
    // 榜单这一步已经在 discoverFromUpstream 里做完，单测命中的模型同样带规格与热度。
    if (matched.length > 0) return matched;
    // 目录里查不到时不按名字猜线路，三道都试，让实测结果说话。
    return [{ id: targetModel, lane: 'unknown', spec: null, popularity: null }];
  }

  return models;
}

/**
 * 上游直连发现：拉 Zen 实时清单 + models.dev 判定免费，得到「OpenCode 提供的
 * 全部免费渠道」，包括代理已经不再暴露的那些（已下架/已废弃的模型）。
 *
 * 通道判定：代理已配置过的按配置来；没配置过的（上游新上架、代理还没跟上，
 * 或代理判定其不可用）标成 `unknown`，实测时两条道各试一次，看哪条通。
 */
async function discoverFromUpstream(models, options) {
  const timeoutMs = options.timeoutMs || 25000;
  let zenIds = [];
  try {
    const res = await fetch('https://opencode.ai/zen/v1/models', {
      headers: {
        authorization: 'Bearer public',
        'user-agent': 'opencode/latest/2.0.21/cli',
        'x-opencode-client': 'cli',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) {
      const data = await res.json();
      zenIds = (data.data || []).map((m) => m.id);
    }
  } catch {
    return; // 上游不可达就只用代理已暴露的，不臆造
  }

  // 官方目录判定免费，并记下每个模型自己声明的线路（provider.npm）。
  // 官方目录拉不到时退回 models.dev 镜像，两者形状相同。
  let freeIds = null;
  const declaredLane = new Map();
  /** modelId → 官方目录原始条目。报告据此展开规格，目录里没有的留空不猜。 */
  const catalogMeta = new Map();
  for (const url of ['https://models.opencode.ai/api.json', 'https://models.dev/api.json']) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) continue;
      const data = await res.json();
      const section = (data.providers || data).opencode || {};
      const modelsMap = section.models || {};
      freeIds = new Set(
        Object.entries(modelsMap)
          .filter(([, m]) => (!m.cost || m.cost.input === 0) && (m.status ?? 'none') !== 'deprecated')
          .map(([id]) => id),
      );
      for (const [id, m] of Object.entries(modelsMap)) {
        declaredLane.set(id, laneFromNpm(m.provider?.npm ?? section.npm));
        catalogMeta.set(id, m);
      }
      break;
    } catch {
      /* 换下一个源 */
    }
  }

  // 若 models.dev 直连拉取失败，尝试读取本地已有的 catalog 缓存保底
  if (!freeIds) {
    const cacheCandidates = [
      process.env.ZCODE_DATA_BASE_DIR
        ? path.join(process.env.ZCODE_DATA_BASE_DIR, '.zcode', 'v2', 'opencode2zcode-catalog.json')
        : null,
      'D:/Program/.zcode/v2/opencode2zcode-catalog.json',
      path.join(process.env.USERPROFILE || '', '.zcode', 'v2', 'opencode2zcode-catalog.json'),
    ].filter(Boolean);

    for (const cPath of cacheCandidates) {
      if (fs.existsSync(cPath)) {
        try {
          const cacheData = JSON.parse(fs.readFileSync(cPath, 'utf8'));
          if (Array.isArray(cacheData.prices) && cacheData.prices.length > 0) {
            freeIds = new Set(
              cacheData.prices
                .filter(([, m]) => (!m.input || m.input === 0) && !m.deprecated)
                .map(([id]) => id),
            );
            break;
          }
        } catch {}
      }
    }
  }

  for (const id of zenIds) {
    if (models.some((m) => m.id === id)) continue;
    // 只有在免费名单内、或名字显式带 free 的才纳入探测队列；
    // 绝不将 80+ 个付费商业模型错误加入探测队列
    if (freeIds) {
      if (!freeIds.has(id) && !id.toLowerCase().includes('free')) continue;
    } else {
      if (!id.toLowerCase().includes('free')) continue;
    }
    models.push({ id, lane: declaredLane.get(id) || 'unknown' });
  }

  // 规格挂在每个模型上，报告表和 JSON 输出都能用。代理/配置里发现的模型
  // 同样补一份——它们本来就在目录里，不补就看不到规格。
  for (const m of models) {
    const meta = catalogMeta.get(m.id);
    m.spec = meta ? specFromCatalog(meta) : null;
    if (!m.lane) m.lane = declaredLane.get(m.id) || 'unknown';
  }

  // OpenRouter 使用量榜单：第三方真实调用热度，用来给"档位"做佐证。
  // 拉不到就整体降级（不阻塞探测），每个模型只是少了热度字段。
  await attachPopularity(models, options);
}

/**
 * Zen 免费 id → OpenRouter 基座 slug 片段。
 *
 * Zen 免费模型全是各家厂商模型的免费/预览变体（如 muse-spark-1.3-contributor-free
 * 对应 meta/muse-spark-1.3-contributor-20260902），榜单上没有同名条目。
 * 规则：去掉 -free 后缀，按包含关系匹配；big-pickle、exo、longcat、fledge
 * 这些榜单里没有的，对不上就认——不硬凑。
 */
function popularityKey(zenId) {
  return zenId.toLowerCase().replace(/-free$/, '');
}

function matchRankRow(zenId, rows) {
  const key = popularityKey(zenId);
  if (!key) return null;
  let best = null;
  for (const row of rows) {
    const slug = String(row.model_permaslug || '').toLowerCase();
    if (!slug) continue;
    const tail = slug.split('/').pop();
    if (slug.includes(key) || tail.includes(key) || key.includes(tail)) {
      // 同一基座多个变体时取调用量最大的那个。
      if (!best || (row.count || 0) > (best.count || 0)) best = row;
    }
  }
  return best;
}

/**
 * 拉 OpenRouter 日榜（免 key），给每个模型挂上基座的调用量与全站排名。
 *
 * 这是"真实调用热度"，不是"能力跑分"：调用量大说明用的人多、生态成熟，
 * 不能反推模型能力强。报告里必须带着这个限定说。
 * 榜单 655 个模型，Zen 免费里约 11/15 能对上基座；对不上的不降级、
 * 不扣分，只是没有热度佐证。
 */
async function attachPopularity(models, options) {
  const timeoutMs = options.timeoutMs || 25000;
  let rows = null;
  try {
    const res = await fetch('https://openrouter.ai/api/frontend/v1/rankings/models', {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return;
    const data = await res.json();
    rows = Array.isArray(data) ? data : data.data;
    if (!Array.isArray(rows) || rows.length === 0) return;
  } catch {
    return; // 榜单拉不到就降级：探测照常，报告里不显示热度
  }
  // 榜单接口返回的是**按消费额（美元）降序**的顺序，不是按调用量。
  // 直接用下标当名次会得出「调用 10 亿次却排 #283、调用 1700 万次却排 #1」
  // 这种自相矛盾的结果——调用量大的便宜模型会被排到很后面，名次和
  // 显示的调用次数自相矛盾，用户一眼就觉得数据错了。
  // 所以自己按 count 降序重算名次。
  const byCount = [...rows].sort((a, b) => (b.count || 0) - (a.count || 0));
  const rankBySlug = new Map();
  byCount.forEach((row, index) => {
    const slug = String(row.model_permaslug || '');
    if (slug && !rankBySlug.has(slug)) rankBySlug.set(slug, index + 1);
  });

  for (const m of models) {
    const hit = matchRankRow(m.id, rows);
    if (!hit) {
      m.popularity = null;
      continue;
    }
    m.popularity = {
      slug: hit.model_permaslug,
      // 按调用量重算的名次。
      rank: rankBySlug.get(String(hit.model_permaslug)) || null,
      of: rows.length,
      count: hit.count || 0,
    };
  }
}

/** 官方目录的 SDK 包名 → 线路。没声明或本工具代理不了的，交给实测去试。 */
function laneFromNpm(npm) {
  const value = String(npm ?? '').trim().toLowerCase();
  if (value === '@ai-sdk/openai' || value.endsWith('/openai')) return 'responses';
  if (value.includes('openai-compatible')) return 'chat';
  return null;
}

/**
 * 官方目录条目 → 选型要看的规格。字段全部来自目录原文，不做任何推测：
 * 目录没写的就是 null，报告里显示「未知」而不是编一个数。
 */
function specFromCatalog(meta) {
  const limit = meta.limit || {};
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
  const effortValues = [];
  for (const option of Array.isArray(meta.reasoning_options) ? meta.reasoning_options : []) {
    if (option?.type !== 'effort' || !Array.isArray(option.values)) continue;
    for (const value of option.values) {
      if (typeof value === 'string' && value && !effortValues.includes(value)) effortValues.push(value);
    }
  }
  return {
    displayName: typeof meta.name === 'string' && meta.name ? meta.name : null,
    contextWindow: num(limit.context),
    maxOutput: num(limit.output),
    reasoning: meta.reasoning === true,
    effortValues,
    toolCall: meta.tool_call === true,
    structuredOutput: meta.structured_output === true,
    inputModalities: Array.isArray(meta.modalities?.input)
      ? meta.modalities.input.map(String)
      : [],
    /** 目录标了 deprecated：实测可能仍通，但上游随时会撤，选型要知道。 */
    deprecated: metaDeprecated(meta),
  };
}

function metaDeprecated(meta) {
  if (meta.deprecated === true) return true;
  const status = String(meta.status ?? meta.lifecycle ?? '').toLowerCase();
  return status === 'deprecated' || status === 'retired' || status === 'disabled';
}

/** 1245184 → "1.2M"，128000 → "128K"。报告里一眼看得出量级。 */
function formatTokens(value) {
  if (value === null) return '未知';
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  if (value >= 1000) return `${Math.round(value / 1000)}K`;
  return String(value);
}

/**
 * 实测状态 → 档位。只看"现在能不能调通"，不看参数：
 *   S  实测畅通
 *   A  地区受限（换节点就能用，模型本身没问题）
 *   B  端点未就绪或限流（临时状态，过阵子可能好）
 *   C  官方已下架、门禁拦截、需真实 key、未知错误（现在调不通）
 *
 * 档位解决的是"你先试哪个"：S 闭眼用，A 换节点用，B 等一等，C 别浪费时间。
 * 它回答不了"A 模型和 B 模型谁更聪明"——那是能力问题，不是连通问题。
 */
function tierFor(result) {
  switch (result.category) {
    case 'ACTIVE':
      return { tier: 'S', label: '主力可用' };
    case 'REGION_BLOCKED':
      return { tier: 'A', label: '换节点可用' };
    case 'ENDPOINT_NOT_READY':
      return { tier: 'B', label: '暂不可用' };
    default:
      return { tier: 'C', label: '当前不可用' };
  }
}

/** 1245184 → "1.2M"。无数据时显示"—"，不编数。 */
function formatRank(popularity) {
  if (!popularity) return '—';
  return `#${popularity.rank}/${popularity.of}`;
}

/** 调用量 42351013 → "4235万次/日"，太小的如实写。 */
function formatCount(count) {
  if (!count) return '—';
  if (count >= 100_000_000) return `${(count / 100_000_000).toFixed(1)}亿次/日`;
  if (count >= 10_000) return `${Math.round(count / 10_000)}万次/日`;
  return `${count}次/日`;
}

// 分类体系判定函数
function classifyError(status, text) {
  const lower = (text || '').toLowerCase();

  // 1. 网络位置/地区拒绝服务 (RegionError / Country Not Allowed)
  if (
    lower.includes('regionerror') ||
    lower.includes('not available in your country') ||
    lower.includes('country not allowed') ||
    lower.includes('geographic restriction')
  ) {
    return {
      category: 'REGION_BLOCKED',
      statusBadge: '🌍 地区受限',
      diagnosis: '上游服务商对当前网络出口 IP 所在地区限制访问。',
      suggestion: '非模型失效。切换代理至支持的国家/地区节点（如香港、新加坡、美国、日本）即可恢复使用。',
    };
  }

  // 3.5 需要真实 API key（该模型不在匿名免费通道内）
  if (
    lower.includes('missing api key') ||
    lower.includes('autherror') ||
    (status === 401 && lower.includes('api key'))
  ) {
    return {
      category: 'NEEDS_API_KEY',
      statusBadge: '🔑 需真实 API Key',
      diagnosis: '上游要求有效凭据，该模型不在匿名免费通道内。',
      suggestion: '本工具用的是匿名免费凭据（public），此模型需要你自己的 OpenCode API key，改代理配置才能用。',
    };
  }

  // 2. 本身已不再提供免费渠道 / 已废弃 / 已下线
  if (
    status === 410 ||
    lower.includes('modeldeprecated') ||
    lower.includes('has been deprecated') ||
    // 注意：不要用裸 status===401 —— AuthError(Missing API key) 也是 401，
    // 那是"需要真实凭据"而非"模型下架"，已在上面单独分类。
    // 文案里模型名会插在中间（"Model fledge-alpha-free is not supported"），
    // 所以不能拿整句做字面量匹配。
    (lower.includes('is not supported') && lower.includes('model')) ||
    (status === 400 && lower.includes('model is unavailable')) ||
    (status === 400 && lower.includes('model not found'))
  ) {
    return {
      category: 'CHANNEL_REMOVED',
      statusBadge: '🚫 官方已下架',
      diagnosis: '官方已终止该免费渠道，或模型已被彻底下架/废弃。',
      suggestion: '渠道已永久失效。更换代理节点无法解决，请在模型列表中停用或避免选择。',
    };
  }

  // 3. 服务端点未就绪 / 临时排队熔断
  if (
    status === 429 ||
    lower.includes('endpoint is unavailable') ||
    lower.includes('rate limit') ||
    lower.includes('freeusagelimiterror') ||
    status === 503 ||
    lower.includes('upstream error from provider')
  ) {
    return {
      category: 'ENDPOINT_NOT_READY',
      statusBadge: '⏳ 端点未就绪/限流',
      diagnosis: '上游推理端点尚未开机/服务暂时未接入流量，或触发 IP 频控限制。',
      suggestion: '对于新上线 Preview 模型（如 exo-free）代表官方推理服务暂未就绪；若因限流可稍后重试。',
    };
  }

  // 3.2 该模型不支持当前协议/通道（说明它只存在于别的通道，不是模型本身失效）
  if (lower.includes('modelprotocolunsupported') || lower.includes('does not support this protocol')) {
    return {
      category: 'LANE_UNSUPPORTED',
      statusBadge: '🚫 该道不支持',
      diagnosis: '此模型不在当前通道上。',
      suggestion: '需换用该模型实际所属的通道再判定。',
    };
  }

  // 4. 免费通道门禁未过
  if (
    status === 403 ||
    lower.includes('freetiererror') ||
    lower.includes('can only be used from within opencode')
  ) {
    return {
      category: 'GATE_FAILED',
      statusBadge: '🔒 门禁拦截',
      diagnosis: '上游校验判定客户端非 OpenCode 官方环境。',
      suggestion: '代理尚未对该请求正确注入 bash/read 门禁桩或请求头不匹配。',
    };
  }

  // 5. 其它一般错误
  return {
    category: 'UPSTREAM_ERROR',
    statusBadge: `❌ 异常 (${status})`,
    diagnosis: `上游返回未识别错误: ${text.slice(0, 120)}`,
    suggestion: '检查上游服务或本地网络配置。',
  };
}

/// 上游直连地址与伪装头。systemone 这条道本工具没有代理，只能直连探测。
const UPSTREAM_BASE = 'https://opencode.ai/zen';

const PROBE_BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
function probeBase62Fixed(value, width) {
  let n = BigInt(value);
  const base = 62n;
  const out = new Array(width);
  for (let i = width - 1; i >= 0; i--) {
    out[i] = PROBE_BASE62.charAt(Number(n % base));
    n /= base;
  }
  return out.join('');
}

function probeMintSession(now = Date.now()) {
  const current = BigInt(now) * 0x1000n + 1n;
  const inverted = (~current) & 0xffffffffffffn;
  const timePart = inverted.toString(16).padStart(12, '0');
  const sum = importHash('probe-zen-session');
  return `ses_${timePart}${sum}`;
}

function importHash(signal) {
  const crypto = globalThis.crypto;
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return probeBase62Fixed(BigInt('0x' + hex), 14);
}

function probeMintRequest(now = Date.now()) {
  const current = BigInt(now) * 0x1000n + 1n;
  const timePart = (current & 0xffffffffffffn).toString(16).padStart(12, '0');
  return `msg_${timePart}${importHash('req')}`;
}

function getUpstreamDirectHeaders() {
  const session = probeMintSession();
  return {
    authorization: 'Bearer public',
    'user-agent': 'opencode/1.18.31 (win32 x64; node20)',
    'x-opencode-client': 'cli',
    'x-opencode-session': session,
    'x-session-affinity': session,
    'x-session-id': session,
    'x-opencode-request': probeMintRequest(),
    'x-opencode-project': 'prj_0123456789abcdef01234567',
    accept: 'application/json',
  };
}

// 测试单个模型（单次请求）
async function probeOnce(port, modelInfo, timeoutMs) {
  const lane = modelInfo.lane;
  const isResponses = lane === 'responses';
  const isSystemone = lane === 'systemone';

  // systemone 本工具没有代理，直连上游测（否则只能报"连不上本地代理"，是假象）
  const url = isSystemone
    ? `${UPSTREAM_BASE}/v1/systemone`
    : `http://127.0.0.1:${port}/v1/${isResponses ? 'responses' : 'chat/completions'}`;

  const body = isResponses || isSystemone
    ? { model: modelInfo.id, input: 'Hi' }
    : { model: modelInfo.id, stream: false, messages: [{ role: 'user', content: 'Hi' }] };
  if (isSystemone) body.stream = false;

  const startTime = Date.now();
  try {
    const directHeaders = isSystemone ? getUpstreamDirectHeaders() : null;
    let res = await fetch(url, {
      method: 'POST',
      headers: isSystemone
        ? { ...directHeaders, 'content-type': 'application/json' }
        : { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    // systemone 道的模型名不带 "-free" 后缀（Zen 清单里带、实际路由不带，
    // muse-spark 同规律）。命中 400 Invalid request 时去掉后缀重试一次，
    // 否则这类模型会被永远判成"未能判定"。
    if (isSystemone && res.status === 400 && modelInfo.id.endsWith('-free')) {
      const stripped = { ...body, model: modelInfo.id.slice(0, -'-free'.length) };
      res = await fetch(url, {
        method: 'POST',
        headers: { ...directHeaders, 'content-type': 'application/json' },
        body: JSON.stringify(stripped),
        signal: AbortSignal.timeout(timeoutMs),
      });
    }
    const latencyMs = Date.now() - startTime;
    const rawText = await res.text();

    if (res.status === 200) {
      let snippet = '';
      try {
        const json = JSON.parse(rawText);
        snippet =
          json.choices?.[0]?.message?.content ||
          json.output?.[0]?.content?.[0]?.text ||
          json.text ||
          json.content?.[0]?.text ||
          '';
      } catch {
        snippet = rawText.slice(0, 80);
      }
      return {
        model: modelInfo.id,
        lane,
        status: 200,
        latencyMs,
        category: 'ACTIVE',
        statusBadge: '✅ 畅通可用',
        diagnosis: isSystemone ? '通过直连上游的 systemone 通道调用成功（本工具未代理该道）。' : '模型连接正常，推理输出完整。',
        suggestion: isSystemone
          ? '该模型只能走 systemone 通道，本工具的代理没有这一道，需扩展代理或直连使用。'
          : '可放心在 ZCode 中作为日常模型使用。',
        snippet: snippet.trim().replace(/\s+/g, ' ').slice(0, 80),
        spec: modelInfo.spec ?? null,
        popularity: modelInfo.popularity ?? null,
      };
    }

    return {
      model: modelInfo.id,
      lane,
      status: res.status,
      latencyMs,
      rawError: rawText,
      ...classifyError(res.status, rawText),
      spec: modelInfo.spec ?? null,
        popularity: modelInfo.popularity ?? null,
    };
  } catch (err) {
    return {
      model: modelInfo.id,
      lane,
      status: 0,
      latencyMs: Date.now() - startTime,
      category: 'NETWORK_TIMEOUT',
      statusBadge: '⏱️ 请求超时/中断',
      diagnosis: `请求异常: ${err.message}`,
      suggestion: '请确认本地代理服务正常运行且端口正确。',
      spec: modelInfo.spec ?? null,
        popularity: modelInfo.popularity ?? null,
    };
  }
}

/**
 * 结果信息量排名（越大越具体）。多道探测时按它择优，避免"未识别错误"
 * 覆盖掉后续通道给出的精确分类。
 */
const RESULT_RANK = {
  ACTIVE: 100,
  NEEDS_API_KEY: 80,
  REGION_BLOCKED: 80,
  CHANNEL_REMOVED: 80,
  GATE_FAILED: 75,
  ENDPOINT_NOT_READY: 60,
  LANE_UNSUPPORTED: 20,
  NETWORK_TIMEOUT: 15,
  UPSTREAM_ERROR: 5,
};
const rankResult = (r) => RESULT_RANK[r?.category] ?? 0;

// 瞬时类错误的重试次数：429（IP 频控）/ 5xx 上游抖动 —— 单次不算结论
const TRANSIENT_RETRY = 2;

/**
 * 测试单个模型，带瞬时错误重试与双通道探测。
 *
 * 429 不作单次结论：实测单发 429 的模型复测两次都是 200，直接报「端点未就绪」
 * 会给出错误判断。只有连续 N 次都失败，才归为端点未就绪/限流。
 */
async function probeModel(port, modelInfo, timeoutMs) {
  // 通道未知时三道都试：chat / responses / systemone（第三道本工具未代理）
  const lanes = modelInfo.lane === 'unknown' ? ['chat', 'responses', 'systemone'] : [modelInfo.lane];
  let best = null;
  let lastTransient = null;

  for (const lane of lanes) {
    let attempt = 0;
    for (;;) {
      const r = await probeOnce(port, { ...modelInfo, lane }, timeoutMs);
      const transient = r.status === 429 || r.status === 503 || r.category === 'NETWORK_TIMEOUT';
      if (transient && attempt < TRANSIENT_RETRY) {
        attempt += 1;
        lastTransient = r;
        await new Promise((resolve) => setTimeout(resolve, 1200 * attempt));
        continue;
      }
      // 结果择优：只有 ACTIVE 会覆盖，这会**丢掉后续通道更精确的分类**
      // （例如 chat 道报"不支持该协议"、systemone 道报"需真实 key"，
      //  最终却被前者的"未识别错误"盖住，结论退化成"未能判定"）。
      // 改为按信息量择优：实测可用 > 已识别分类 > 未识别错误。
      if (!best || rankResult(r) > rankResult(best)) best = r;
      break;
    }
  }

  const result = best || lastTransient;
  if (result && modelInfo.lane === 'unknown' && result.category === 'UPSTREAM_ERROR') {
    result.statusBadge = '❔ 未能判定';
    result.diagnosis = 'chat / responses / systemone 三道均未成功，且错误不属于已知分类。';
    result.suggestion = '可能是本工具未代理的其它通道，或上游对请求体有额外要求；可查看原始错误。';
  }
  if (result.retries) result.note = `（重试 ${result.retries} 次后结论）`;
  if (result.category === 'ENDPOINT_NOT_READY' && lastTransient) {
    result.diagnosis = `连续 ${TRANSIENT_RETRY + 1} 次均失败：上游推理端点尚未就绪，或触发 IP 级频控限制。`;
  }
  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  // 1. 检查代理
  const proxyHealth = await checkProxyHealth(options.port);
  if (!proxyHealth.online) {
    if (options.json) {
      console.log(
        JSON.stringify({
          ok: false,
          error: 'PROXY_UNREACHABLE',
          message: `无法连接到本地代理 http://127.0.0.1:${options.port}`,
        }),
      );
      process.exit(1);
    }

    console.error(`\n❌ [错误] 本地回环代理未就绪 (http://127.0.0.1:${options.port})`);
    console.error(`   诊断: 代理未在后台运行或端口被占用。`);
    console.error(`   建议: 请先运行 'opencode2zcode.exe' 或执行 'opencode2zcode.exe --install' 安装自启动。\n`);
    process.exit(1);
  }

  // 2. 发现模型
  const models = await discoverModels(options.port, options.targetModel, options);

  if (!options.json) {
    console.log(`\n======================================================`);
    console.log(`🔍 OpenCode 免费模型渠道连通性检测`);
    console.log(`   代理端口: ${options.port} | 候选模型数: ${models.length}`);
    console.log(`======================================================\n`);
  }

  const results = [];
  for (const m of models) {
    if (!options.json) {
      process.stdout.write(`⏳ 正在测试 [${m.lane.padEnd(9)}] ${m.id.padEnd(32)} ... `);
    }
    const r = await probeModel(options.port, m, options.timeoutMs);
    results.push(r);
    if (!options.json) {
      console.log(r.statusBadge);
    }
    // 适当防频控间隔
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  if (options.json) {
    // rawError 是上游报错原文，仅供人看；JSON 输出只留下分类与诊断，不往外倒原文。
    // 档位与热度带上，方便 skill / agent 直接消费。
    const safe = results.map(({ rawError, ...rest }) => ({
      ...rest,
      tier: tierFor(rest).tier,
      tierLabel: tierFor(rest).label,
    }));
    console.log(JSON.stringify({ ok: true, proxy: proxyHealth.data, results: safe }, null, 2));
    return;
  }

  // 生成报告：一张表搞定。原先分「连通性看板」和「选型参考」两张，
  // 用户要的是一眼看全，所以合并成一张，按档位排序。
  const tierOrder = { S: 0, A: 1, B: 2, C: 3 };
  const ranked = results
    .map((r) => ({ r, tier: tierFor(r) }))
    .sort((a, b) => tierOrder[a.tier.tier] - tierOrder[b.tier.tier]
      || a.r.model.localeCompare(b.r.model));

  console.log(`\n=================== 📊 OpenCode 免费模型体检报告 ===================\n`);

  console.log(
    '> **档位只看"现在能不能调通"，不评价模型聪明不聪明。** S 闭眼用，A 换节点用，',
  );
  console.log(
    '> B 过阵子再试，C 别浪费时间。参数相同的两个模型能力可能天差地别——想知道谁更强，',
  );
  console.log(
    '> 看"社区热度"列：那是 OpenRouter 全站真实调用量（655 个模型的日榜），用的人多',
  );
  console.log(
    '> 说明生态成熟、踩坑的人多，但**热度高不等于能力强**，只是个第三方佐证。',
  );
  console.log(
    '> 对不上的（榜单里没有对应基座）显示"—"，不扣分、不降级，只是不佐证。\n',
  );

  const deprecatedButAlive = ranked.filter(
    ({ r }) => r.spec?.deprecated && r.category === 'ACTIVE',
  );
  if (deprecatedButAlive.length > 0) {
    console.log(
      `> ⚠️ ${deprecatedButAlive.length} 个模型**目录已标废弃但实测仍通**（${deprecatedButAlive
        .map(({ r }) => `\`${r.model}\``)
        .join('、')}）。现在能调，但上游随时会撤，别作为长期依赖。`,
    );
    console.log('> 这也是它们不出现在 ZCode 模型列表里的原因——宁可少给，不给随时会失效的。\n');
  }

  console.log(`| 模型 ID | 状态及核心诊断 | 上下文 | 档位 | 社区热度 |`);
  console.log(`| :--- | :--- | ---: | :---: | :--- |`);
  for (const { r, tier } of ranked) {
    const spec = r.spec;
    const ctx = spec ? formatTokens(spec.contextWindow) : '未知';
    // 状态列带一句核心诊断，用户不用翻后面的清单就知道该怎么办。
    // 目录标了废弃的补一句——实测仍通只是"现在还能用"，不是长期保证。
    const deprecated = spec?.deprecated ? ' ⚠️目录已废弃' : '';
    // 畅通的模型不用展示输出内容——HTTP 200 已经证明它能用了，
    // 输出多半是"Hi there!"这类打招呼，纯噪音还挤爆表格。
    // 只有异常状态才需要一句诊断，告诉用户到底怎么回事。
    const detail = r.category === 'ACTIVE' ? '' : `<br>${r.diagnosis}`;
    const statusCell = `${r.statusBadge}${deprecated}${detail}`;
    const tierCell = `**${tier.tier}** ${tier.label}`;
    const heat = r.popularity
      ? `${formatRank(r.popularity)} · ${formatCount(r.popularity.count)}`
      : '—';
    console.log(`| **${r.model}** | ${statusCell} | ${ctx} | ${tierCell} | ${heat} |`);
  }
  console.log();

  console.log(`\n=================== 💡 行动建议 ===================\n`);

  const byTier = (tier) => ranked.filter((x) => x.tier.tier === tier);
  const sList = byTier('S');
  const aList = byTier('A');
  const bList = byTier('B');
  const cList = byTier('C');

  if (sList.length > 0) {
    console.log(`### ✅ S 主力可用 (${sList.length} 个)：直接用，无需任何操作`);
    // 同为 S 档时按上下文从大到小推荐，长文档场景优先。
    for (const { r } of sList.slice().sort((a, b) =>
      (b.r.spec?.contextWindow ?? 0) - (a.r.spec?.contextWindow ?? 0))) {
      const ctx = r.spec ? formatTokens(r.spec.contextWindow) : '未知';
      const heat = r.popularity ? `、热度 ${formatRank(r.popularity)}` : '';
      const warn = r.spec?.deprecated ? '（目录已废弃，建议只作临时备用）' : '';
      console.log(`- **${r.model}** — 上下文 ${ctx}${heat}${warn}`);
    }
    console.log();
  }

  if (aList.length > 0) {
    console.log(`### 🌍 A 换节点可用 (${aList.length} 个)：模型没问题，换代理节点即可`);
    for (const { r } of aList) {
      console.log(`- **${r.model}** — 切换到香港/新加坡/美国/日本等节点后重试`);
    }
    console.log();
  }

  if (bList.length > 0) {
    console.log(`### ⏳ B 暂不可用 (${bList.length} 个)：临时状态，过阵子再试`);
    for (const { r } of bList) {
      console.log(`- **${r.model}** — ${r.diagnosis}`);
    }
    console.log();
  }

  if (cList.length > 0) {
    console.log(`### 🚫 C 当前不可用 (${cList.length} 个)：别浪费时间`);
    for (const { r } of cList) {
      console.log(`- **${r.model}** — ${r.diagnosis}`);
      console.log(`  - 处方: ${r.suggestion}`);
    }
    console.log();
  }

  console.log(`==========================================================\n`);
}

main().catch((err) => {
  console.error('[probe-channels] 运行失败:', err);
  process.exit(1);
});
