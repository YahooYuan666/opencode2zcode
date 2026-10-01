# AI-SETUP.md —— 给 AI 助手的安装说明

> 这份文件是写给**在目标电脑上工作的 AI 助手**的，不是写给人的。
> 人类用户只需要知道最后那一步（见第 7 节）。请按顺序执行，每步都要看实际输出再往下走。

---

## 0. 你要做的事，用一句话说

把一个本地回环代理装成**随 ZCode 自动启动**，并让 **ZCode** 的「个人 Provider 配置」
多出一组名为 **OpenCode 免费模型**的服务。ZCode 每秒轮询该配置文件，所以写完不需要重启。

装完之后：**用户再也不用管，也永远看不见黑窗口**——启动 ZCode 时自动拉起。

**先读第 8 节的风险说明，再决定要不要继续。**

---

## 1. 前置检查

**这个包只有一个文件：`opencode2zcode.exe`（2.0 MB，自包含）。**
用户**不需要装 Node.js，也不需要装任何运行时**。

先确认它在：

```bash
dir opencode2zcode.exe
```

找不到就停下来问用户要，别自己去找路径。

> 如果用户拿到的是源码目录（里面有 `zen-proxy.mjs` 而不是 exe），那才需要
> Node.js 18+。但正常分发只发 exe。

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
opencode2zcode.exe --detect
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
opencode2zcode.exe --config "<数据根>\.zcode\v2\provider_config.json" --write-config-only
```

---

## 3. 先看要写什么（不落盘）

```bash
opencode2zcode.exe --print-config
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
opencode2zcode.exe --write-config-only
```

**期望输出**：

```
[zen] 配置目标（自动探测）：<数据根>\.zcode\v2\provider_config.json
已写入 <数据根>\.zcode\v2\provider_config.json
chat 7 个模型 / responses 0 个模型
```

> 期望是 **chat 7 个 / responses 0 个**。这 7 个是目录里那 8 个「免费且未下架」模型中
唯一真能调用的——第 8 个（`muse-spark-1.3-contributor-free`）所在的 responses 通道
上游对外部一律 403，见第 8 节。
> 数字对不上通常意味着目录刷新没成功（`catalog.source` 不是 `live`），
> 或者上游在变——先跑 `--detect` 和 `/healthz` 确认，不要硬凑。

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

## 6. 装上「随 ZCode 自动启动」（核心步骤）

前面几步只是把配置写好了，代理本身还没跑。这一步让它以后自动跑。

```bash
opencode2zcode.exe --install
```

**期望输出**：

```
[autostart] 已写入 SessionStart 钩子：C:\Users\<用户>\.zcode\cli\config.json
[autostart] 钩子命令：<本程序的绝对路径> --ensure
[autostart] 从现在起，启动 ZCode 会自动静默拉起代理，不用再双击任何东西。
```

重复执行安全——**这个命令是幂等的**：只会保证有且只有一条属于本工具的钩子，
且永远指向当前这个位置。如果输出里出现「清掉了 N 条指向已不存在位置的旧钩子」，
说明之前装在别处过，正常。

它做了什么：往 ZCode 的 CLI 配置里加一条 `SessionStart` 钩子，指向本程序并带
`--ensure`。ZCode 启动时它会检查代理在不在，不在就**静默**拉起
（`detached` + `windowsHide`，不弹窗口），并最多等 6 秒；无论成败退出码恒为 0，
不会影响 ZCode 开会话。

> **⚠️ 必须在「最终摆放位置」上执行这一步。**
> ZCode 的钩子只认绝对路径，所以上面那条命令把**当前这个位置**的路径记进了配置。
> 如果你打算把文件挪到别处，**先挪完再执行这一步**；已经挪过了也没关系，
> 到新位置重跑一次即可——它会认出自己的旧钩子并替换，指向已不存在路径的那条会被清掉。
> （ZCode 的 `${ZCODE_PROJECT_DIR}` 是**工作区**相对路径，指向用户打开的项目文件夹，
> 不是本工具的安装位置，所以这里用不上。）

> **这一步会修改 ZCode 的配置文件。** 动手前告诉用户你要改什么；
> 程序会自动在同目录留一份 `config.json.bak-<时间戳>`。
> 用户的其它 `mcp` / `plugins` / 别人的 `SessionStart` 钩子都不会被碰。

装完立刻验证一次（不必等下次开 ZCode）：

```bash
opencode2zcode.exe opencode2zcode-hook
curl http://127.0.0.1:41930/healthz
```

**期望输出**：

```
[zen] 回环代理已监听 127.0.0.1:41930
[zen] 已同步 ZCode 配置：<数据根>\.zcode\v2\provider_config.json
[zen] chat 7 个 / responses 0 个模型
```

然后 `curl` 应回 `"ok":true` 且 `catalog.source` 为 `live`
（`static` 表示还没联网成功，用内置兜底清单，仍可用）。

再发一条真实对话确认整条链路：

```bash
curl -s -X POST http://127.0.0.1:41930/v1/chat/completions \
  -H "content-type: application/json" \
  -d "{\"model\":\"big-pickle\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with exactly: OK\"}]}"
```

期望返回 SSE 流（`data: {"id":...` 开头）。能返回就说明整条链路通了。

**这个代理进程是常驻的**，但用户**不需要看见它、也不需要留着任何窗口**。
关掉 ZCode 不影响它，下次开 ZCode 时钩子会发现它还在、什么都不做。

---

## 7. 告诉用户的一句话（用大白话，不要讲术语）

> 装好了。**以后你什么都不用管**——每次开 ZCode 它自己就悄悄启动了，
> 你不会看到任何黑窗口。去 **设置 → 模型服务** 找 **「OpenCode 免费模型」**，
> 在聊天框的模型选择器里直接选着用，跟内置模型一样。

**不想要了怎么撤销**：双击本目录的 `uninstall.cmd`。它会删掉那条自启钩子、
并把这两个 Provider 从配置里摘掉，你的其它 Provider 和其它钩子都不受影响。

---

## 7.1 可选：跑一遍自测

```bash
node selftest.mjs
```

**期望输出**：`结果：16 通过 / 0 失败`。

它用本地 mock 上游跑，**不打任何真实网络请求**，几秒出结果。覆盖免费判定、
下架剔除、伪装头、体门禁、档位归一、Provider 增删的对称性。
改动过 `rust/src/` 之后建议跑一次再交付。

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

**③ 有一个模型调不通，属于上游限制，不是本工具的 bug。**
`muse-spark-1.3-contributor-free` 只挂在 OpenCode 的 `/v1/responses` 通道上，
而那条通道对**匿名**调用一律 403：

```
OpenCode's free tier can only be used from within OpenCode
```

原因不是少了什么请求头，而是**额度归属**：对照 OpenCode 自己的模型清单
（`packages/console/app/src/component/go-models.ts`），能匿名用的免费模型额度都是
`Infinity`（`space-bunny-free`、`longcat-2.5-preview-free`），而 muse-spark 是
45300 / 5 小时的**计量额度、且带地区限制**，只发给登录用户。转发给上游推理服务时
OpenCode 会注入自己那把真实 API key，`public` 换来的身份是空的，所以被拒。

已逐项试过，都不是协议细节：补 `bash`/`read` 门禁工具、换 Responses 扁平工具格式、
补 `x-zen-model` / `x-zen-billing-source` 头、去掉 `-free` 后缀——全部无效。
上游的 `opencode2pi-desktop` 同样如此。

所以工具**默认不把这一组写进配置**，模型选择器里不会出现它。
上游哪天放开（或用户愿意用自己的 OpenCode 账号 key），`--with-responses` 可以加回来。

> 早先版本里还有 `muse-spark-1.2-contributor-free` 和 `deepseek-v4-flash-free`，
> 现在都不会再出现了——它们在 OpenCode 官方目录里标着「已下架」，
> 判定规则已经和桌面版对齐把它们剔掉了。

## 9. 出问题时怎么排查

| 现象 | 排查 |
| --- | --- |
| 设置里没有「OpenCode 免费模型」 | 先看 `配置目标` 那行的括号内容，是不是「用户主目录兜底」；再看 `--detect` 的结论路径对不对 |
| 有分组但一发消息就失败 | 代理没在跑。`curl http://127.0.0.1:41930/healthz` 确认。手动跑 `--ensure` 能拉起来就说明钩子没生效——重跑一次 `--install` |
| 报 403 `FreeTierError` | 伪装头或请求体门禁没过，上游收紧了。改 `rust/src/zen.rs` 里的 `OPENCODE_CLIENT_VERSION` 跟官方 CLI 版本号 |
| 报 429 | 匿名通道按 IP 限速，等一会儿 |
| 报 400 `invalid request` | 看代理 stderr 有没有「摘掉该字段重试」的日志；重试也失败说明这个模型当前不可用 |
| 模型列表比预期少 | 看 `/healthz` 的 `catalog.status`，`static` = 还没联网成功，用的是内置兜底清单。目录里判定为「已下架」的模型会被有意剔掉，属正常 |
| ZCode 启动时什么都没发生，模型不生效 | 钩子指向的路径可能失效了（文件被移动/改名过）。在新位置重跑一次 `--install`，它会替换掉旧的那条 |
| 改了代码怕改坏 | 跑 `node selftest.mjs`，22 项全过再交付 |

代理日志走 **stderr**，`--print-config` 的 JSON 走 **stdout**，方便重定向。

---

## 10. 命令速查

```bash
opencode2zcode.exe --install            # 装上「随 ZCode 自动启动」（幂等）
opencode2zcode.exe --uninstall          # 卸掉钩子 + 摘掉本工具的 Provider
opencode2zcode.exe opencode2zcode-hook  # 手动触发一次检查+拉起（无窗口）
opencode2zcode.exe --detect             # 看探测到的数据目录与判据
opencode2zcode.exe --print-config       # 看要写什么（apiKey 已脱敏，不落盘）
opencode2zcode.exe --write-config-only  # 只写配置后退出
opencode2zcode.exe --remove-provider    # 从 ZCode 配置里摘掉本工具的两个 Provider
opencode2zcode.exe                      # 前台起代理（调试用，窗口要开着）
opencode2zcode.exe --port 41931         # 换端口
opencode2zcode.exe --config <完整路径>   # 直接指定 provider_config.json
opencode2zcode.exe --with-responses     # 连 responses 道那一组也写进配置（默认不写）
opencode2zcode.exe --help               # 全部参数
```

如果用户手上是源码目录而不是 exe，把 `opencode2zcode.exe` 换成
`node zen-proxy.mjs` 即可，参数完全一样（源码目录需要 Node.js 18+）。

```

## 11. 本包的文件

```
opencode2zcode.exe     唯一要分发的文件（2.0 MB，自包含，零依赖）
README.md              给人看的说明
AI-SETUP.md            本文件，给 AI 看的安装说明
```

装了 Node.js 18+ 的话还能拿到源码与测试：

```
zen-proxy.mjs          等价的 Node 实现（行为基准）
selftest.mjs           Node 版自测，22 项
rust/                  Rust 源码与测试
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

**与上游项目的两处有意偏离**（重要，别改回去）：

**① `reasoning_effort` 不做「一律归一成 none」。**
上游把 off/缺失/未知**一律归一成 `"none"`**，注释说这是关掉 always-think 的唯一写法。
但 2026-10 实测该写法会直接把请求打成 **400**，而且各模型接受的档位并不一致
（`big-pickle` 只收 `minimal`→`max`；`nemotron-3.5` 收 `none` 却拒 `off`）。
本工具改为：只透传上游确实认的主动档位，`off`/`none`/缺失/未知一律**省略该字段**，
另加一次「摘掉该字段重试」兜底。

**② 「免费」的判定对齐 OpenCode 桌面版，并排除已下架模型。**
桌面版的判定就一行（`packages/app/src/components/dialog-select-model.tsx`）：

```ts
const isFree = (provider, cost) => provider === "opencode" && (!cost || cost.input === 0)
```

本工具照搬，**外加排除 `status == "deprecated"`**。两点容易踩：
只看 `input` 不看 `output`，且「没有 cost 数据」也算免费；
Zen 会把下架模型留在公开清单里而标价仍是 0，不排除的话模型选择器里会出现
点下去必报错的选项。目录里标称免费的有 34 个，过滤后剩 8 个，与桌面版完全相同。
`rust/src/catalog.rs` 的单元测试里有针对这一条的回归。
