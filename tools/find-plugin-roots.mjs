#!/usr/bin/env node
/** 一次性调查：ZCode 主进程从哪些目录发现本地插件。 */
import fs from 'node:fs';

const buf = fs.readFileSync('D:/Program Files/ZCode/resources/app.asar');
const headerSize = buf.readUInt32LE(12);
const header = JSON.parse(buf.subarray(16, 16 + headerSize).toString('utf8'));
const base = 16 + headerSize;

const files = [];
(function walk(node, path) {
  if (!node.files) return;
  for (const [key, value] of Object.entries(node.files)) {
    const next = path ? `${path}/${key}` : key;
    if (value.files) walk(value, next);
    else files.push({ path: next, offset: Number(value.offset), size: Number(value.size) });
  }
})(header, '');

const target = files.find((f) => f.path === 'out/main/chunk-ITPGAKRE.js');
const code = buf
  .subarray(base + target.offset, base + target.offset + target.size)
  .toString('utf8');

const KEY = 'zMe';
const anchor = code.indexOf(KEY);
console.log('--- .zcode-plugin/plugin.json 常量附近 ---');
console.log(code.slice(Math.max(0, anchor - 100), anchor + 120));
console.log('');

for (const keyword of ['marketplaces', 'installed_plugins', 'projects', 'workspace', 'cache']) {
  let index = -1;
  let shown = 0;
  while ((index = code.indexOf(keyword, index + 1)) >= 0 && shown < 4) {
    const around = code.slice(Math.max(0, index - 170), index + 170).replace(/\s+/g, ' ');
    if (/join|readdir|readdirWith|resolve/.test(around)) {
      shown += 1;
      console.log(`[${keyword}] ${around}\n`);
    }
  }
}
