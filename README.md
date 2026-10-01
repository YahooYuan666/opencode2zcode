# opencode2zcode

把 **OpenCode Zen 的匿名免费模型**接进 **ZCode**，像内置模型一样在模型选择器里直接选。

仿照 [JasonYu0822/opencode2pi-desktop](https://github.com/JasonYu0822/opencode2pi-desktop)
（MIT）写的 ZCode 版。那边是把 OpenCode 免费模型接进 PI-Desktop，这边接进 ZCode。

---

## 结论先说：为什么这不是一个「插件」

原项目是个 **PI-Desktop 插件**，靠两样东西工作：

| PI-Desktop 能力 | 作用 |
| --- | --- |
| `contributes.providers`（manifest 静态声明） | 让宿主在**启动插件进程之前**就枚举到 provider，模型选择器里才有这一组 |
| `contributes.services`（后台服务） | 插件进程常驻一个回环 HTTP 端点，承接宿主发来的对话请求 |

**ZCode 的插件没有这两样。** ZCode 的 `.zcode-plugin/plugin.json` 只能贡献四类组件：

```
skills / commands / hooks / mcpServers
```

官方 manifest 参考还明确写了 Codex 的 `interface`、可用性/鉴权 `policy`、`.app.json`
不属于 ZCode 的契约。也就是说：**ZCode 插件无法注册 provider，也无法常驻后台服务**，
原项目那个架构在 ZCode 上没法照搬。

但 ZCode 在**配置层**有等价能力，而且更正式：**个人 Provider 配置**。
所以本工具改成「本进程跑回环代理 + 把 provider 声明写进 ZCode 的个人 Provider 配置」，
对应关系如下：

| opencode2pi-desktop | opencode2zcode |
| --- | --- |
| `manifest.json` 的 `contributes.providers`（静态声明） | 写 `provider_config.json` 的 `providerConfigRules` |
| 改写 manifest 并重载插件来更新模型列表 | 改写 `provider_config.json`，ZCode **每 1 秒轮询**该文件，热生效、**不用重启** |
| `contributes.services` 的 `zen-proxy` 回环端点 | 本工具的 `zen-proxy.mjs`（需你自己启动） |
| `authKind: "none"`，宿主不存密钥 | `access.type: "api-key"` + `apiKey: "public"`（匿名占位，不是密钥） |
| 模型元数据内联在 provider 声明里 | 走 `modelConfigRules.providerModelRules`（smart 车道，部分稀疏配置） |

两个 provider 分列，沿用原项目「一个 provider 只绑一种线上协议」的规则：
`opencode-free`（`openai-chat-completions`）和 `opencode-free-responses`（`openai-responses`）。

---

## 用法

需要 **Node 18+**（用到内置 `fetch`）。本机实测 Node v24.15.0 可用。

### 装一次，之后就不用管了（推荐）

```bash
install-autostart.cmd
```

就这一步。它往 ZCode 的 CLI 配置里写一条 `SessionStart` 钩子，之后**每次启动 ZCode
都会自动把代理拉起来**——**没有黑窗口，不用双击，不用记着开**。装完直接去
ZCode 的 **设置 → 模型服务** 看「OpenCode 免费模型」分组。

想彻底还原，双击 `uninstall.cmd`：它会删掉那条钩子、并把本工具的两个 Provider
从你的个人配置里摘掉，你的其它 Provider 和其它钩子一个字都不动。

<details>
<summary>不想装自启，手动跑（调试用）</summary>

```bash
node zen-proxy.mjs        # 起代理 + 写配置，窗口要一直开着
```

窗口关掉代理就停。适合排查问题，不适合日常用。

</details>

### 命令

```bash
# 只想看会写成什么，不落盘：
node zen-proxy.mjs --print-config

# 只写配置不起服务：
node zen-proxy.mjs --write-config-only

# 从 ZCode 配置里摘掉本工具的两个 Provider（卸载用）
node zen-proxy.mjs --remove-provider

# 跑自测（本地 mock 上游，不打真实网络）
node selftest.mjs
```

### 参数

| 参数 | 说明 |
| --- | --- |
| `--port <n>` | 回环端口，默认 `41930`（被占用时自动退到 41931/41932/41933） |
| `--config <path>` | 直接指定 `provider_config.json` 完整路径，跳过自动探测 |
| `--detect` | 只列出候选数据目录与判据，确认要写到哪儿 |
| `--print-config` | 只打印合并后的配置（**所有 apiKey 已脱敏**），不落盘不起服务 |
| `--write-config-only` | 只写配置后退出 |
| `--remove-provider` | 从 ZCode 配置里摘掉本工具的两个 Provider，其它 Provider 不动 |
| `--help` | 帮助 |

环境变量：

| 变量 | 说明 |
| --- | --- |
| `ZEN_BASE_URL` | 覆盖上游根地址，默认 `https://opencode.ai/zen`。指向本地 mock 便于自测（`selftest.mjs` 就是这么跑的） |
| `ZCODE_DATA_BASE_DIR` | 个人 Provider 配置落点的**最高优先级**依据；没有它就自动探测（见下），**不是**直接退到用户主目录 |

### 诊断

```bash
curl http://127.0.0.1:41930/healthz
curl http://127.0.0.1:41930/v1/models
```

`/healthz` 会回目录状态（`live` / `cache` / `static`）、暴露的模型数、请求数与错误数。

---

## 配置文件位置

与 ZCode 的 `getAppConfigDir()` 一致，形如：

```
{数据根}/.zcode/v2/provider_config.json
```

### 落点怎么定（这个包要在别人电脑上也能用）

配置路径按这个顺序决定，**不写死任何机器专属路径**：

```
--config  >  ZCODE_DATA_BASE_DIR 环境变量  >  自动探测  >  旁路文件  >  用户主目录兜底
```

> **⚠ 最容易踩的坑：`ZCODE_DATA_BASE_DIR` 不是持久环境变量。**
> 它注册表里没有（用户级、系统级都没有），只是 ZCode 启动自己子进程时注入的。
> 所以从资源管理器**双击 `.cmd` 拿不到它**——早先版本会直接退到用户主目录
> （`C:\Users\<你>\.zcode\v2\provider_config.json`），而 ZCode 读的是另一个目录，
> 表现就是「代理明明在跑，设置里就是不出现模型分组」。

**现在改为自动探测**：给若干候选目录打分，判据是 `{数据根}/.zcode/v2/runtime`
是否存在（ZCode 准备运行资源时会建它），并会扫各固定盘的盘根与盘根下一层目录。
得分最高的那个就是答案，探测结果会记进 `zcode-data-dir.txt` 供 `.cmd` 走快路径。

想看探测明细：

```bash
node zen-proxy.mjs --detect
```

**没探测到时会打印警告**，提醒你很可能写错了地方，而不是静默写错。

写入行为：

- 读取现有文件，**只替换 `opencode-free` / `opencode-free-responses` 这两个 providerId**，
  你已有的其它 Provider（GPT / Grok / DeepSeek / OpenCode Zen …）原样保留，`providerOrder` 也保留。
- 写入前在同目录留一份 `provider_config.json.bak-<时间戳>`。
- 原子写（同目录临时文件 + rename）。
- 目录内容真实变化时才重写；每 5 分钟的刷新若没变化不会白写。

---

## 免费通道怎么过

移植自原项目 `lib/zen.js` 的部分：

1. **CLI 一致的伪装头** — `user-agent: opencode/1.18.31 (…)`、`x-opencode-client: cli`，
   以及会话/请求/项目三族关联头。session id 按**对话首条用户消息**派生，
   形状规范化为 `ses_ + 12hex + 14base62`，同一对话恒定。
2. **体门禁** — 原项目实测：不流式、或缺名为 `bash` 和 `read` 的函数工具的请求直接 403。
   所以强制 `stream: true`；缺哪个补哪个（描述和参数上游不检查）；
   原本一个工具都没有时补 `tool_choice: "none"`，免得模型真去调这两个占位桩。
3. **SSE 逐块透传** — 两端同一套方言，不重编码，流式零损耗。
4. **目录** — S1（Zen `/v1/models`，带伪装头）∩ S2（models.dev 里判为免费且未下架），
   5 分钟刷新；磁盘缓存 7 天，离线启动先读盘播种，不退化成缩水的静态兜底。

### 「免费」怎么判定（与 OpenCode 桌面版逐位对齐）

桌面版的判定就一行（`packages/app/src/components/dialog-select-model.tsx`）：

```ts
const isFree = (provider, cost) => provider === "opencode" && (!cost || cost.input === 0)
```

本工具照搬，并**额外排除 `status == "deprecated"`**。三点容易踩：

1. **只看 `input`，不看 `output`**；并且「没有 cost 数据」也算免费。
2. **必须排除已下架**。Zen 把下架模型留在公开 `/models` 和目录里，标价仍是 0。
   不排除的话，模型选择器里会出现点下去必报错的选项。
3. 因此「目录标称免费」当前有 34 个，**过滤后剩 8 个，与桌面版完全相同**：

```
big-pickle            ling-3.0-flash-fin-free   longcat-2.5-preview-free
mimo-v2.6-flash-free  muse-spark-1.3-contributor-free
nemotron-3-ultra-free nemotron-3.5-lightning-free  space-bunny-free
```

> 早先版本要求 `input` 和 `output` **都**为 0、且不排除下架，于是多放进来了
> `mimo-v2.5-free` 和 `muse-spark-1.2-contributor-free`（两个都已下架）。
> `selftest.mjs` 里有针对这一条的回归测试。

### 评分能不能显示在 ZCode 里

**数据拿得到，但显示不了——卡在 ZCode 那边，不是卡在本工具。**

- **拿得到**：评分要用的六项（上下文窗口、最大输出、推理档位、工具调用、多模态、
  结构化输出）全都来自 models.dev，而本工具**本来就在拉 models.dev**。想算的话
  在这里加十行就够了，不需要额外数据源。
- **写不进**：ZCode 的模型配置 schema 是 `.strict()` 白名单，只认这些叶子——
  `contextWindow`、`inputFormat`（`supportsImage` / `supportsVideo` / `supportsPdf`）、
  `outputFormat`、`supportsToolCall`、`supportsJsonSchemaOutput`、
  `supportsNativeWebSearch`、`supportsMidConversationSystem`，
  以及 `optionSpecs` 下的 `reasoningLevel` 和 `maxOutputTokens`。
  **没有 `description`、没有评分、没有显示名/别名**，多写的键会被直接丢弃。
  模型 ID 也不能拿来改名——它要原样发给上游 API。

所以本工具不硬塞评分。界面上真实可见的是：**上下文窗口、最大输出、思考档位阶梯**
（这三项能间接反映模型的思考深度），外加模型 ID 本身携带的名字信息。
需要横向对比评分，用同作者的 `provider-fetcher` 查那张表。

> 万一将来 ZCode 加了这个字段，这里补上就是改 `buildModelRule` 一个函数的事。

### 与上游项目的两处**有意偏离**

原项目写于 2026-09，实测下来今天有两处已经不成立，这里是改过的：

**① `reasoning_effort` 不再「一律归一成 none」。**
原项目的策略是 off / 缺失 / 不认识的一律写成 `"none"`，注释说这是关掉 always-think 的唯一写法。
**现在这样会直接把请求打成 400。** 逐模型实测（2026-10）：

| 模型 | `off` | `none` | `minimal`…`max` | 省略该字段 |
| --- | --- | --- | --- | --- |
| `big-pickle` | 400 | 400 | 200 | 200 |
| `space-bunny-free` | 400 | 400 | 200 | 200 |
| `nemotron-3.5-lightning-free` | 400 | **200** | 200 | 200 |
| `mimo-v2.5-free` | 500 | 200 | 时好时坏 | 200 |

档位**逐模型不一致**，所以改成：只透传上游确实认的主动档位（`minimal`→`max`）；
`off` / `none` / 缺失 / 未知一律**省略该字段**，退回厂商默认；UI 档位阶梯也不再提供
`off`（提供一个上游必然拒绝的档位是骗人的）。另外 `handleUpstream` 里加了一次兜底：
只在「确实带了 `reasoning_effort`」且上游回 400/422/500 时，摘掉该字段重试一次。

**② 模型目录用 smart 车道而不是 manual。**
ZCode 个人配置有两条模型元数据车道：`providerModelRules`（smart，接受部分稀疏配置）
和 `manualProviderModelRules`（manual，要求把 `contextWindow` / `inputFormat` /
`optionSpecs` 等叶子填满，且**同一 Provider+Model 不能两条道并存**）。
本工具走 smart —— 这也是 ZCode 内置模板和你本机已有自定义 Provider 实际在用的那条。

---

## 实测结果（2026-10-01，本机）

已验证可用：

```
GET  /healthz                              -> 200，目录 source=live，84 个模型，暴露 9 个
GET  /v1/models                            -> 7 个 chat 模型
POST /v1/chat/completions  big-pickle      -> 200，SSE 流式正常返回
     同上，带 reasoning_effort:"none"       -> 200（档位被摘掉，不再 400）
     同上，带 reasoning_effort:"high"       -> 200（原样透传）
POST /v1/responses  muse-spark-1.3-...     -> 上游 RegionError（见下）
POST 不存在的模型                            -> 上游 ModelError + 401，原样透传
非回环 Host 访问 /healthz                    -> 403 loopback requests only
node selftest.mjs                          -> 16/16 通过（本地 mock，不打真实网络）
```

配置里实际是 **8 个模型**：`opencode-free` 7 个（chat 道）+ `opencode-free-responses`
1 个（`muse-spark-1.3-contributor-free`，responses 道）。`/healthz` 里的
`exposed: 9` 比这个多 1，是因为统计的是分道**之前**的清单——多出来那个是
`jev-*` 系列的模型，它两条道都不走（只答 `/systemone`），本来就不该进配置。

**两条限制，都不是本工具的 bug：**

1. **Muse Spark 系列有地区限制。** `muse-spark-1.3-contributor-free` 从本机请求返回
   `RegionError: This model is not available in your country.`
   所以 `opencode-free-responses` 这一组在本机点了会报错。不需要就把它从配置里删掉。
2. **匿名通道按 IP 限速。** 429 会原样呈现。这是 OpenCode 提供的免费入口，
   且上游会检查「是不是从 OpenCode 里发出来的」——本工具靠伪装头 + 体门禁通过该检查，
   属于客户端伪装，**上游随时可能收紧导致失效**，原项目自己也写明「不保证可用性」。

> 另有一个已修的历史问题：`deepseek-v4-flash-free` 曾经出现在清单里，但它在
> 目录里标着 `status: deprecated`，上游返回 400 `Model is unavailable`。
> 现在的规则会把它剔掉。

---

## 排错

| 现象 | 处理 |
| --- | --- |
| 设置里看不到「OpenCode 免费模型」 | **先查配置写对地方没有**：跑 `node zen-proxy.mjs --detect` 看它打算写到哪。正常路径下窗口里会打印 `[zen] 配置目标（…）：<路径>` 和 `[zen] 已同步 ZCode 配置：<路径>`，路径不对就用 `--config <完整路径>` 指定。ZCode 每 1 秒轮询配置文件，写完稍等即可，**不用重启** |
| 同上，但路径是对的 | 确认代理在跑：`curl http://127.0.0.1:41930/healthz`。没响应就是钩子没拉起来，先手动 `node zen-proxy.mjs` 看报错 |
| 模型列表比预期少 | 看 `/healthz` 的 `catalog.status`：`static` 表示还没联网成功，用的是内置兜底清单；`lastError` 会写原因。目录里判定为「已下架」的模型会被有意剔掉 |
| 对话报 403 `FreeTierError` | 伪装头或体门禁没过，上游收紧了。`x-opencode-client` / `user-agent` 的版本号可能要跟着官方 CLI 更新 |
| 对话报 429 | 匿名通道按 IP 限速，等一会儿 |
| 对话报 400 `invalid request` | 看代理 stderr 有没有「摘掉该字段重试」的日志；若重试也 400，多半是这个模型当前不可用 |
| 想撤销 | 双击 `uninstall.cmd`（钩子和 Provider 一起清干净）。只想清 Provider 就 `node zen-proxy.mjs --remove-provider`；只想停自启就 `node install.mjs --uninstall` |

代理的日志都走 **stderr**，`--print-config` 的 JSON 走 **stdout**，方便重定向。

---

## 隐私与凭据

- `--print-config` 会把**所有** provider 的 `apiKey` 替换成 `***已隐藏***` 再打印，
  不会把你已有的 GPT / Grok / DeepSeek 密钥打到终端上。
- 本工具自身不落任何密钥：匿名通道的 Bearer 是写死的 `public`，不是密钥。
- 写配置前一定留备份；只替换自己那两个 providerId，不动你的其它 Provider。
- 出站网络只有两处：`opencode.ai`（对话与目录）和 `models.dev`（模型元数据）。
  无遥测、无第三方服务器。

---

## 文件

```
zen-proxy.mjs          回环代理 + ZCode 配置同步（唯一必需文件，无外部依赖）
ensure-proxy.mjs       SessionStart 钩子：检查代理在不在，不在就静默拉起（无窗口）
install.mjs            装/卸自启钩子（读写 ZCode 的 CLI 配置）
install-autostart.cmd  双击这个 = 装上「随 ZCode 自动启动」
uninstall.cmd          双击这个 = 彻底还原（钩子 + Provider 一起清）
start-zen-proxy.cmd    手动前台启动（调试用，窗口要开着）
selftest.mjs           自测：本地 mock 上游，16 项，不打真实网络
README.md              本文件，给人看的说明
AI-SETUP.md            给 AI 助手看的安装说明（拿到包的是 AI 时先读那份）
zcode-data-dir.txt     运行后自动生成，记录探测到的数据根；不要拷到别的电脑
```

## 拿到别人的电脑上用

整个目录可以直接拷走，**不含任何机器专属路径**——数据目录靠自动探测。

### 分享给人类用户

把整个文件夹（或 zip）发过去，对方**双击 `install-autostart.cmd`** 就完事。
装完不用再管，也没有黑窗口。

### 分享给「让对方的 AI 来装」

让那个 AI **先读 `AI-SETUP.md`**，里面有逐步命令、每步的期望输出、以及各种失败分支。
`AI-SETUP.md` 第 6 节就是安装自启那一步。

### ⚠️ 唯一需要对方动手的事

ZCode 的钩子必须写**绝对路径**，所以 `install.mjs` 会把**当时那个位置的**
`ensure-proxy.mjs` 路径记进 ZCode 的配置。这就带来一条规则：

> **`install-autostart.cmd` 必须在「最终摆放位置」上运行。**
> 对方把文件夹解压到哪、就在哪运行——不要先在 A 处运行、再把文件夹挪到 B 处。

如果确实挪过了，**到新位置重跑一次 `install-autostart.cmd` 就行**：它会认出自己的
旧钩子并替换掉，指向已不存在的旧路径那条会被自动清掉，不会越堆越多。

（为什么非得是绝对路径：ZCode 的钩子变量 `${ZCODE_PROJECT_DIR}` 是**工作区**相对
路径，指向的是你打开的项目文件夹，不是本工具的安装位置，用不上。）

## 自启是怎么做到的（以及它的边界）

`install.mjs` 往 ZCode 的 CLI 配置（`{用户目录}/.zcode/cli/config.json`）里加一条：

```json
{ "hooks": { "enabled": true, "events": { "SessionStart": [
  { "hooks": [ { "type": "process",
                 "command": "<node 的绝对路径>",
                 "args": ["<本目录>/ensure-proxy.mjs"],
                 "timeoutMs": 12000 } ] } ] } } }
```

几点说明：

- **`process` 类型而不是 `command`**，直接给可执行文件 + 参数数组，不过 shell，Windows 上最稳。
- **node 用绝对路径写死**，免得目标机 PATH 里没有 node 时钩子静默失效。
- 钩子是**同步执行**的，`async` 字段不生效。所以 `ensure-proxy.mjs` 自己负责快速判断：
  代理在就直接退出（毫秒级），不在才拉起来并最多等 6 秒，**无论成败退出码恒为 0**，
  绝不影响 ZCode 开会话。
- 子进程用 `detached` + `windowsHide` 拉起，**完全脱离且不弹窗**——这就是「看不见黑窗口」的来源。
- 有**单实例保护**（排他锁文件 + 端口健康检查）。否则同时开两个 ZCode 会话时，
  第二个实例会绑到 41931 并把配置里的 `baseUrl` 改掉，用户会突然发现模型不能用。

**边界**：装的时候必须**手动跑一次** `install-autostart.cmd`（或让 AI 做），
因为往 ZCode 配置里写东西这件事本身没法自动完成。装完之后就再也不用管了。
不想留钩子的话 `uninstall.cmd` 能干净还原——它只认自己写的那条，别的钩子不碰。

## 致谢

- [opencode2pi-desktop](https://github.com/JasonYu0822/opencode2pi-desktop)（MIT）—
  本工具的移植来源，伪装头 / 体门禁 / 目录 S1∩S2 / SSE 透传都出自它的 `lib/zen.js`
- [opencode2dsh](https://github.com/FishBottle7/opencode2dsh)（MIT，© FishBottle7）
- [opencode2api](https://github.com/jasonxu114514/opencode2api)
- [OpenCode](https://opencode.ai) — 匿名 Zen 免费通道的提供方
