#!/usr/bin/env node
/**
 * 自测：用本地 mock 上游把关键逻辑跑一遍，不碰真实网络。
 *
 * 为什么需要它：这个工具有两处「有意偏离上游」的逻辑——免费模型判定规则和
 * reasoning_effort 档位表——它们是对着真实上游逐项试出来的，一旦被后续改动
 * 或上游变化悄悄改坏，从界面上完全看不出来（表现只是「少了几个模型」或
 * 「对话开始 400」）。而代码里早就留好了 ZEN_BASE_URL 这个接缝，指向本地
 * mock 就能把这两处钉死。
 *
 * 跑法：node selftest.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROXY = path.join(SCRIPT_DIR, 'zen-proxy.mjs');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    failures.push({ name, error });
    console.log(`  ✗ ${name}`);
    console.log(`      ${error.message.split('\n')[0]}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    failures.push({ name, error });
    console.log(`  ✗ ${name}`);
    console.log(`      ${error.message.split('\n')[0]}`);
  }
}

// ---------------------------------------------------------------------------
// mock 上游：把 zen-proxy.mjs 需要的两个外部依赖都替换掉
//   ZEN_BASE_URL     → 本地 http 服务
//   METADATA_URL     → 固定写死，无法用环境变量替换，所以这里改用
//                       --config 隔离 + 接受它去打真实地址（只打一次 models.dev）
// ---------------------------------------------------------------------------

/** 假的 Zen：/v1/models 返回清单，/v1/chat/completions 记录收到的 body。 */
async function startMockZen() {
  const received = [];
  const server = http.createServer((req, res) => {
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
      res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, received, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'o2z-selftest-'));
}

function readConfig(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** 跑一次 zen-proxy.mjs，返回 { code, stdout, stderr }。 */
function runProxy(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [PROXY, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function modelIdsOf(configFile, providerId) {
  const config = readConfig(configFile);
  const rule = config.config.providerConfigRules.providerRules.find((r) => r.providerId === providerId);
  return rule ? rule.config.personalModelIds : [];
}

async function main() {
  console.log('opencode2zcode 自测（本地 mock，不打真实上游）\n');

  const mock = await startMockZen();
  const workDir = tempDir();
  const configPath = path.join(workDir, 'provider_config.json');
  fs.mkdirSync(path.join(workDir, '.zcode', 'v2', 'runtime'), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, config: {} }, null, 2));

  const baseEnv = { ZEN_BASE_URL: mock.baseUrl, ZCODE_DATA_BASE_DIR: workDir };

  try {
    console.log('[1] 免费判定与下架剔除');
    const write = await runProxy(['--write-config-only', '--config', configPath], baseEnv);
    assert.equal(write.code, 0, `退出码应为 0，实际 ${write.code}\n${write.stderr}`);

    const chat = modelIdsOf(configPath, 'opencode-free');
    const responses = modelIdsOf(configPath, 'opencode-free-responses');

    test('付费模型不进清单', () => {
      assert.ok(!chat.includes('paid-model-x'), 'paid-model-x 不该出现');
    });
    test('非废弃的免费模型进清单', () => {
      assert.ok(chat.includes('big-pickle'), 'big-pickle 应在 chat 清单里');
      assert.ok(chat.includes('space-bunny-free'), 'space-bunny-free 应在 chat 清单里');
    });
    test('muse-spark 走 responses 道，不混进 chat', () => {
      assert.ok(!chat.includes('muse-spark-1.3-contributor-free'), 'muse-spark 不该在 chat 道');
      assert.ok(responses.includes('muse-spark-1.3-contributor-free'), 'muse-spark 应在 responses 道');
    });
    test('目录判定废弃的模型被剔除（回归：mimo-v2.5-free 曾被误放进来）', () => {
      assert.ok(
        !chat.includes('mimo-v2.5-free') && !responses.includes('mimo-v2.5-free'),
        'mimo-v2.5-free 已下架，不该出现在任何一道',
      );
    });
    test('S3 静态兜底不会复活废弃模型', () => {
      // 静态清单里若残留废弃 id，decision() 也必须否决它。
      const config = readConfig(configPath);
      const rules = config.config.modelConfigRules.providerModelRules;
      const ids = rules.map((r) => r.modelId);
      assert.ok(!ids.includes('mimo-v2.5-free'), '模型规则里不该有 mimo-v2.5-free');
    });

    console.log('\n[2] 重复写入的幂等性与「不碰别人的 Provider」');
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          schemaVersion: 1,
          config: {
            providerOrder: ['someone-elses'],
            providerConfigRules: {
              providerRules: [
                { providerId: 'someone-elses', providerName: '别人的', enabled: true, config: {} },
              ],
            },
            modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
          },
        },
        null,
        2,
      ),
    );
    await runProxy(['--write-config-only', '--config', configPath], baseEnv);
    const merged = readConfig(configPath);
    test('别人的 Provider 完好保留', () => {
      const ids = merged.config.providerConfigRules.providerRules.map((r) => r.providerId);
      assert.ok(ids.includes('someone-elses'), '别人的 providerId 应保留');
    });
    test('providerOrder 里别人的条目保留', () => {
      assert.ok(merged.config.providerOrder.includes('someone-elses'), 'providerOrder 应保留别人的条目');
    });

    console.log('\n[3] --remove-provider 对称摘除');
    const removed = await runProxy(['--remove-provider', '--config', configPath], baseEnv);
    assert.equal(removed.code, 0, '卸载应正常退出');
    const afterRemove = readConfig(configPath);
    test('本工具的两个 Provider 都被摘掉', () => {
      const ids = afterRemove.config.providerConfigRules.providerRules.map((r) => r.providerId);
      assert.ok(!ids.includes('opencode-free'), 'opencode-free 应被摘掉');
      assert.ok(!ids.includes('opencode-free-responses'), 'opencode-free-responses 应被摘掉');
    });
    test('别人的 Provider 在卸载后依然在', () => {
      const ids = afterRemove.config.providerConfigRules.providerRules.map((r) => r.providerId);
      assert.ok(ids.includes('someone-elses'), '卸载不该动别人的 Provider');
    });
    test('模型规则里的 ours 也被摘掉', () => {
      const ids = (afterRemove.config.modelConfigRules.providerModelRules ?? []).map((r) => r.providerId);
      assert.ok(!ids.some((id) => id.startsWith('opencode-free')), '模型规则里不该残留');
    });

    console.log('\n[4] 免费通道体门禁与伪装头（打 mock 上游）');
    const { server, received } = mock;
    const serveConfig = path.join(workDir, 'serve.json');
    fs.writeFileSync(serveConfig, JSON.stringify({ schemaVersion: 1, config: {} }, null, 2));
    const port = 41987;
    const child = spawn(process.execPath, [PROXY, '--config', serveConfig, '--port', String(port)], {
      env: { ...process.env, ...baseEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // 等代理起来
    let up = false;
    for (let i = 0; i < 40 && !up; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) });
        up = res.ok;
      } catch {
        /* 还没起来 */
      }
    }
    if (!up) throw new Error('代理未能在预期时间内启动');

    try {
      await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'big-pickle',
          messages: [{ role: 'user', content: 'hi' }],
          reasoning_effort: 'none',
        }),
      });

      test('请求带上了伪装头', () => {
        assert.ok(received.length > 0, 'mock 应收到请求');
        const h = received[0].headers;
        assert.match(String(h['user-agent']), /^opencode\//, 'user-agent 应自称 opencode CLI');
        assert.equal(h['x-opencode-client'], 'cli', '应有 x-opencode-client: cli');
        assert.match(String(h['x-opencode-session']), /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/, 'session id 形状应规范');
        assert.equal(h['authorization'], 'Bearer public', '匿名通道用 public 占位');
      });

      test('强制 stream: true', () => {
        assert.equal(received[0].body.stream, true, '应强制流式');
      });

      test('reasoning_effort=none 被摘掉（回归：原样透传会被打成 400）', () => {
        assert.equal(
          received[0].body.reasoning_effort,
          undefined,
          'none 不在主动档位里，应当省略该字段',
        );
      });

      test('补齐门禁工具 bash / read', () => {
        const names = (received[0].body.tools ?? []).map((t) => t?.function?.name);
        assert.ok(names.includes('bash'), '缺 bash 会被免费通道 403');
        assert.ok(names.includes('read'), '缺 read 会被免费通道 403');
      });

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
      test('上游认的主动档位原样透传', () => {
        assert.equal(received[0].body.reasoning_effort, 'high', 'high 应当原样透传');
      });

      // Host 是 fetch 的 forbidden header，改用裸 http.request 才能伪造。
      const deniedStatus = await new Promise((resolve, reject) => {
        const req = http.request(
          { host: '127.0.0.1', port, path: '/healthz', method: 'GET', headers: { Host: 'evil.example.com' } },
          (res) => {
            res.resume();
            resolve(res.statusCode);
          },
        );
        req.on('error', reject);
        req.end();
      });
      await testAsync('非回环 Host 被拒（403）', async () => {
        assert.equal(deniedStatus, 403, '非回环 Host 应 403');
      });
    } finally {
      child.kill();
    }

    await new Promise((r) => setTimeout(r, 400));
  } finally {
    mock.server.close();
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  if (failed > 0) {
    console.log('\n失败详情：');
    for (const f of failures) console.log(`\n[${f.name}]\n${f.error.stack}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`\n自测本身崩了：${error.stack}`);
  process.exit(1);
});
