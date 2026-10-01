#!/usr/bin/env node
/**
 * 打成单文件 exe，让别人**不用装 Node.js**。
 *
 * 做法：esbuild 把 ESM 源码打成一个 CommonJS 文件（SEA 的入口只吃 CJS），
 * 再用 Node 官方的 Single Executable Application 机制，把 node 运行时和这个
 * 文件缝进一份 node.exe 拷贝里。产物是**一个自包含的 opencode2zcode.exe**，
 * 拷到别的电脑上双击就能跑，零依赖、零安装。
 *
 * 源码仍然是 zen-proxy.mjs，**只有一份**，不存在「exe 版和脚本版行为不一致」
 * 的问题——每次构建都从同一份源码出。
 *
 * 用法：node build/build-exe.mjs
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = path.join(ROOT, 'build');
const OUT_EXE = path.join(ROOT, 'dist', 'opencode2zcode.exe');

/** 直接跑 node_modules 里的实际入口，不经过 npx——Windows 上没有 npx shim。 */
const ESBUILD_JS = path.join(ROOT, 'node_modules', 'esbuild', 'bin', 'esbuild');
const POSTJECT_JS = path.join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js');

const STEPS = [
  { name: '1/4 esbuild 打成单文件 CJS', run: bundle },
  { name: '2/4 生成 SEA blob', run: makeBlob },
  { name: '3/4 复制 node.exe 作为外壳', run: copyShell },
  { name: '4/4 注入 blob', run: inject },
];

function sh(command, args) {
  execFileSync(command, args, { stdio: 'inherit', cwd: ROOT });
}

function bundle() {
  fs.mkdirSync(BUILD, { recursive: true });
  sh(process.execPath, [
    ESBUILD_JS,
    path.join(ROOT, 'zen-proxy.mjs'),
    '--bundle',
    '--platform=node',
    '--target=node20',
    '--format=cjs',
    '--outfile=' + path.join(BUILD, 'bundle.cjs'),
  ]);
}

function makeBlob() {
  const config = {
    main: path.join(BUILD, 'bundle.cjs'),
    output: path.join(BUILD, 'sea-prep.blob'),
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    useCodeCache: true,
  };
  const configPath = path.join(BUILD, 'sea-config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  sh(process.execPath, ['--experimental-sea-config', configPath]);
}

function copyShell() {
  fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
  fs.copyFileSync(process.execPath, OUT_EXE);
}

function inject() {
  // postject 把 blob 塞进 exe 的资源段。需要一个签名占位，SEA 用的是
  // NODE_SEA_BLOB 这个 fuse 字符串。
  sh(process.execPath, [
    POSTJECT_JS,
    OUT_EXE,
    'NODE_SEA_BLOB',
    path.join(BUILD, 'sea-prep.blob'),
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ]);
}

console.log('构建单文件 exe（用户无需安装 Node.js）\n');
for (const step of STEPS) {
  process.stdout.write(`${step.name} ... `);
  try {
    step.run();
    console.log('好');
  } catch (error) {
    console.log('失败');
    console.error(error.stderr?.toString() || error.message);
    process.exit(1);
  }
}

const sizeMb = (fs.statSync(OUT_EXE).size / 1024 / 1024).toFixed(1);
console.log(`\n产物：${OUT_EXE}  (${sizeMb} MB)`);
console.log('里面含 node 运行时，所以体积大，但对方只要拷这一个文件就能用。');
