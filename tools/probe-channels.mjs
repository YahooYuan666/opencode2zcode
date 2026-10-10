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
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, '..');

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
    if (matched.length > 0) return matched;
    // 目录里查不到时不按名字猜线路，三道都试，让实测结果说话。
    return [{ id: targetModel, lane: 'unknown' }];
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

/**
 * 规格参考分的逐项明细与总分。
 *
 * **这不是模型能力评分，也不是社区评分**：目前没有任何社区榜单或公开基准
 * 覆盖 Zen 免费模型，这里只是把目录里已经写明的纸面参数按固定权重折算，
 * 方便横向对照"配置上限"。权重与口径和 provider-fetcher 完全一致
 * （上下文 40 / 最大输出 20 / 推理档位 15 / 工具调用 15 / 多模态输入 6 /
 * 结构化输出 4，合计 100），两个工具对同一模型给出的分数相同。
 * 纸面参数漂亮不代表实际表现好，选型以自己的实测为准。
 */
const SPEC_WEIGHTS = {
  context: 40,
  output: 20,
  reasoning: 15,
  toolCall: 15,
  modalities: 6,
  structured: 4,
};

/** 明细标签用中文，和表头一致；顺序即折算顺序。 */
const SPEC_LABELS = [
  ['context', '上下文'],
  ['output', '最大输出'],
  ['reasoning', '推理档位'],
  ['toolCall', '工具调用'],
  ['modalities', '多模态输入'],
  ['structured', '结构化输出'],
];

function contextPoints(value) {
  if (value === null) return 0;
  for (const [threshold, points] of [[1_000_000, 40], [400_000, 34], [200_000, 28], [128_000, 22], [32_000, 12]]) {
    if (value >= threshold) return points;
  }
  return 6;
}

function outputPoints(value) {
  if (value === null) return 0;
  for (const [threshold, points] of [[256_000, 20], [128_000, 16], [64_000, 12], [32_000, 8]]) {
    if (value >= threshold) return points;
  }
  return 4;
}

function reasoningPoints(spec) {
  if (!spec.reasoning) return 0;
  const levels = spec.effortValues;
  if (levels.some((level) => level === 'max' || level === 'xhigh')) return 15;
  if (levels.length >= 3) return 10;
  return 5;
}

function specBreakdown(spec) {
  if (!spec) return null;
  return {
    context: contextPoints(spec.contextWindow),
    output: outputPoints(spec.maxOutput),
    reasoning: reasoningPoints(spec),
    toolCall: spec.toolCall ? SPEC_WEIGHTS.toolCall : 0,
    modalities: Math.min(SPEC_WEIGHTS.modalities, 2 * Math.max(0, spec.inputModalities.length - 1)),
    structured: spec.structuredOutput ? SPEC_WEIGHTS.structured : 0,
  };
}

function specScore(spec) {
  const breakdown = specBreakdown(spec);
  if (!breakdown) return null;
  return Object.values(breakdown).reduce((sum, points) => sum + points, 0);
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

/** 档位阶梯："none" 是关闭思考，报告里显示成 off 更像人话。 */
function formatEfforts(spec) {
  if (!spec || !spec.reasoning) return '—';
  const levels = spec.effortValues.map((v) => (v === 'none' ? 'off' : v));
  return levels.length > 0 ? levels.join(' → ') : '支持';
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
const UPSTREAM_HEADERS = {
  authorization: 'Bearer public',
  'user-agent': 'opencode/latest/2.0.21/cli',
  'x-opencode-client': 'cli',
  'x-opencode-session': 'ses_f07de6fa9ffe753Eu4qlyXU0sC',
  accept: 'application/json',
};

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
    let res = await fetch(url, {
      method: 'POST',
      headers: isSystemone
        ? { ...UPSTREAM_HEADERS, 'content-type': 'application/json' }
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
        headers: { ...UPSTREAM_HEADERS, 'content-type': 'application/json' },
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
      console.log(`${r.statusBadge} (${r.latencyMs}ms)`);
    }
    // 适当防频控间隔
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  if (options.json) {
    // rawError 是上游报错原文，仅供人看；JSON 输出只留下分类与诊断，不往外倒原文。
    const safe = results.map(({ rawError, ...rest }) => rest);
    console.log(JSON.stringify({ ok: true, proxy: proxyHealth.data, results: safe }, null, 2));
    return;
  }

  // 生成格式化分类报告
  const activeList = results.filter((r) => r.category === 'ACTIVE');
  const regionList = results.filter((r) => r.category === 'REGION_BLOCKED');
  const removedList = results.filter((r) => r.category === 'CHANNEL_REMOVED');
  const notReadyList = results.filter((r) => r.category === 'ENDPOINT_NOT_READY');
  const otherList = results.filter(
    (r) => !['ACTIVE', 'REGION_BLOCKED', 'CHANNEL_REMOVED', 'ENDPOINT_NOT_READY'].includes(r.category),
  );

  console.log(`\n=================== 📊 连通性检测看板 ===================\n`);

  console.log(`| 模型 ID | 通道 | 状态 | 耗时 | 诊断详情 |`);
  console.log(`| :--- | :--- | :--- | :--- | :--- |`);
  for (const r of results) {
    const detail = r.snippet ? `输出: "${r.snippet}"` : r.diagnosis;
    console.log(`| **${r.model}** | \`${r.lane}\` | ${r.statusBadge} | ${r.latencyMs}ms | ${detail} |`);
  }

  console.log(`\n=================== 📐 规格与选型参考 ===================\n`);

  console.log(
    '> **先说清楚：这里没有社区评分。** 目前没有任何社区榜单或公开基准覆盖 Zen 免费模型，',
  );
  console.log(
    '> 下面是官方目录里写明的纸面参数，加上本工具按固定权重折算的「规格参考分」。权重口径与',
  );
  console.log(
    '> provider-fetcher 完全一致（上下文 40 / 最大输出 20 / 推理档位 15 / 工具调用 15 /',
  );
  console.log(
    '> 多模态输入 6 / 结构化输出 4，满分 100），两个工具对同一模型给出的分数相同。',
  );
  console.log(
    '> **纸面参数好看不代表实际表现好**，选型请以自己的实测为准。连通性见上一张表。',
  );
  console.log(
    '> 用法：上下文决定能吃多长的文档；档位越多可调的思考深度越细；图像输入决定能不能贴图。\n',
  );

  const scored = results
    .map((r) => ({ r, score: specScore(r.spec) }))
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.r.model.localeCompare(b.r.model));

  const deprecatedButAlive = scored.filter(
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

  console.log(`| 模型 ID | 状态 | 上下文窗口 | 最大输出 | 推理档位 | 图像 | 工具调用 | 结构化 | 规格参考分 |`);
  console.log(`| :--- | :--- | ---: | ---: | :--- | :---: | :---: | :---: | ---: |`);
  for (const { r, score } of scored) {
    const spec = r.spec;
    const breakdown = specBreakdown(spec);
    const scoreCell = score === null
      ? '未知'
      : `**${score}**/100<br>${SPEC_LABELS
        .map(([key, label]) => `${label} ${breakdown[key]}/${SPEC_WEIGHTS[key]}`)
        .join(' · ')}`;
    // 目录标了废弃的，状态后面跟一句——实测仍通只是"现在还能用"，不是长期保证。
    const statusCell = spec?.deprecated ? `${r.statusBadge} ⚠️目录已废弃` : r.statusBadge;
    console.log(
      `| **${r.model}** | ${statusCell} | ${spec ? formatTokens(spec.contextWindow) : '未知'} | `
      + `${spec ? formatTokens(spec.maxOutput) : '未知'} | ${spec ? formatEfforts(spec) : '未知'} | `
      + `${spec && spec.inputModalities.includes('image') ? '✅' : '—'} | `
      + `${spec?.toolCall ? '✅' : '—'} | ${spec?.structuredOutput ? '✅' : '—'} | ${scoreCell} |`,
    );
  }
  console.log();

  console.log(`\n=================== 💡 详细归因与行动建议 ===================\n`);

  if (activeList.length > 0) {
    console.log(`### ✅ 畅通可用模型 (${activeList.length} 个)`);
    console.log(`> 这些模型当前随时可在 ZCode 对话中正常使用：`);
    for (const r of activeList) {
      console.log(`- **${r.model}** (${r.latencyMs}ms)`);
    }
    console.log();
  }

  if (regionList.length > 0) {
    console.log(`### 🌍 网络位置/地区受限模型 (${regionList.length} 个)`);
    console.log(`> ⚠️ **核心说明**：此问题**不是**模型下架失效，而是因为上游对当前出口 IP 所在国家/地区限制。`);
    for (const r of regionList) {
      console.log(`- **${r.model}** (上游错误: ${r.status})`);
      console.log(`  - 处方: 切换代理节点至支持的区域（如香港、新加坡、美国、日本等）后即可正常连接。`);
    }
    console.log();
  }

  if (removedList.length > 0) {
    console.log(`### 🚫 官方已下架/已废弃模型 (${removedList.length} 个)`);
    console.log(`> ⚠️ **核心说明**：上游已从免费渠道或推理后端永久撤下，**更换任何代理节点都无法使用**。`);
    for (const r of removedList) {
      console.log(`- **${r.model}** (状态码: ${r.status})`);
      console.log(`  - 处方: 渠道已永久失效，建议在模型选择器中忽略或隐藏。`);
    }
    console.log();
  }

  if (notReadyList.length > 0) {
    console.log(`### ⏳ 端点未就绪 / 临时排队熔断模型 (${notReadyList.length} 个)`);
    console.log(`> ⚠️ **核心说明**：官方已公布但在上游暂未开机路由（如新出的预览模型），或触发了并发限流。`);
    for (const r of notReadyList) {
      console.log(`- **${r.model}** (状态码: ${r.status})`);
      console.log(`  - 说明: 如 \`exo-free\` 属于上游刚挂牌预览但推理端点尚未接入流量；可关注官方后续开机。`);
    }
    console.log();
  }

  if (otherList.length > 0) {
    console.log(`### ⚠️ 其它异常模型 (${otherList.length} 个)`);
    for (const r of otherList) {
      console.log(`- **${r.model}**: ${r.diagnosis}`);
    }
    console.log();
  }

  console.log(`==========================================================\n`);
}

main().catch((err) => {
  console.error('[probe-channels] 运行失败:', err);
  process.exit(1);
});
