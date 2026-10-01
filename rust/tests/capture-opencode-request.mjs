#!/usr/bin/env node
/**
 * 抓包：让 OpenCode CLI 把 muse-spark 的真实请求发到本地，把它到底发了什么
 * 记录下来，再回一个假响应让它跑完。
 *
 * 为什么需要：chat 道的门禁是「请求体里必须有 bash / read 两个工具」，
 * 我们靠这个过了门禁。但 responses 道我们只试过「补 bash/read（扁平格式）」
 * 就放弃了，结论是「上游拒绝、没救」。而 CLI 未登录状态下确实能调通
 * muse-spark——说明那个结论下得太早，真实请求里一定还有别的东西。
 *
 * 用 XDG_CONFIG_HOME 指向临时配置，不碰用户真实的 opencode.jsonc。
 *
 * 跑法：node rust/tests/capture-opencode-request.mjs
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI =
  'C:/Users/Administrator/AppData/Local/Programs/@opencodedesktop/resources/opencode-cli.exe';

const sandbox = process.env.O2Z_CAPTURE_KEEP
  ? path.resolve(process.env.O2Z_CAPTURE_KEEP)
  : fs.mkdtempSync(path.join(os.tmpdir(), 'o2z-capture-'));
fs.mkdirSync(sandbox, { recursive: true });
const cfgDir = path.join(sandbox, 'cfg', 'opencode');
fs.mkdirSync(cfgDir, { recursive: true });

const CAPTURE_PORT = 41977;
const captured = [];

// 把 opencode provider 的 baseURL 指到本地
fs.writeFileSync(
  path.join(cfgDir, 'opencode.json'),
  JSON.stringify(
    {
      provider: {
        opencode: {
          options: { baseURL: `http://127.0.0.1:${CAPTURE_PORT}/zen/v1` },
        },
      },
    },
    null,
    2,
  ),
);

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    let body = null;
    try {
      body = JSON.parse(raw);
    } catch {
      /* 原样保留 */
    }
    captured.push({ method: req.method, url: req.url, headers: req.headers, body, raw });
    // 原样落盘，供 replay 实验逐项改
    const dump = path.join(sandbox, `captured-${captured.length}.json`);
    fs.writeFileSync(dump, JSON.stringify({ url: req.url, headers: req.headers, raw }, null, 2));

    // 回一个最小可用的 SSE，让 CLI 以为成功了
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(
      'data: {"type":"response.output_text.delta","delta":"CAPTURED"}\n\n',
    );
    res.write('data: {"type":"response.completed","response":{"id":"r1","usage":{"input_tokens":1,"output_tokens":1}}}\n\n');
    res.end('data: [DONE]\n\n');
  });
});

await new Promise((resolve) => server.listen(CAPTURE_PORT, '127.0.0.1', resolve));
console.log(`捕获服务已起：127.0.0.1:${CAPTURE_PORT}\n`);

const child = spawn(
  CLI,
  [
    'run',
    '--standalone',
    '-m',
    'opencode/muse-spark-1.3-contributor-free',
    'Reply with exactly: OK',
  ],
  {
    env: {
      ...process.env,
      XDG_CONFIG_HOME: path.join(sandbox, 'cfg'),
      XDG_DATA_HOME: path.join(sandbox, 'data'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let cliOut = '';
child.stdout.on('data', (c) => (cliOut += c));
child.stderr.on('data', () => {});

const timer = setTimeout(() => child.kill(), 120_000);
await new Promise((resolve) => child.on('close', resolve));
clearTimeout(timer);
server.close();

console.log(`CLI 输出：${cliOut.trim().slice(0, 200)}\n`);
console.log(`抓到 ${captured.length} 个请求\n`);

const REDACT = /(oc_sk_|sk-)[A-Za-z0-9._-]{8,}/g;
for (const [i, item] of captured.entries()) {
  console.log(`===== 请求 ${i + 1} =====`);
  console.log(`${item.method} ${item.url}`);
  console.log('--- 头 ---');
  for (const [k, v] of Object.entries(item.headers)) {
    const shown = k === 'authorization' ? String(v).replace(REDACT, '$1<REDACTED>') : v;
    console.log(`  ${k}: ${shown}`);
  }
  console.log('--- 体（顶层键与长度）---');
  if (item.body) {
    console.log(`  键: ${Object.keys(item.body).join(', ')}`);
    console.log(`  原始长度: ${item.raw.length}`);
    for (const [k, v] of Object.entries(item.body)) {
      if (k === 'tools' && Array.isArray(v)) {
        console.log(`  tools: ${v.length} 个 → ${v.map((t) => t?.name ?? t?.function?.name ?? '?').join(', ')}`);
      } else if (typeof v === 'string' && v.length > 160) {
        console.log(`  ${k}: <字符串 ${v.length} 字符>`);
      } else {
        console.log(`  ${k}: ${JSON.stringify(v)?.slice(0, 220)}`);
      }
    }
  }
  console.log('');
}

if (captured.length === 0) {
  console.log('没抓到请求。可能 baseURL 覆盖没生效（试试看 CLI 的报错）。');
}

if (process.env.O2Z_CAPTURE_KEEP) {
  console.log(`原始请求已存到：${sandbox}`);
} else {
  fs.rmSync(sandbox, { recursive: true, force: true });
}
