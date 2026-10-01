#!/usr/bin/env node
/**
 * 一次性调查：ZCode 在模型选择器里显示的名字，是直接用 modelId，
 * 还是另有一个可写的「显示名」字段。
 * 结论决定「能不能把评分/中文名塞进显示名」。见 README。
 */
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

const renderer = files.filter((f) => /^out\/renderer\/assets\/.*\.js$/.test(f.path));

const NEEDLES = process.argv.slice(2);
if (NEEDLES.length === 0) NEEDLES.push('modelId');

for (const needle of NEEDLES) {
  const KEY = Buffer.from(needle);
  const hits = [];
  for (const file of renderer) {
    const chunk = buf.subarray(base + file.offset, base + file.offset + Math.min(file.size, 4_000_000));
    const index = chunk.indexOf(KEY);
    if (index >= 0) hits.push({ file, index });
  }
  console.log(`\n===== "${needle}" 命中 ${hits.length} 个文件 =====`);
  for (const hit of hits.slice(0, 4)) {
    const chunk = buf.subarray(base + hit.file.offset, base + hit.file.offset + Math.min(hit.file.size, 4_000_000));
    const from = Math.max(0, hit.index - 420);
    console.log(`\n----- ${hit.file.path} @${hit.index} -----`);
    console.log(chunk.subarray(from, hit.index + 620).toString('utf8').replace(/\s+/g, ' '));
  }
}
