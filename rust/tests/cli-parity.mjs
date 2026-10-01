#!/usr/bin/env node
/**
 * 对拍：同一个时刻分别跑 Node 版和 Rust 版，比对它们产出的结果。
 *
 * 重写最容易出的错是「一边改了另一边没改」——尤其像 models.dev 返回形状
 * 这种只有联网才暴露的问题。所以把两个实现放在同一组断言下跑，任何一边
 * 跑偏都会被抓到。
 *
 * 跑法：node tests/compare-versions.mjs
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const NODE_ENTRY = path.join(ROOT, 'zen-proxy.mjs');
const RUST_EXE = path.join(ROOT, 'rust', 'target', 'release', 'opencode2zcode.exe');

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}`);
    if (detail) console.log(`      ${detail}`);
  }
}

function run(command, args, env = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function writeConfigTo(file, command, args) {
  if (fs.existsSync(file)) fs.rmSync(file);
  run(command, [...args, '--write-config-only', '--config', file]);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function modelsOf(config) {
  return config.config.providerConfigRules.providerRules
    .filter((r) => r.providerId.startsWith('opencode-free'))
    .flatMap((r) => r.config.personalModelIds)
    .sort();
}

function stripVolatile(value) {
  // 端口会因占用回退而不同，比较前抹掉。
  const clone = JSON.parse(JSON.stringify(value));
  const rules = clone.config?.providerConfigRules?.providerRules ?? [];
  for (const rule of rules) {
    if (rule.config?.api?.baseUrl) rule.config.api.baseUrl = rule.config.api.baseUrl.replace(/:\d+\/v1$/, ':PORT/v1');
  }
  return clone;
}

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'o2z-compare-'));
const nodeConfig = path.join(workDir, 'node.json');
const rustConfig = path.join(workDir, 'rust.json');

console.log('Node 版 vs Rust 版 对拍\n');

if (!fs.existsSync(RUST_EXE)) {
  console.log(`找不到 Rust 产物：${RUST_EXE}`);
  console.log('先跑：cd rust && cargo build --release');
  process.exit(1);
}

const nodeOut = writeConfigTo(nodeConfig, process.execPath, [NODE_ENTRY]);
const rustOut = writeConfigTo(rustConfig, RUST_EXE, []);

console.log('[1] 模型清单必须逐个相同');
const nodeModels = modelsOf(nodeOut);
const rustModels = modelsOf(rustOut);
check('两边模型数相同', nodeModels.length === rustModels.length, `Node ${nodeModels.length} vs Rust ${rustModels.length}`);
check('两边模型集合完全一致', JSON.stringify(nodeModels) === JSON.stringify(rustModels),
  `Node: ${nodeModels.join(',')}\n      Rust: ${rustModels.join(',')}`);
check('默认只暴露 chat 道的 7 个', rustModels.length === 7, `实际 ${rustModels.length} 个：${rustModels.join(',')}`);
check(
  '默认不含 responses 道的 muse-spark（那条道 100% 403）',
  !rustModels.some((m) => m.startsWith('muse-spark')),
  `出现了：${rustModels.join(',')}`,
);
check('下架模型不得出现', !rustModels.some((m) => m === 'mimo-v2.5-free' || m === 'deepseek-v4-flash-free'),
  `出现了下架模型：${rustModels.join(',')}`);

console.log('\n[2] 生成的配置结构必须一致（端口除外）');
const nodeNormalized = stripVolatile(nodeOut);
const rustNormalized = stripVolatile(rustOut);
check('整份配置逐字节相同', JSON.stringify(nodeNormalized) === JSON.stringify(rustNormalized),
  '两边产出的 provider_config.json 不一致');

console.log('\n[3] 模型元数据（上下文/档位/最大输出）');
const rulesOf = (c) =>
  Object.fromEntries(
    (c.config.modelConfigRules.providerModelRules ?? []).map((r) => [r.modelId, JSON.stringify(r.config)]),
  );
const nodeRules = rulesOf(nodeOut);
const rustRules = rulesOf(rustOut);
const mismatched = Object.keys(nodeRules).filter((id) => nodeRules[id] !== rustRules[id]);
check('每个模型的元数据都一致', mismatched.length === 0, `不一致的模型：${mismatched.join(', ')}`);
check('思考档位阶梯非空', Object.keys(rustRules).length > 0);

console.log('\n[4] 参数与帮助');
const nodeHelp = run(process.execPath, [NODE_ENTRY, '--help']);
const rustHelp = run(RUST_EXE, ['--help']);
for (const flag of ['--install', '--uninstall', '--ensure', '--detect', '--print-config', '--remove-provider', '--with-responses']) {
  check(`两版都支持 ${flag}`, nodeHelp.includes(flag) && rustHelp.includes(flag));
}

console.log('\n[5] 目录探测结论必须一致');
const nodeDetect = run(process.execPath, [NODE_ENTRY, '--detect'], { ZCODE_DATA_BASE_DIR: '' });
const rustDetect = run(RUST_EXE, ['--detect'], { ZCODE_DATA_BASE_DIR: '' });
const grab = (text) => (text.match(/配置将写入：(.+)/) ?? [])[1]?.trim();
check('两版探测到同一个配置落点', grab(nodeDetect) === grab(rustDetect),
  `Node: ${grab(nodeDetect)}\n      Rust: ${grab(rustDetect)}`);

console.log('\n[6] 卸载对称性');
const before = JSON.parse(fs.readFileSync(rustConfig, 'utf8'));
run(RUST_EXE, ['--remove-provider', '--config', rustConfig]);
const after = JSON.parse(fs.readFileSync(rustConfig, 'utf8'));
const remaining = after.config.providerConfigRules.providerRules.map((r) => r.providerId);
check('卸载后不含本工具的 provider', !remaining.some((id) => id.startsWith('opencode-free')),
  `还剩：${remaining.join(',')}`);
check('卸载前确实有本工具的 provider',
  before.config.providerConfigRules.providerRules.some((r) => r.providerId.startsWith('opencode-free')));

fs.rmSync(workDir, { recursive: true, force: true });
console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
