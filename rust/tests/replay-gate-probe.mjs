#!/usr/bin/env node
/**
 * 回放实验：拿抓到的真实请求，对着真实上游逐项「减字段」，找出 responses 道
 * 那道免费档门禁到底认什么。
 *
 * 背景：先前只试过「补 bash/read 两个占位工具」就下了「上游拒绝、没救」的
 * 结论。但用 OpenCode CLI 抓包后发现真实请求和我们的差得很远——完整的
 * 32KB 工具集、2119 字符的 instructions、store/include/prompt_cache_key
 * 字段，还有一批分布式追踪头。这里一项项拆开试。
 *
 * 跑法：node rust/tests/replay-gate-probe.mjs
 */

import fs from 'node:fs';
import path from 'node:path';

const CAPTURE_DIR = process.env.O2Z_CAPTURE_DIR || '/tmp/o2z-cap';
const UPSTREAM = 'https://opencode.ai/zen';
const files = fs
  .readdirSync(CAPTURE_DIR)
  .filter((f) => f.startsWith('captured-'))
  .sort();

if (files.length === 0) {
  console.error(`没抓到请求。先跑 capture-opencode-request.mjs（带 O2Z_CAPTURE_KEEP）。`);
  process.exit(1);
}

// 用带工具的那个（第二个），它最接近真实调用
const picked = files[files.length - 1];
const captured = JSON.parse(fs.readFileSync(path.join(CAPTURE_DIR, picked), 'utf8'));
const original = JSON.parse(captured.raw);

console.log(`基准请求：${picked}（${captured.raw.length} 字符）`);
console.log(`工具数：${original.tools?.length ?? 0}`);
console.log(`instructions 长度：${String(original.instructions ?? '').length}\n`);

const DROP_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'accept-encoding',
  'b3',
  'traceparent',
]);

function buildHeaders(extra = {}) {
  const headers = {};
  for (const [k, v] of Object.entries(captured.headers)) {
    if (!DROP_HEADERS.has(k.toLowerCase())) headers[k] = v;
  }
  // 追踪头可伪造，但先从基线里去掉，见下面的分组实验
  return { ...headers, ...extra };
}

async function probe(label, { headers, body }) {
  const text = body === undefined ? captured.raw : JSON.stringify(body);
  const response = await fetch(`${UPSTREAM}${captured.url.replace('/zen', '')}`, {
    method: 'POST',
    headers: buildHeaders(headers),
    body: text,
  });
  const result = await response.text();
  const ok = response.ok && result.includes('CAPTURED') === false;
  const first = result.slice(0, 160).replace(/\s+/g, ' ');
  const verdict = response.status === 200 && !result.includes('"error"') ? '✅ 通' : `❌ ${response.status}`;
  console.log(`${verdict.padEnd(10)} ${label}`);
  if (verdict !== '✅ 通') console.log(`           ${first}`);
  return response.status === 200 && !result.includes('"error"');
}

console.log('=== A. 原样回放（不改任何东西）===');
await probe('原样回放', {});

console.log('\n=== B. 去掉哪些字段会挂？===');
await probe('去掉 instructions', { body: { ...original, instructions: undefined } });
await probe('去掉 tools', { body: { ...original, tools: undefined } });
await probe('去掉 store / include / prompt_cache_key', {
  body: (() => {
    const b = { ...original };
    delete b.store;
    delete b.include;
    delete b.prompt_cache_key;
    return b;
  })(),
});

console.log('\n=== C. 头的影响 ===');
await probe('换成我们原来的 user-agent', { headers: { 'user-agent': 'opencode/1.18.31 (win32 x64; node20)' } });
await probe('去掉 x-opencode-session-id', { headers: { 'x-opencode-session-id': '' } });
await probe('只留 authorization + content-type（最简）', {
  headers: { 'user-agent': undefined, 'x-opencode-client': undefined, 'x-opencode-project': undefined,
    'x-opencode-session': undefined, 'x-opencode-session-id': undefined,
    'x-session-affinity': undefined, 'x-session-id': undefined },
});

console.log('\n=== D. 最小可用组合（找出到底需要什么）===');
await probe('只有 model/input/stream/instructions', {
  headers: { 'user-agent': undefined, 'x-opencode-client': undefined, 'x-opencode-project': undefined,
    'x-opencode-session': undefined, 'x-opencode-session-id': undefined,
    'x-session-affinity': undefined, 'x-session-id': undefined },
  body: {
    model: original.model,
    input: original.input,
    instructions: original.instructions,
    stream: true,
  },
});
await probe('只有 model/input/stream/tools（无 instructions）', {
  headers: { 'user-agent': undefined, 'x-opencode-client': undefined, 'x-opencode-project': undefined,
    'x-opencode-session': undefined, 'x-opencode-session-id': undefined,
    'x-session-affinity': undefined, 'x-session-id': undefined },
  body: { model: original.model, input: original.input, tools: original.tools, stream: true },
});
await probe('只有 model/input/stream（两者都不要）', {
  headers: { 'user-agent': undefined, 'x-opencode-client': undefined, 'x-opencode-project': undefined,
    'x-opencode-session': undefined, 'x-opencode-session-id': undefined,
    'x-session-affinity': undefined, 'x-session-id': undefined },
  body: { model: original.model, input: original.input, stream: true },
});
