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
async function discoverModels(port, targetModel) {
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

  // 3. 内置知名免费模型兜底保底列表
  const knownFreeModels = [
    { id: 'big-pickle', lane: 'chat' },
    { id: 'exo-free', lane: 'chat' },
    { id: 'fledge-alpha-free', lane: 'chat' },
    { id: 'ling-3.0-flash-fin-free', lane: 'chat' },
    { id: 'ling-3.1-flash-free', lane: 'chat' },
    { id: 'longcat-2.5-preview-free', lane: 'chat' },
    { id: 'mimo-v2.6-flash-free', lane: 'chat' },
    { id: 'nemotron-3-ultra-free', lane: 'chat' },
    { id: 'nemotron-3.5-lightning-free', lane: 'chat' },
    { id: 'space-bunny-free', lane: 'chat' },
    { id: 'step-5-preview-free', lane: 'chat' },
    { id: 'muse-spark-1.3-contributor-free', lane: 'responses' },
  ];

  for (const k of knownFreeModels) {
    if (!models.some((item) => item.id === k.id)) {
      models.push(k);
    }
  }

  if (targetModel) {
    const matched = models.filter((m) => m.id.toLowerCase().includes(targetModel.toLowerCase()));
    if (matched.length > 0) return matched;
    return [{ id: targetModel, lane: targetModel.includes('muse-spark') ? 'responses' : 'chat' }];
  }

  return models;
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

  // 2. 本身已不再提供免费渠道 / 已废弃 / 已下线
  if (
    status === 410 ||
    lower.includes('modeldeprecated') ||
    lower.includes('has been deprecated') ||
    status === 401 ||
    lower.includes('model is not supported') ||
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

// 测试单个模型
async function probeModel(port, modelInfo, timeoutMs) {
  const isResponses = modelInfo.lane === 'responses';
  const url = isResponses
    ? `http://127.0.0.1:${port}/v1/responses`
    : `http://127.0.0.1:${port}/v1/chat/completions`;

  const body = isResponses
    ? {
        model: modelInfo.id,
        stream: false,
        input: 'Hi',
      }
    : {
        model: modelInfo.id,
        stream: false,
        messages: [{ role: 'user', content: 'Hi' }],
      };

  const startTime = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

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
          '';
      } catch {
        snippet = rawText.slice(0, 80);
      }

      return {
        model: modelInfo.id,
        lane: modelInfo.lane,
        status: 200,
        latencyMs,
        category: 'ACTIVE',
        statusBadge: '✅ 畅通可用',
        diagnosis: '模型连接正常，推理输出完整。',
        suggestion: '可放心在 ZCode 中作为日常模型使用。',
        snippet: snippet.trim().replace(/\s+/g, ' ').slice(0, 80),
      };
    }

    const classified = classifyError(res.status, rawText);
    return {
      model: modelInfo.id,
      lane: modelInfo.lane,
      status: res.status,
      latencyMs,
      rawError: rawText,
      ...classified,
    };
  } catch (err) {
    const latencyMs = Date.now() - startTime;
    return {
      model: modelInfo.id,
      lane: modelInfo.lane,
      status: 0,
      latencyMs,
      category: 'NETWORK_TIMEOUT',
      statusBadge: '⏱️ 请求超时/中断',
      diagnosis: `请求本地代理异常: ${err.message}`,
      suggestion: '请确认本地代理服务正常运行且端口正确。',
    };
  }
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
  const models = await discoverModels(options.port, options.targetModel);

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
    console.log(JSON.stringify({ ok: true, proxy: proxyHealth.data, results }, null, 2));
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
