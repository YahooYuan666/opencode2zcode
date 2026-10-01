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

/** 认领钩子用的文件名；也是本工具在 ZCode 配置里唯一的身份标识。 */
const ENSURE_BASENAME = 'ensure-proxy.mjs';

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

/**
 * 这条 SessionStart 钩子是不是 opencode2zcode 的。
 *
 * 认的是**脚本文件名**，不是绝对路径。这一点很关键：ZCode 的钩子必须写绝对
 * 路径，而绝对路径会在项目目录被移动/改名后失效。早先按完整路径比对，导致
 * 「把项目文件夹改名后再装一次」会被当成没装过，于是一条新的加上去、那条
 * 指向旧路径的死钩子留在配置里——每次开 ZCode 都会跑一个不存在的文件。
 * 按文件名认则天然幂等：重装即替换。
 */
function isOurHook(entry) {
  const list = Array.isArray(entry?.hooks) ? entry.hooks : [];
  return list.some((hook) => {
    if (!Array.isArray(hook?.args)) return false;
    return hook.args.some(
      (arg) => typeof arg === 'string' && path.basename(arg).toLowerCase() === ENSURE_BASENAME,
    );
  });
}

/** 钩子指向的文件还在不在。不在就是条死钩子，装的时候顺手清掉。 */
function hookTargetExists(entry) {
  const list = Array.isArray(entry?.hooks) ? entry.hooks : [];
  for (const hook of list) {
    if (!Array.isArray(hook?.args)) continue;
    for (const arg of hook.args) {
      if (typeof arg === 'string' && path.basename(arg).toLowerCase() === ENSURE_BASENAME) {
        return fs.existsSync(arg);
      }
    }
  }
  return true;
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

  // 别人的钩子原样留下；我们自己那条永远只留一条，且永远指向当前这个目录。
  const foreign = existing.filter((item) => !isOurHook(item));
  const stale = existing.filter((item) => isOurHook(item) && !hookTargetExists(item));

  events.SessionStart = [entry, ...foreign];
  config.hooks.events = events;
  writeJsonWithBackup(configPath, config);

  if (stale.length > 0) {
    console.log(`[install] 清掉了 ${stale.length} 条指向已不存在目录的旧钩子。`);
  }
  console.log(`[install] 已写入 SessionStart 钩子：${configPath}`);
  console.log(`[install] 钩子命令：${process.execPath} ${ENSURE}`);
  console.log('[install] 从现在起，启动 ZCode 会自动静默拉起代理，不用再双击任何东西。');
  console.log('[install] 注意：上面这个路径是写死的。以后若移动或改名了本目录，');
  console.log('[install]        到新位置重跑一次本命令即可（旧的会被自动替换）。');
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
