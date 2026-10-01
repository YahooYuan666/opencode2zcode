#!/usr/bin/env node
/** 一次性调查：ZCode「模型 ID」旁边的「显示名称」到底存在哪个字段。 */
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

const needle = process.argv[2] ?? 'modelDisplayName';
const KEY = Buffer.from(needle);
console.log(`在全部 ${files.length} 个文件里搜 "${needle}"（只列 .js/.json）：\n`);

for (const file of files) {
  if (!/\.(js|json|html)$/.test(file.path)) continue;
  const chunk = buf.subarray(base + file.offset, base + file.offset + Math.min(file.size, 8_000_000));
  const index = chunk.indexOf(KEY);
  if (index < 0) continue;
  const text = chunk.toString('utf8');
  console.log(`\n########## ${file.path} @${index} ##########`);
  console.log(text.slice(Math.max(0, index - 700), index + 700).replace(/\s+/g, ' '));
}
