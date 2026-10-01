# AI-SETUP.md —— 给 AI 助手的安装说明

> 这份文件是写给**在目标电脑上工作的 AI 助手**的，不是写给人的。
> 人类用户只需要知道最后那两步（见第 7 节）。请按顺序执行，每步都要看实际输出再往下走。

---

## 0. 你要做的事，用一句话说

把一个本地回环代理跑起来，并让 **ZCode** 的「个人 Provider 配置」多出一组名为
**OpenCode 免费模型**的服务。ZCode 每秒轮询该配置文件，所以写完不需要重启 ZCode。

**先读第 8 节的风险说明，再决定要不要继续。**

---

## 1. 前置检查

```bash
node --version
```

需要 **Node 18 或更高**（用到内置 `fetch`）。没有就停下来，告诉用户先装 Node.js，不要自行安装系统级软件。

记下本目录的绝对路径，后面叫它 `<PKG>`：

```bash
cd <这个文件所在的目录>
pwd
```

---

## 2. 判断 ZCODE_DATA_BASE_DIR（最关键的一步）

**背景（这是本项目踩过的坑）**：`ZCODE_DATA_BASE_DIR` **不是 Windows 持久环境变量**，
注册表里查不到，它只是 ZCode 启动自己子进程时注入的。
所以如果从资源管理器双击 `.cmd`，这个变量是**不存在**的——配置会写到用户主目录，
而 ZCode 读的是另一个目录，用户就会报「设置里找不到模型分组」。

**如果你（AI）就运行在目标机的 ZCode 里**，你的终端环境里通常已经有它，直接看：

```bash
node -e "console.log(process.env.ZCODE_DATA_BASE_DIR || '(未设置)')"
```

- 打印出路径（例如 `D:\Program`）→ 记下它，这就是数据根。跳到第 3 步。
- 打印 `(未设置)` → 继续往下。

不要为此猜测或硬编码路径，用工具自己的探测：

```bash
node zen-proxy.mjs --detect
```

**期望输出**（本机示例）：

```
ZCode 数据目录候选（✓ = 带 v2/runtime，即认得出来）：
  ✓ [6] D:\Program\.zcode\v2
          证据：v2/runtime、v2/provider_config.json、v2 最近写入 ...
  （另有 78 个 0 分候选已忽略）

环境变量 ZCODE_DATA_BASE_DIR：（未设置）
旁路文件：（无）
           <PKG>\zcode-data-dir.txt

结论：采用 D:\Program\.zcode\v2
配置将写入：D:\Program\.zcode\v2\provider_config.json
```

判断标准：

- 出现带 ✓ 的候选，且 `结论：采用 ...` → 探测成功，直接用，跳到第 3 步。
- 一个 ✓ 都没有 → 探测失败，走第 2.1 步。

### 2.1 探测失败怎么办

不要瞎猜路径。按这个顺序找证据：

1. **问用户**：让他在 ZCode 里随便开一个对话，然后在他的终端里运行
   `echo %ZCODE_DATA_BASE_DIR%`。这是最权威的答案。
2. **看 ZCode 装在哪、数据在哪**：数据根下必有 `.zcode\v2\runtime` 子目录，
   里面有按版本号分的运行资源。可以在常见位置找：
   `%USERPROFILE%\.zcode`、以及各固定盘的浅层目录（如 `D:\Program\.zcode`）。
3. **拿不到就让用户指路**：问他平时打开 ZCode 用哪个账号/哪个盘，或者直接让他把
   `<数据根>\.zcode\v2` 这个目录找出来告诉你。

拿到路径后，后续所有命令都显式带上：

```bash
node zen-proxy.mjs --config "<数据根>\.zcode\v2\provider_config.json" --write-config-only
```

---

## 3. 先看要写什么（不落盘）

```bash
node zen-proxy.mjs --print-config
```

这个模式**不落盘、不起服务**，而且会把**所有** provider 的 `apiKey` 换成
`***已隐藏***`（不会把用户已有密钥打到终端上）。

重点确认三件事：

1. 输出里有两个 `providerId` 为 `opencode-free` 和 `opencode-free-responses` 的条目。
2. `api.baseUrl` 是 `http://127.0.0.1:41930/v1`（端口后面可以改）。
3. `providerConfigRules.providerRules` 里**用户原有的 provider 一个都没少**——
   本工具只替换自己那两个 id，其它原样保留。

不对就停下来报告，不要继续写。

---

## 4. 正式写配置

```bash
node zen-proxy.mjs --write-config-only
```

**期望输出**：

```
[zen] 配置目标（自动探测）：<数据根>\.zcode\v2\provider_config.json
已写入 <数据根>\.zcode\v2\provider_config.json
chat 8 个模型 / responses 2 个模型
```

检查这几行：

- `配置目标（...）` 那行括号里写的是不是 `自动探测` / `环境变量 ZCODE_DATA_BASE_DIR` /
  `上次探测记录`；如果是 `用户主目录兜底`，**说明没找对地方，回第 2.1 步**。
- 打印的路径是不是 ZCode 真正读的那个。
- 有没有出现以 `[zen] 警告：没能确认 ZCode 正在使用的数据目录` 开头的警告。
  **有警告就是没找对，不要往下走。**

写入行为（可以向用户保证）：

- 写之前在**同目录**留一份 `provider_config.json.bak-<时间戳>`。
- 原子写（同目录临时文件 + rename）。
- 只替换 `opencode-free` / `opencode-free-responses` 两个 id，其余 provider 与
  `providerOrder` 原样保留。

写完后工具会在自己目录生成 `zcode-data-dir.txt`（记录数据根），
它只是给后面的 `.cmd` 双击走快路径用的，**不要把这个文件拷到别的电脑**。

---

## 5. 验证配置真的生效

```bash
node -e "const c=require('<数据根>/.zcode/v2/provider_config.json');console.log(c.config.providerConfigRules.providerRules.map(r=>r.providerId).join('\n'))"
```

应能看到 `opencode-free` 与 `opencode-free-responses` 两个 id，
且用户原有的 id 都还在。

ZCode 大约 **1 秒**轮询一次该文件。若设置页没刷新，让用户切走再切回来，或重开设置页；
**通常不需要重启 ZCode**。

---

## 6. 让代理跑起来（可选但推荐，用来验证链路）

双击 `start-zen-proxy.cmd`，或：

```bash
node zen-proxy.mjs
```

**期望输出**：

```
[zen] 回环代理已监听 127.0.0.1:41930
[zen] 配置目标（...）：<数据根>\.zcode\v2\provider_config.json
[zen] 已同步 ZCode 配置：<数据根>\.zcode\v2\provider_config.json
[zen] chat 8 个 / responses 2 个模型
```

然后验证：

```bash
curl http://127.0.0.1:41930/healthz
```

期望 `"ok":true`，且 `catalog.source` 是 `live`（`static` 表示还没联网成功，
用内置兜底清单，仍可用）。再发一条真实对话：

```bash
curl -s -X POST http://127.0.0.1:41930/v1/chat/completions \
  -H "content-type: application/json" \
  -d "{\"model\":\"big-pickle\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly: OK\"}]}"
```

期望返回 SSE 流（`data: {"id":...` 开头）。能返回就说明整条链路通了。

**这个进程是常驻的**——用户关掉那个窗口，代理就停了，模型也就不能用了。
所以第 7 节要提醒用户「别关窗口」。

---

## 7. 告诉用户的两步（用大白话，不要讲术语）

1. 双击本目录里的 **`start-zen-proxy.cmd`**，会弹出一个黑窗口，**别关它**（关了代理就停了）。
2. 回到 ZCode，打开 **设置 → 模型服务**，找到 **「OpenCode 免费模型」**。
   之后在聊天框的模型选择器里直接选它，跟内置模型一样用。

不想要了怎么撤销：关掉黑窗口；把同目录的 `provider_config.json.bak-<时间戳>`
复制回去覆盖 `provider_config.json`。

---

## 8. 必须先告诉用户的三件事

**① 这是客户端伪装，不是官方接入。**
OpenCode Zen 的匿名免费档位接受一个公开占位符 `public` 作为凭据（不是偷来的密钥、
不涉及用户账号）。但它同时有一道门，明确提示「免费档位只能从 OpenCode 里使用」。
本工具靠**把自己伪装成 OpenCode 官方 CLI**（伪装请求头 + 会话 id 形状 + 请求体里塞
两个它家客户端才有的工具名）通过这道检查。

所以：没有盗用任何账号或密钥，**但确实是在冒充身份去过一道对方明确设了限制的关卡**。
上游随时可能改规矩让它失效。请如实告知用户，不要淡化。

**② 匿名通道按 IP 限速。**
429 会被原样透传给用户。不要用它跑大批量任务。

**③ 有两个模型在本机/本地区不可用，属于正常现象。**
`muse-spark-1.2-contributor-free` 和 `muse-spark-1.3-contributor-free` 会返回
`RegionError: This model is not available in your country`（地区限制）。
不需要就把 `opencode-free-responses` 这组从配置里删掉，不影响其他模型。

另外 `deepseek-v4-flash-free` 在 Zen 的实时清单里存在，但被元数据判为非免费而过滤掉了，
且实测对所有思考档位组合都返回 400，等于当前不可用。

---

## 9. 出问题时怎么排查

| 现象 | 排查 |
| --- | --- |
| 设置里没有「OpenCode 免费模型」 | 先看 `配置目标` 那行的括号内容，是不是「用户主目录兜底」；再看 `--detect` 的结论路径对不对 |
| 有分组但一发消息就失败 | 代理没在跑。`curl http://127.0.0.1:41930/healthz` 确认；提醒用户别关黑窗口 |
| 报 403 `FreeTierError` | 伪装头或请求体门禁没过，上游收紧了。改 `zen-proxy.mjs` 里的 `OPENCODE_CLIENT_VERSION` 跟官方 CLI 版本号 |
| 报 429 | 匿名通道按 IP 限速，等一会儿 |
| 报 400 `invalid request` | 看代理 stderr 有没有「摘掉该字段重试」的日志；重试也失败说明这个模型当前不可用 |
| 模型列表比预期少 | 看 `/healthz` 的 `catalog.status`，`static` = 还没联网成功，用的是内置兜底清单 |

代理日志走 **stderr**，`--print-config` 的 JSON 走 **stdout**，方便重定向。

---

## 10. 命令速查

```bash
node zen-proxy.mjs --detect              # 看探测到的数据目录与判据
node zen-proxy.mjs --print-config        # 看要写什么（apiKey 已脱敏，不落盘）
node zen-proxy.mjs --write-config-only   # 只写配置后退出
node zen-proxy.mjs                       # 起代理（常驻）
node zen-proxy.mjs --port 41931          # 换端口
node zen-proxy.mjs --config <完整路径>    # 直接指定 provider_config.json
node zen-proxy.mjs --help                # 全部参数
```

## 11. 本包的文件

```
zen-proxy.mjs        回环代理 + ZCode 配置同步（唯一必需文件，无外部依赖）
start-zen-proxy.cmd  Windows 双击启动器
README.md            给人看的说明
AI-SETUP.md          本文件，给 AI 看的安装说明
```

**不要**把 `zcode-data-dir.txt` 拷到别的电脑——它记录的是源机器上的数据目录。
工具发现它指向的目录不带 `v2/runtime` 时会自动忽略，但最好直接别带。

---

## 12. 技术出处

移植自 [JasonYu0822/opencode2pi-desktop](https://github.com/JasonYu0822/opencode2pi-desktop)
（MIT）的 `lib/zen.js` + `main.js`，其伪装细节来自
[FishBottle7/opencode2dsh](https://github.com/FishBottle7/opencode2dsh) 与
[jasonxu114514/opencode2api](https://github.com/jasonxu114514/opencode2api)。

保留的部分：CLI 一致的伪装头、规范形状的 `ses_` 会话 id、免费通道体门禁、
思考档位归一、S1∩S2 模型目录、SSE 逐块透传、磁盘目录缓存。
有意未移植：IP 池 / 代理轮换子系统、Go sidecar。

**与上游项目的一处有意偏离**（重要，别改回去）：
上游把 `reasoning_effort` 的 off/缺失/未知**一律归一成 `"none"`**，注释说这是关掉
always-think 的唯一写法。但 2026-10 实测该写法会直接把请求打成 **400**，
而且各模型接受的档位并不一致（`big-pickle` 只收 `minimal`→`max`；`nemotron-3.5`
收 `none` 却拒 `off`）。本工具改为：只透传上游确实认的主动档位，
`off`/`none`/缺失/未知一律**省略该字段**，另加一次「摘掉该字段重试」兜底。
