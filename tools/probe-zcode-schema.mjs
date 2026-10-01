#!/usr/bin/env node
/**
 * 一次性调查脚本：ZCode 自己怎么消费 providerModelRules，确认模型条目里
 * 有没有能显示「评分 / 描述」这类自由文本的字段。
 * 结论见 README「评分能不能显示」一节。
 */
import fs from 'node:fs';

const ASAR = 'D:/Program Files/ZCode/resources/app.asar';
const buf = fs.readFileSync(ASAR);
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

const NEEDLES = process.argv.slice(2);
if (NEEDLES.length === 0) NEEDLES.push('providerModelRules');

const targets = files.filter((f) => /^out\/renderer\/assets\/.*\.js$/.test(f.path));
console.log(`扫描 renderer js ${targets.length} 个，关键词：${NEEDLES.join(', ')}\n`);

for (const needle of NEEDLES) {
  const KEY = Buffer.from(needle);
  const hits = [];
  for (const file of targets) {
    const start = base + file.offset;
    const chunk = buf.subarray(start, start + Math.min(file.size, 4_000_000));
    const index = chunk.indexOf(KEY);
    if (index >= 0) hits.push({ file, index });
  }
  console.log(`=== "${needle}" 命中 ${hits.length} 个文件 ===`);
  for (const hit of hits.slice(0, 3)) {
    const start = base + hit.file.offset;
    const chunk = buf.subarray(start, start + Math.min(hit.file.size, 4_000_000));
    const from = Math.max(0, hit.index - 500);
    console.log(`\n----- ${hit.file.path} -----`);
    console.log(chunk.subarray(from, hit.index + 900).toString('utf8').replace(/\s+/g, ' '));
  }
  console.log('');
}
