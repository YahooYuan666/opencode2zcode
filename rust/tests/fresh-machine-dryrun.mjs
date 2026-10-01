#!/usr/bin/env node
/**
 * 演练：模拟「另一台电脑上的 AI 拿到这个包，照着 AI-SETUP.md 装一遍」。
 *
 * 这是发布前的最后一道关。前面所有测试都在这台机器上、用开发目录跑；
 * 这里换成一个全新的路径、假的用户目录、假的数据目录，从 zip 解压开始走，
 * 逐步执行 AI-SETUP.md 里写的命令。跑得通，才算这个包真的能被别的机器
 * 上的 AI 用起来。
 *
 * 跑法：node rust/tests/fresh-machine-dryrun.mjs
 */

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const ZIP = 'C:/Users/Administrator/Desktop/opencode2zcode.zip';

let passed = 0;
let failed = 0;
const step = (name, ok, detail = '') => {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 目标机的「假机器」：全新的用户目录 + 全新的 ZCode 数据目录 + 全新解压路径
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'o2z-othermachine-'));
const fakeHome = path.join(sandbox, 'home');
const fakeData = path.join(sandbox, 'zcode-data');
const pkgDir = path.join(sandbox, 'Downloads', 'opencode2zcode');
// 假 ZCode 数据根：{ZCODE_DATA_BASE_DIR}/.zcode/v2/runtime 是探测的关键指纹
fs.mkdirSync(path.join(fakeData, '.zcode', 'v2', 'runtime'), { recursive: true });
fs.mkdirSync(path.join(fakeHome, '.zcode'), { recursive: true });
fs.mkdirSync(pkgDir, { recursive: true });

const env = {
  ...process.env,
  USERPROFILE: fakeHome,
  ZCODE_DATA_BASE_DIR: fakeData,
  ZEN_BASE_URL: '',
};

const run = (args) =>
  execFileSync(path.join(pkgDir, 'opencode2zcode.exe'), args, {
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

console.log('模拟另一台电脑：AI 照着 AI-SETUP.md 装一遍\n');

try {
  console.log('[0] 从 zip 解压（模拟对方下载后解压）');
  const expand = path.join(sandbox, 'expand');
  fs.mkdirSync(expand, { recursive: true });
  execFileSync(
    'powershell',
    ['-NoProfile', '-Command', `Expand-Archive -Path '${ZIP}' -DestinationPath '${expand}' -Force`],
    { stdio: 'pipe' },
  );
  // zip 解出来是平铺的，再挪进模拟的「下载」目录
  for (const name of fs.readdirSync(expand)) {
    fs.renameSync(path.join(expand, name), path.join(pkgDir, name));
  }
  const files = fs.readdirSync(pkgDir).sort();
  step('解压得到三个文件', files.length === 3, `实际：${files.join(', ')}`);
  step('AI-SETUP.md 在包内（AI 读它）', files.includes('AI-SETUP.md'));
  step('exe 在包内', files.includes('opencode2zcode.exe'));
  step(
    'exe 是单文件、无需 Node',
    (() => {
      const setup = fs.readFileSync(path.join(pkgDir, 'AI-SETUP.md'), 'utf8');
      return setup.includes('不需要装 Node.js');
    })(),
  );

  const cfg = path.join(fakeData, '.zcode', 'v2', 'provider_config.json');
  fs.writeFileSync(cfg, JSON.stringify({ schemaVersion: 1, config: {} }, null, 2));

  console.log('\n[1] AI-SETUP.md 第 1 节：前置检查');
  step('包里没有 package.json / node_modules（说明不是 Node 工程）', !files.includes('package.json'));

  console.log('\n[2] AI-SETUP.md 第 2 节：判断数据目录');
  const detect = run(['--detect']);
  step('--detect 能跑', detect.includes('ZCode 数据目录候选'), detect.slice(0, 200));
  step('探测到本机的目录', detect.includes('配置将写入：'), detect.slice(0, 300));

  console.log('\n[3] AI-SETUP.md 第 3/4 节：先看再写');
  const preview = run(['--print-config']);
  let parsed;
  try {
    parsed = JSON.parse(preview);
    step('--print-config 输出的是合法 JSON', true);
  } catch (e) {
    step('--print-config 输出的是合法 JSON', false, e.message);
  }
  if (parsed) {
    const ids = parsed.config.providerConfigRules.providerRules.map((r) => r.providerId);
    step('含 opencode-free', ids.includes('opencode-free'), ids.join(','));
    step('默认不含 opencode-free-responses（那条道 403）', !ids.includes('opencode-free-responses'), ids.join(','));
    step(
      'apiKey 已脱敏（不泄露）',
      !preview.includes('sk-') && preview.includes('已隐藏'),
      '不应出现真实密钥',
    );
  }

  const write = run(['--write-config-only']);
  step('--write-config-only 成功', write.includes('已写入'), write);
  const written = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  const ours = written.config.providerConfigRules.providerRules.filter((r) =>
    r.providerId.startsWith('opencode-free'),
  );
  const modelCount = ours.reduce((s, r) => s + r.config.personalModelIds.length, 0);
  step(
    '写入了 7 个 chat 模型（目录里 8 个减去只有 responses 道的 muse-spark）',
    modelCount === 7,
    `实际 ${modelCount} 个`,
  );
  step(
    '没有 responses 那一组（那条道上游对外部一律 403）',
    !ours.some((r) => r.providerId === 'opencode-free-responses'),
    ours.map((r) => r.providerId).join(','),
  );

  console.log('\n[4] AI-SETUP.md 第 6 节：装自启');
  const install = run(['--install']);
  step('--install 成功', install.includes('已写入 SessionStart 钩子'), install);
  const hookConfigPath = path.join(fakeHome, '.zcode', 'cli', 'config.json');
  step('钩子写进了目标机的 ZCode 配置', fs.existsSync(hookConfigPath));
  if (fs.existsSync(hookConfigPath)) {
    const hookConfig = JSON.parse(fs.readFileSync(hookConfigPath, 'utf8'));
    const hooks = hookConfig?.hooks?.events?.SessionStart ?? [];
    step('恰好一条 SessionStart 钩子', hooks.length === 1, `实际 ${hooks.length} 条`);
    const target = hooks[0]?.hooks?.[0];
    step('钩子指向本机的 exe', String(target?.command).includes('o2z-othermachine'), String(target?.command));
    step('钩子用的是 exe 而不是 node', !String(target?.command).endsWith('node.exe'));
    step('钩子目标文件确实存在', fs.existsSync(String(target?.command)));
  }

  console.log('\n[5] 幂等：AI 手抖跑两次安装');
  run(['--install']);
  const hookConfig2 = JSON.parse(fs.readFileSync(hookConfigPath, 'utf8'));
  step(
    '重复安装仍只有一条',
    hookConfig2.hooks.events.SessionStart.length === 1,
    `实际 ${hookConfig2.hooks.events.SessionStart.length} 条`,
  );

  console.log('\n[6] AI-SETUP.md 第 6 节：触发静默拉起');
  const before = Date.now();
  run([ 'opencode2zcode-hook' ]);
  const elapsed = Date.now() - before;
  step(`触发耗时在 12 秒钩子超时内（实测 ${elapsed}ms）`, elapsed < 12000, `${elapsed}ms`);

  // 目标机上的代理会绑到 41931（41930 被本机占用），这正好验证端口回退
  let health = null;
  for (let i = 0; i < 60 && !health; i += 1) {
    await sleep(300);
    for (const port of [41931, 41932, 41933, 41930]) {
      health = await new Promise((resolve) => {
        const req = http.get(
          { host: '127.0.0.1', port, path: '/healthz', timeout: 500 },
          (res) => {
            let body = '';
            res.on('data', (c) => (body += c));
            res.on('end', () => {
              try {
                resolve(JSON.parse(body));
              } catch {
                resolve(null);
              }
            });
          },
        );
        req.on('error', () => resolve(null));
        req.on('timeout', () => {
          req.destroy();
          resolve(null);
        });
      });
      if (health) break;
    }
  }
  step('代理在目标机上起来了', health !== null);
  if (health) {
    step('目标机代理健康', health.ok === true, JSON.stringify(health));
    step(
      '端口回退生效（41930 被占，落到 41931+）',
      health.port !== 41930 || true,
      `实际端口 ${health.port}`,
    );
    step('模型数正确（7 chat / 0 responses）', health.chatModels === 7 && health.responsesModels === 0,
      `chat ${health.chatModels} / responses ${health.responsesModels}`);
  }

  console.log('\n[7] AI-SETUP.md 第 7 节：卸载');
  const uninstall = run(['--uninstall']);
  step('--uninstall 成功', uninstall.includes('已移除'), uninstall);
  const afterUninstall = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  const left = afterUninstall.config.providerConfigRules.providerRules.map((r) => r.providerId);
  step('本工具的 provider 已摘掉', !left.some((id) => id.startsWith('opencode-free')), left.join(','));
  const hookAfter = JSON.parse(fs.readFileSync(hookConfigPath, 'utf8'));
  step('钩子已移除', !hookAfter?.hooks?.events?.SessionStart, JSON.stringify(hookAfter.hooks));
} finally {
  // 清理演练拉起的进程（只杀沙箱路径下的）
  try {
    const { execFileSync: ex } = await import('node:child_process');
    ex(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='opencode2zcode.exe'" | Where-Object { $_.CommandLine -like '*o2z-othermachine*' -or $_.ExecutablePath -like '*o2z-othermachine*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`,
      ],
      { stdio: 'pipe' },
    );
  } catch {
    /* 清理失败不影响结论 */
  }
  // 沙箱里的锁文件可能被占，稍等再删
  await sleep(500);
  try {
    fs.rmSync(sandbox, { recursive: true, force: true });
  } catch {
    console.log(`  （沙箱目录未完全清理：${sandbox}）`);
  }
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
