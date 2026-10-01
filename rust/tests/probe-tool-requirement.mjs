#!/usr/bin/env node
/**
 * 收窄：responses 道那道门禁到底要 tools 里的哪几个？
 *
 * 上一轮已确认：去掉 tools 就 403，带上真实 12 个工具就通；instructions、
 * store、include、prompt_cache_key、追踪头都不影响。现在只回答一个问题：
 * 是「任意工具都行」，还是「必须是 OpenCode 那套」？
 *
 * 跑法：node rust/tests/probe-tool-requirement.mjs
 */

import fs from 'node:fs';
import path from 'node:path';

const CAPTURE_DIR =
  process.env.O2Z_CAPTURE_DIR || 'C:/Users/Administrator/AppData/Local/Temp/o2z-cap';
const UPSTREAM = 'https://opencode.ai/zen';

const files = fs.readdirSync(CAPTURE_DIR).filter((f) => f.startsWith('captured-')).sort();
const captured = JSON.parse(
  fs.readFileSync(path.join(CAPTURE_DIR, files[files.length - 1]), 'utf8'),
);
const original = JSON.parse(captured.raw);
const REAL_TOOLS = original.tools;

const HEADERS = {};
for (const [k, v] of Object.entries(captured.headers)) {
  if (['host', 'content-length', 'connection', 'accept-encoding', 'b3', 'traceparent'].includes(k.toLowerCase())) continue;
  HEADERS[k] = v;
}

const stub = (name) => ({
  type: 'function',
  name,
  description: 'Reserved for the host runtime; do not call it.',
  parameters: { type: 'object', properties: {} },
});

async function probe(label, tools) {
  const body = { ...original, tools };
  const response = await fetch(`${UPSTREAM}${captured.url.replace('/zen', '')}`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  // SSE 流里也会出现 error 字段，只看有没有真正的 error 事件
  const failed = /"type"\s*:\s*"error"/.test(text) || !text.includes('response.created');
  const verdict = failed ? `❌ ${response.status}` : '✅ 通';
  console.log(`${verdict.padEnd(10)} ${label}`);
  if (failed) {
    const m = text.match(/"message"\s*:\s*"([^"]+)"/);
    console.log(`           ${m ? m[1] : text.slice(0, 120).replace(/\s+/g, ' ')}`);
  }
  return !failed;
}

console.log(`真实工具集（${REAL_TOOLS.length} 个）：${REAL_TOOLS.map((t) => t.name).join(', ')}\n`);

console.log('=== 基线 ===');
await probe('真实 12 个工具', REAL_TOOLS);

console.log('\n=== 是「任意工具」还是「必须是那套」？===');
await probe('两个占位桩（bash/read，Responses 扁平格式）', [stub('bash'), stub('read')]);
await probe('一个占位桩（bash）', [stub('bash')]);
await probe('一个占位桩（totally-made-up）', [stub('totally-made-up')]);
await probe('真实工具 + 一个占位桩', [...REAL_TOOLS, stub('zzz')]);

console.log('\n=== 和 chat 道一样要求 bash + read 吗？===');
const withoutBash = REAL_TOOLS.filter((t) => t.name !== 'bash');
const withoutRead = REAL_TOOLS.filter((t) => t.name !== 'read');
const withoutBoth = REAL_TOOLS.filter((t) => t.name !== 'bash' && t.name !== 'read');
await probe(`去掉 bash（${withoutBash.length} 个）`, withoutBash);
await probe(`去掉 read（${withoutRead.length} 个）`, withoutRead);
await probe(`去掉 bash 和 read（${withoutBoth.length} 个）`, withoutBoth);

console.log('\n=== 只要两个真身，但用扁平格式重写 ===');
const bashReal = REAL_TOOLS.find((t) => t.name === 'bash');
const readReal = REAL_TOOLS.find((t) => t.name === 'read');
await probe('真实 bash + 真实 read（去掉参数，保持原样）', [bashReal, readReal]);
await probe('真实 bash + 真实 read（清空 description/parameters）', [
  { type: 'function', name: 'bash', description: '', parameters: { type: 'object', properties: {} } },
  { type: 'function', name: 'read', description: '', parameters: { type: 'object', properties: {} } },
]);

console.log('\n=== 工具定义的具体形状有影响吗 ===');
await probe('bash/read 但套一层 function（chat 道那种嵌套格式）', [
  { type: 'function', function: { name: 'bash', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'read', parameters: { type: 'object', properties: {} } } },
]);
