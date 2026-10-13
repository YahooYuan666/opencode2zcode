#!/usr/bin/env node
/**
 * 用本地 mock 上游对 Rust 版做端到端验证：起代理 → 打请求 → 检查
 * 伪装头、门禁工具、档位归一、SSE 逐块透传是否都对。
 *
 * 为什么不用真上游：匿名通道按 IP 限速，测多了必然 429，那是环境问题不是
 * 代码问题，测不出东西。mock 让每一项断言都可重复。
 *
 * 跑法：node tests/live-mock.mjs
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const RUST_EXE = path.join(ROOT, 'rust', 'target', 'release', 'opencode2zcode.exe');

let passed = 0;
let failed = 0;
const check = (name, ok, detail = '') => {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
};

const received = [];
const mock = http.createServer((req, res) => {
  if (req.url === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        data: [
          { id: 'big-pickle' },
          { id: 'space-bunny-free' },
          { id: 'mimo-v2.5-free' },
          { id: 'muse-spark-1.3-contributor-free' },
          { id: 'paid-model-x' },
        ],
      }),
    );
    return;
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    received.push({ headers: req.headers, body });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (req.url?.endsWith('/responses')) {
      // Responses 方言：delta 事件 + completed 事件。故意让 completed 里不带
      // output_text，逼代理用自己拼的文本兜底。
      res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'he' })}\n\n`);
      setTimeout(() => {
        res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'llo' })}\n\n`);
        setTimeout(() => {
          res.write(`data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_mock', object: 'response', status: 'completed', model: body.model, output: [] } })}\n\n`);
          res.end('data: [DONE]\n\n');
        }, 20);
      }, 20);
      return;
    }
    // chat 方言：分三块发，验证拼装/透传都不是攒完一次性吐
    res.write('data: {"choices":[{"delta":{"content":"he');
    setTimeout(() => {
      res.write('llo"}}]}\n\n');
      setTimeout(() => res.end('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"total_tokens":3}}\n\ndata: [DONE]\n\n'), 30);
    }, 30);
  });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForHealth(port, tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) });
      if (res.ok) return res.json();
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  return null;
}

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'o2z-mock-'));
const configPath = path.join(workDir, 'provider_config.json');
fs.writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, config: {} }, null, 2));

await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
const mockBase = `http://127.0.0.1:${mock.address().port}`;
const port = 41955;

console.log('Rust 版 端到端（本地 mock 上游）\n');

const child = spawn(RUST_EXE, ['--config', configPath, '--port', String(port)], {
  env: { ...process.env, ZEN_BASE_URL: mockBase, ZCODE_DATA_BASE_DIR: workDir },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.on('data', (c) => (stderr += c));

try {
  const health = await waitForHealth(port);
  check('代理起来了', health !== null, stderr.slice(0, 400));
  if (!health) process.exit(1);

  console.log('\n[1] 目录判定');
  // 端口先绑、目录后填，所以 healthz 通了不等于配置已落盘，得等它写出来。
  let cfg = null;
  for (let i = 0; i < 80 && !cfg; i += 1) {
    await sleep(250);
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const rules = parsed?.config?.providerConfigRules?.providerRules ?? [];
      const ours = rules.find((r) => r.providerId === 'opencode-free');
      if (ours && ours.config.personalModelIds.length > 0) cfg = parsed;
    } catch {
      /* 还没写出来 */
    }
  }
  check('配置已写入且含模型', cfg !== null);
  if (!cfg) throw new Error('配置始终没写出来，无法继续断言\n' + stderr.slice(0, 800));
  const chat = cfg.config.providerConfigRules.providerRules.find((r) => r.providerId === 'opencode-free');
  const responses = cfg.config.providerConfigRules.providerRules.find(
    (r) => r.providerId === 'opencode-free-responses',
  );
  check('付费模型不进清单', !chat.config.personalModelIds.includes('paid-model-x'));
  check(
    '默认就暴露 responses 道（门禁修好后可用）',
    Boolean(responses) && responses.config.personalModelIds.includes('muse-spark-1.3-contributor-free'),
    `实际：${responses?.providerId}`,
  );
  check('chat 道不含 muse-spark', !chat.config.personalModelIds.includes('muse-spark-1.3-contributor-free'));
  check('下架模型被剔除', !chat.config.personalModelIds.includes('mimo-v2.5-free'),
    `实际：${chat.config.personalModelIds.join(',')}`);

  console.log('\n[2] 伪装头与免费通道门禁');
  received.length = 0;
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'big-pickle',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'none',
    }),
  });
  const text = await res.text();
  // 客户端没要流式 → 应拼回单个 JSON（回归：此前无条件强制流式弄挂了 WebFetch）
  let reassembled = null;
  try { reassembled = JSON.parse(text); } catch {}
  check('没要流式 → 拼回单个 chat.completion',
    reassembled?.object === 'chat.completion', text.slice(0, 200));
  check('内容拼全', reassembled?.choices?.[0]?.message?.content === 'hello',
    JSON.stringify(reassembled?.choices?.[0]?.message));
  check('finish_reason 取自末块', reassembled?.choices?.[0]?.finish_reason === 'stop');
  check('usage 透传', reassembled?.usage?.total_tokens === 3);
  check('mock 收到了请求', received.length === 1);
  const h = received[0].headers;
  check('user-agent 自称 opencode CLI', /^opencode\//.test(String(h['user-agent'])), String(h['user-agent']));
  check('x-opencode-client: cli', h['x-opencode-client'] === 'cli');
  check('session id 形状规范', /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(String(h['x-opencode-session'])),
    String(h['x-opencode-session']));
  check('session id 真实倒序时钟末3位为 ffe', String(h['x-opencode-session']).slice(13, 16) === 'ffe',
    String(h['x-opencode-session']));
  check('request id 官方 msg_ 格式', /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(String(h['x-opencode-request'])),
    String(h['x-opencode-request']));
  check('匿名通道用 public', h['authorization'] === 'Bearer public');
  check('强制 stream: true', received[0].body.stream === true);

  console.log('\n[3] 思考档位归一');
  check('reasoning_effort=none 被摘掉', received[0].body.reasoning_effort === undefined,
    `实际：${JSON.stringify(received[0].body.reasoning_effort)}`);
  const toolNames = (received[0].body.tools ?? []).map((t) => t?.function?.name);
  check('补齐门禁工具 bash', toolNames.includes('bash'));
  check('补齐门禁工具 read', toolNames.includes('read'));
  check('无工具时 tool_choice=none', received[0].body.tool_choice === 'none');

  received.length = 0;
  await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'space-bunny-free',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'high',
    }),
  });
  check('上游认的档位原样透传', received[0].body.reasoning_effort === 'high');

  console.log('\n[4] 回环限制');
  const status = await new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/healthz', headers: { Host: 'evil.example.com' } },
      (r) => {
        r.resume();
        resolve(r.statusCode);
      },
    );
    req.on('error', reject);
    req.end();
  });
  check('非回环 Host 被拒（403）', status === 403, `实际 ${status}`);

  console.log('\n[5b] 客户端显式要流式 → 逐块透传（SSE 原样）');
  received.length = 0;
  const streamed = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'big-pickle', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
  });
  const streamText = await streamed.text();
  check('流式仍是 SSE 碎片（不被拼装破坏）',
    streamText.includes('data:') && streamText.includes('[DONE]'), streamText.slice(0, 120));
  check('流式内容分块透传', streamText.includes('"content":"he') && streamText.includes('llo'));

  console.log('\n[5c] responses 道非流式 → 拼回完整 response 对象');
  received.length = 0;
  const respNs = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'muse-spark-1.3-contributor-free', stream: false, input: 'hi' }),
  });
  const respNsText = await respNs.text();
  let respNsJson = null;
  try { respNsJson = JSON.parse(respNsText); } catch {}
  check('responses 非流式也是单个 JSON', respNsJson !== null, respNsText.slice(0, 160));
  check('status=completed', respNsJson?.status === 'completed');
  check('completed 缺 output_text 时用拼装文本兜底',
    JSON.stringify(respNsJson?.output ?? '').includes('hello'), JSON.stringify(respNsJson).slice(0, 200));

  console.log('\n[5] 错误透传');
  received.length = 0;
  const after = await waitForHealth(port, 5);
  check('healthz 累计了请求数', after && after.requests === 4, JSON.stringify(after));
} finally {
  child.kill();
  mock.close();
  await sleep(300);
  fs.rmSync(workDir, { recursive: true, force: true });
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
