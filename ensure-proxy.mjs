#!/usr/bin/env node
/**
 * SessionStart 钩子：ZCode 一启动就检查代理在不在，不在就静默拉起。
 *
 * 设计约束（都是被 ZCode 的钩子契约逼出来的）：
 *   - 钩子**永远同步执行**，`async: true` 不起作用。所以本脚本自己负责
 *     「快速判断 → 需要时才等一小会儿 → 无论如何都退出 0」。
 *   - 绝不能 block 或 deny 会话：任何异常都吞掉，退出码恒为 0。
 *   - 拉起的子进程必须 detached + windowsHide，否则用户会看见一个黑窗口
 *     凭空弹出来——那正是要消除的东西。
 *
 * 单实例保护：并发启动多个 ZCode 会话时，只允许一个进程真正拉起代理。
 * 否则第二个实例会绑到 41931 并把配置里的 baseUrl 改掉，用户会突然发现
 * 「模型突然不能用了」。用排他锁文件 + 端口健康检查双重兜底。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROXY = path.join(SCRIPT_DIR, 'zen-proxy.mjs');
const LOCK_FILE = path.join(SCRIPT_DIR, '.proxy-start.lock');
const PORT_CANDIDATES = [41930, 41931, 41932, 41933];

/** 锁超过这个秒数就当作上次崩了留下的陈锁，直接接管。 */
const LOCK_STALE_SECONDS = 20;
/** 等代理就绪的上限。超时就放弃——反正它自己也会在后台把配置写好。 */
const READY_TIMEOUT_MS = 6000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 任一候选端口上有代理在应答就算在跑。 */
async function probe(port, timeoutMs = 700) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return false;
    const body = await response.json();
    return body && body.ok === true;
  } catch {
    return false;
  }
}

async function anyProxyAlive() {
  for (const port of PORT_CANDIDATES) {
    if (await probe(port)) return port;
  }
  return null;
}

/** 抢排他锁；抢到返回 true。文件被删或过期都视为可抢。 */
function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(LOCK_FILE, `${process.pid}\n`, { flag: 'wx' });
      return true;
    } catch (error) {
      if (!error || error.code !== 'EEXIST') return false;
      let age = Infinity;
      try {
        age = (Date.now() - fs.statSync(LOCK_FILE).mtimeMs) / 1000;
      } catch {
        age = Infinity;
      }
      if (age > LOCK_STALE_SECONDS) {
        // 陈锁：上一个拉起过程崩了，清掉重抢。
        try {
          fs.unlinkSync(LOCK_FILE);
        } catch {
          /* 抢不到就算了，走下面的兜底 */
        }
        continue;
      }
      return false;
    }
  }
  return false;
}

function releaseLock() {
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch {
    /* 本来就没有，无所谓 */
  }
}

function spawnDetached() {
  const child = spawn(process.execPath, [PROXY], {
    cwd: SCRIPT_DIR,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}

async function main() {
  if (!fs.existsSync(PROXY)) return 0;

  const alive = await anyProxyAlive();
  if (alive) return 0;

  if (!acquireLock()) {
    // 别的实例正在拉起，等它一下就到点了。
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(400);
      if (await anyProxyAlive()) return 0;
    }
    return 0;
  }

  try {
    // 拿到锁之后再确认一次：可能正好在等锁期间别人已经拉起来了。
    if (await anyProxyAlive()) return 0;
    spawnDetached();
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(300);
      if (await anyProxyAlive()) return 0;
    }
    return 0;
  } finally {
    releaseLock();
  }
}

// 钩子里任何异常都不许冒到 ZCode 去影响会话。
main().catch(() => {});
process.exitCode = 0;
