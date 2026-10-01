#!/usr/bin/env node
/**
 * 安装 / 卸载「随 ZCode 自动启动」。
 *
 * 装完之后的体感：用户什么都不用管，也永远看不见黑窗口——启动 ZCode 时
 * SessionStart 钩子自动把代理拉起来（无窗口），配置热生效。
 *
 * 做法是把一条 SessionStart 钩子写进 ZCode 的 CLI 配置：
 *   {USERPROFILE}/.zcode/cli/config.json
 * 这条路径取自 ZCode 主进程本身（它就是从 HOME/USERPROFILE 下的
 * .zcode/cli/config.json 读 mcp / plugins / hooks 的）。
 *
 * 钩子形如 process 类型：直接给可执行文件 + 参数数组，不过 shell，
 * Windows 上最稳。node 的**绝对路径**在安装时就写死，免得目标机上
 * PATH 里没有 node 时钩子静默失败。
 *
 * 卸载是干净的：删掉我们那条钩子（只认自己写的，按脚本路径匹配），
 * 你的其它 mcp / plugins 配置一个字都不动。
 *
 * 用法：
 *   node install.mjs             装上自启，并立刻拉起一次代理
 *   node install.mjs --uninstall 卸掉自启（代理本身的 provider 由
 *                                zen-proxy.mjs --remove-provider 负责）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENSURE = path.join(SCRIPT_DIR, 'ensure-proxy.mjs');
const HOOK_TIMEOUT_MS = 12_000;

/** 规范化后的自身路径，install / uninstall 共用同一把尺子。 */
const ENSURE_KEY = path.resolve(ENSURE).replace(/\\/g, '/').toLowerCase();

function zcodeCliConfigPath() {
  const home = process.env.USERPROFILE?.trim() || os.homedir();
  return path.join(home, '.zcode', 'cli', 'config.json');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonWithBackup(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    try {
      fs.copyFileSync(file, `${file}.bak-${stamp}`);
    } catch {
      /* 备份失败不阻断 */
    }
  }
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, file);
}

/** 这条钩子是不是我们的。只认自己写进去的那一条，不误伤别人的 SessionStart 钩子。 */
function isOurHook(entry) {
  const list = Array.isArray(entry?.hooks) ? entry.hooks : [];
  return list.some((hook) => {
    if (!Array.isArray(hook?.args)) return false;
    // 比对规范化后的绝对路径：装的时候写什么、卸载时就算什么，
    // 不靠子串猜——目录名里带点、斜杠方向不同都会让子串匹配失效。
    return hook.args.some((arg) => {
      if (typeof arg !== 'string') return false;
      const normalized = path.resolve(arg).replace(/\\/g, '/').toLowerCase();
      return normalized === ENSURE_KEY;
    });
  });
}

function install() {
  const configPath = zcodeCliConfigPath();
  const config = readJson(configPath) ?? {};
  config.hooks = config.hooks && typeof config.hooks === 'object' ? config.hooks : {};
  config.hooks.enabled = true;
  const events = config.hooks.events && typeof config.hooks.events === 'object' ? config.hooks.events : {};
  const existing = Array.isArray(events.SessionStart) ? events.SessionStart : [];

  const entry = {
    hooks: [
      {
        type: 'process',
        command: process.execPath,
        args: [ENSURE],
        timeoutMs: HOOK_TIMEOUT_MS,
      },
    ],
  };

  if (existing.some(isOurHook)) {
    console.log('[install] 自启钩子已经在位，无需重复安装。');
  } else {
    events.SessionStart = [entry, ...existing];
    config.hooks.events = events;
    writeJsonWithBackup(configPath, config);
    console.log(`[install] 已写入 SessionStart 钩子：${configPath}`);
  }
  console.log(`[install] 钩子命令：${process.execPath} ${ENSURE}`);
  console.log('[install] 从现在起，启动 ZCode 会自动静默拉起代理，不用再双击任何东西。');
}

function uninstall() {
  const configPath = zcodeCliConfigPath();
  const config = readJson(configPath);
  if (!config?.hooks?.events?.SessionStart) {
    console.log('[uninstall] 配置里没有 SessionStart 钩子，无需卸载。');
    return;
  }
  const before = config.hooks.events.SessionStart.length;
  const kept = config.hooks.events.SessionStart.filter((entry) => !isOurHook(entry));
  const removed = before - kept.length;

  if (removed === 0) {
    console.log('[uninstall] 没有属于 opencode2zcode 的钩子（别人的钩子一个没动）。');
    return;
  }

  if (kept.length === 0) delete config.hooks.events.SessionStart;
  else config.hooks.events.SessionStart = kept;
  if (Object.keys(config.hooks.events).length === 0) delete config.hooks.events;
  // 事件被清空后，剩下的 hooks.enabled 只是个空开关（没有事件可跑），
  // 装之前没有就整个撤掉，做到真正的「回到装之前」。
  if (config.hooks.events === undefined) delete config.hooks;

  writeJsonWithBackup(configPath, config);
  console.log(`[uninstall] 已移除 ${removed} 条自启钩子：${configPath}`);
  console.log('[uninstall] 其它 mcp / plugins / hooks 配置保持原样。');
}

if (!fs.existsSync(ENSURE)) {
  console.error(`[install] 找不到 ${ENSURE}，请在项目目录里运行。`);
  process.exit(1);
}

if (process.argv.includes('--uninstall')) uninstall();
else install();
