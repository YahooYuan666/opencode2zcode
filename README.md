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

**下载 `opencode2zcode.exe` 这一个文件就够了**——2.0 MB，自包含，**对方不需要装
任何东西**（不用 Node.js、不用配环境变量、不用改 PATH）。

装一次，之后再也不用管：

```
opencode2zcode.exe --install
```

它往 ZCode 的 CLI 配置里写一条 `SessionStart` 钩子，之后**每次启动 ZCode 都会
自动把代理拉起来**——**没有黑窗口，不用双击，不用记着开**。装完直接去
ZCode 的 **设置 → 模型服务** 看「OpenCode 免费模型」分组。

想彻底还原：

```
opencode2zcode.exe --uninstall
```

会删掉那条钩子、并把本工具的两个 Provider 从你的个人配置里摘掉，你的其它
Provider 和其它钩子一个字都不动。

<details>
<summary>源码包（想自己改代码 / 想看实现）</summary>

`rust/` 是 Rust 源码，`cargo build --release` 产出同一个 exe。
仓库里还留着等价的 Node 实现 `zen-proxy.mjs`（需要 Node 18+），它既是
Rust 版的对照物，也是重写时的行为基准。两者由对拍测试保证输出一致。

</details>

<details>
<summary>不想装自启，手动跑（调试用）</summary>

```bash
node zen-proxy.mjs        # 起代理 + 写配置，窗口要一直开着
opencode2zcode.exe        # 同上，exe 形态
```

窗口关掉代理就停。适合排查问题，不适合日常用。

</details>

### 命令

```

```bash
--install            装上「随 ZCode 自动启动」（幂等，推荐）
--uninstall          卸掉钩子 + 摘掉本工具的两个 Provider
--ensure             检查代理在不在，不在就静默拉起（供钩子调用，一般不用手敲）
--detect             只列出候选数据目录与判据
--print-config       只打印将要写入的配置（所有 apiKey 已脱敏），不落盘不起服务
--write-config-only  只写配置后退出
--remove-provider    只从 ZCode 配置里摘掉本工具的两个 Provider
--port <n>           指定回环端口，默认 41930
--config <path>      直接指定 provider_config.json 完整路径
--help               帮助
```

跑自测（本地 mock 上游，不打真实网络，22 项）：

```bash
node selftest.mjs
```

### 环境变量

| 变量 | 说明 |
| --- | --- |
| `ZEN_BASE_URL` | 覆盖上游根地址，默认 `https://opencode.ai/zen`。指向本地 mock 便于自测 |
| `ZCODE_DATA_BASE_DIR` | 个人 Provider 配置落点的**最高优先级**依据；没有它就自动探测，**不是**直接退到用户主目录 |

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
   5 分钟刷新；磁盘缓存 7 天。**没有编译期写死的模型名单**——网络断了或
   目录失效时，用「最近一次成功解析的结果」（磁盘缓存 + 内存快照）顶上；
   连一次都没成功过就如实返回空，绝不编一份会过期的假名单。

### 「免费」怎么判定（与 OpenCode 桌面版逐位对齐）

桌面版的判定就一行（`packages/app/src/components/dialog-select-model.tsx`）：

```ts
const isFree = (provider, cost) => provider === "opencode" && (!cost || cost.input === 0)
```

本工具照搬，并**额外排除 `status == "deprecated"`**。三点容易踩：

1. **只看 `input`，不看 `output`**；并且「没有 cost 数据」也算免费。
2. **必须排除已下架**。Zen 把下架模型留在公开 `/models` 和目录里，标价仍是 0。
   不排除的话，模型选择器里会出现点下去必报错的选项。
3. 因此「目录标称免费」里**过滤后剩下的与桌面版完全相同**，数量随上游增减
   自动跟随，不在这里列死名单。某个时刻的样子可以用
   `curl http://127.0.0.1:41930/v1/models` 看。

> 早先版本要求 `input` 和 `output` **都**为 0、且不排除下架，于是多放进来了
> `mimo-v2.5-free` 和 `muse-spark-1.2-contributor-free`（两个都已下架）。
> `selftest.mjs` 里有针对这一条的回归测试。

### 两条线格式，共用同一道门禁

一个模型走哪条线，看官方目录里它自己声明的 SDK：`@ai-sdk/openai` 的挂
`/v1/responses`，`openai-compatible` 的走 `/v1/chat/completions`，不再按模型名
前缀猜。**两条都要过同一道免费档门禁**——请求体里必须有
`bash` 和 `read` 两个工具定义，缺了就是：

```
403  OpenCode's free tier can only be used from within OpenCode
```

这个门禁是**纯请求体判定**，跟账号、key、地区都无关：没登录的 OpenCode 桌面版
同样能调通，本工具也能。踩过的两个坑：

| 坑 | 后果 |
| --- | --- |
| responses 道补工具时套了 chat 道的嵌套格式 `{type,function:{name}}` | 上游 400 `tools[0] missing required field name` |
| 照搬了 chat 道的 `tool_choice: "none"` | 上游 400，**Responses API 只接受 `auto` / `required` / 具体工具名** |

第二个坑特别隐蔽：当时据此下了「responses 道过不去、没有救」的结论。真相是
**门禁规则和 chat 道完全一样**，只是线格式有别——工具定义要扁平，`tool_choice`
一个都不能带。

> 定位方法值得记一下：光靠猜是猜不出来的。把 `XDG_CONFIG_HOME` 指向临时目录、
> 在配置里把 opencode provider 的 `baseURL` 改到本地，就能让真的 OpenCode CLI
> 把它的原始请求发过来（`rust/tests/capture-opencode-request.mjs`），
> 再拿抓到的请求对着上游逐项减字段回放（`replay-gate-probe.mjs`），
> 二分出到底是哪个字段在起作用。用户一句「我桌面版没登录也能用」直接推翻结论。

### 为什么清单可能和桌面版不完全一致（不是 bug）

活例：`fledge-alpha-free` —— **OpenCode 桌面版已经不再列它，但它在本工具里照常可用**
(实测 2026-10-02 返回正常回复)。

原因是两边**数据源不同**：

| | 数据源 |
| --- | --- |
| OpenCode 桌面版 | OpenCode 服务端按账号下发的清单（需要登录令牌，我们拿不到） |
| 本工具 | Zen 实时 `/v1/models` ∩ models.dev（第三方目录） |

桌面版撤下某个模型的动作发生在它的服务端清单上，**models.dev 不一定同步**。于是会出现
两种分歧，都属正常：

- 桌面版没有、我们有（fledge 就是这样——两个数据源此刻都还挂着它，且实测能用）
- 桌面版有、我们没有（上游上架但 models.dev 还没收录的新模型，要等目录更新）

判定规则本身仍与桌面版的 `isFree` 逐位一致(见上)，差异只来自"清单来源"而非"判定口径"。
一个佐证：`fledge-alpha-free` 在 models.dev 里 `cost=0`、`status` 未标废弃，Zen 实时清单
也仍有它——两个我们能拿到的权威源都说它该在。

**取舍：能用就留着。** 多一个能用的免费模型，代价只是它不在桌面版的名单里。

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
GET  /v1/models                            -> chat 道全部模型（随上游增减）
POST /v1/chat/completions  big-pickle      -> 200，SSE 流式正常返回，模型回了 "OK"
     同上，带 reasoning_effort:"none"       -> 200（档位被摘掉，不再 400）
     同上，带 reasoning_effort:"high"       -> 200（原样透传）
POST /v1/responses  muse-spark-1.3-...     -> 200，SSE 正常，模型回了 "OK"
POST 不存在的模型                            -> 上游 ModelError + 401，原样透传
非回环 Host 访问 /healthz                    -> 403 loopback requests only

POST /v1/responses  带 tool_choice:"none"   -> 代理摘掉后 200（带上去上游会 400）

cargo test                        25/25
node rust/tests/cli-parity.mjs    18/18   Node 版 vs Rust 版，配置逐字节一致
node rust/tests/live-mock.mjs     21/21   端到端打本地 mock
node selftest.mjs                 23/23   Node 版回归
node rust/tests/fresh-machine-dryrun.mjs  29/29  新机器演练
```

配置里的模型数**随上游自动增减**，不做上限：`opencode-free`（chat 道）+
`opencode-free-responses`（responses 道，目前只有 muse-spark）。判定规则与
OpenCode 桌面版逐位一致，桌面版列多少这里就写多少。`/healthz` 里的 `exposed`
比分道统计略多——`jev-*` 系列两条道都不走（只答 `/systemone`），本来就不该进配置。

**已知限制，都不是本工具的 bug：**

1. **匿名通道按 IP 限速。** 429 会原样呈现，等一会儿就好。
2. **本质是客户端伪装，上游随时可能收紧。** 免费通道只允许在 OpenCode 内部使用，
   本工具靠伪装请求头 + 体门禁混过去。**没盗用任何账号或密钥，但确实是在冒充身份**
   过一道对方明确设了限制的关卡。原项目自己也写明「不保证可用性」。
3. **`responses` 道调不通**（见上一节），所以默认不暴露 muse-spark。

---

## 排错

| 现象 | 处理 |
| --- | --- |
| 设置里看不到「OpenCode 免费模型」 | **先查配置写对地方没有**：跑 `node zen-proxy.mjs --detect` 看它打算写到哪。正常路径下窗口里会打印 `[zen] 配置目标（…）：<路径>` 和 `[zen] 已同步 ZCode 配置：<路径>`，路径不对就用 `--config <完整路径>` 指定。ZCode 每 1 秒轮询配置文件，写完稍等即可，**不用重启** |
| 同上，但路径是对的 | 确认代理在跑：`curl http://127.0.0.1:41930/healthz`。没响应就是钩子没拉起来，先手动 `node zen-proxy.mjs` 看报错 |
| 模型列表比预期少 | 看 `/healthz` 的 `catalog.status` 与 `lastError`。网络中断时用最近一次成功解析的结果顶上（来源是磁盘缓存，7 天有效）；缓存也没有就如实空着，等网络恢复自动补齐。目录里判定为「已下架」的模型会被有意剔掉 |
| 对话报 403 `FreeTierError` | 伪装头或体门禁没过，上游收紧了。`x-opencode-client` / `user-agent` 的版本号可能要跟着官方 CLI 更新 |
| 对话报 429 | 匿名通道按 IP 限速，等一会儿 |
| 模型数和文档里写的不一样 | 正常——清单随上游自动增减，以 `curl http://127.0.0.1:41930/v1/models` 实时结果为准 |
| WebSearch 报 "does not support native WebSearch" | ZCode 的「原生联网搜索」只在 Anthropic API 管道上有实现（映射到 Anthropic 服务端的 web_search 工具），OpenAI 兼容管道——包括本工具——没有编码，声明了能力位也会在请求时被拒。这是 ZCode 的功能边界，本工具无法绕过。**读具体网址用 WebFetch**（走的是另一条路，本工具已适配） |
| 对话报 400 `invalid request` | 看代理 stderr 有没有「摘掉该字段重试」的日志；若重试也 400，多半是这个模型当前不可用 |
| 想撤销 | 双击 `uninstall.cmd`（钩子和 Provider 一起清干净）。只想清 Provider 就 `node zen-proxy.mjs --remove-provider`；只想停自启就 `node zen-proxy.mjs --uninstall` |

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
bin/opencode2zcode.exe  唯一要分发的文件（2.0 MB，自包含，对方零依赖）
README.md               本文件，给人看的说明
AI-SETUP.md             给 AI 助手看的安装说明（拿到包的是 AI 时先读那份）

rust/                   Rust 源码（cargo build --release 产出上面那个 exe）
  src/zen.rs              伪装头、会话 id、免费通道门禁、思考档位归一
  src/catalog.rs          模型目录与「免费」判定
  src/zcode.rs            ZCode 个人 Provider 配置的合并/写入/摘除
  src/detect.rs           ZCode 数据目录探测
  src/autostart.rs        自启钩子的装/卸 + 静默拉起
  src/proxy.rs            回环服务与 SSE 透传
  tests/cli-parity.mjs    Node 版 vs Rust 版对拍
  tests/live-mock.mjs     端到端（本地 mock 上游）

zen-proxy.mjs           等价的 Node 实现，留作行为基准与对照（需 Node 18+）
selftest.mjs            Node 版自测，22 项

zcode-data-dir.txt      运行后自动生成，记录探测到的数据根；不要拷到别的电脑
```

## 拿到别人的电脑上用

**只需要 `opencode2zcode.exe` 一个文件（2.0 MB）。** 微信、邮件、U 盘随手发都行。

对方把它放哪都行，然后跑一条命令：

```
opencode2zcode.exe --install
```

完事。**不用装 Node.js、不用装任何运行时、不用配环境变量。**

包里不含任何机器专属路径——ZCode 的数据目录靠自动探测（扫各固定盘的
`{数据根}/.zcode/v2/runtime` 指纹），所以跨机器直接可用。

### 让对方的 AI 来装

让那个 AI **先读 `AI-SETUP.md`**，里面有逐步命令、每步的期望输出、以及各种失败分支。
第 6 节就是安装自启那一步。

### ⚠️ 唯一需要对方动手的事

ZCode 的钩子必须写**绝对路径**，所以安装命令会把**当时那个位置**的可执行文件路径
记进 ZCode 的配置。这就带来一条规则：

> **必须在「最终摆放位置」上执行安装。**
> 对方把文件解压到哪、就在哪运行——不要先在 A 处运行、再挪到 B 处。

如果确实挪过了，**到新位置重跑一次安装命令就行**：它会认出自己的旧钩子并替换掉，
指向已不存在的旧路径那条会被自动清掉，不会越堆越多。

（为什么非得是绝对路径：ZCode 的钩子变量 `${ZCODE_PROJECT_DIR}` 是**工作区**相对
路径，指向的是用户打开的项目文件夹，不是本工具的安装位置，用不上。）

## 自启是怎么做到的（以及它的边界）

`--install` 往 ZCode 的 CLI 配置（`{用户目录}/.zcode/cli/config.json`）里加一条：

```json
{ "hooks": { "enabled": true, "events": { "SessionStart": [
  { "hooks": [ { "type": "process",
                 "command": "<本程序的绝对路径>",
                 "args": ["--ensure"],
                 "timeoutMs": 12000 } ] } ] } } }
```

源码形态下 `command` 是 node 的绝对路径、`args` 是 `[zen-proxy.mjs 的路径, "--ensure"]`；
exe 形态下 `command` 直接是那个 exe。

几点说明：

- **`process` 类型而不是 `command`**，直接给可执行文件 + 参数数组，不过 shell，Windows 上最稳。
- **路径用绝对路径写死**，免得目标机 PATH 里什么都没有时钩子静默失效；
  exe 形态还会把 8.3 短名还原成长路径，那种短名在目录被重建后会失效。
- 钩子是**同步执行**的，`async` 字段不生效。所以 `--ensure` 自己负责快速判断：
  代理在就直接退出（毫秒级），不在才拉起来并最多等 6 秒，**无论成败退出码恒为 0**，
  绝不影响 ZCode 开会话。
- 子进程用 `detached` + `windowsHide` 拉起，**完全脱离且不弹窗**——这就是「看不见黑窗口」的来源。
- 有**单实例保护**（排他锁文件 + 端口健康检查）。否则同时开两个 ZCode 会话时，
  第二个实例会绑到 41931 并把配置里的 `baseUrl` 改掉，用户会突然发现模型不能用。
- 认领自己的钩子靠**文件名**而不是完整路径，并且**把已经废弃的 `ensure-proxy.mjs`、
  `install.mjs` 也列进识别名单**——不然早几版装过的人，那些指向已删文件的死钩子
  会被当成「别人的钩子」永远留着，每次开 ZCode 都白跑一次。

**边界**：装的时候必须**手动执行一次**安装命令（或让 AI 做），因为往 ZCode 配置里
写东西这件事本身没法自动完成。装完之后就再也不用管了。`--uninstall` 能干净还原。

## 自己构建

```bash
cd rust
cargo build --release
# 产物：rust/target/release/opencode2zcode.exe
```

构建期只需要 Rust 工具链。**对方拿到 exe 完全用不到任何构建工具。**

## 测试

```bash
cd rust && cargo test              # 25 项单元测试
node rust/tests/cli-parity.mjs     # 16 项：Node 版 vs Rust 版对拍
node rust/tests/live-mock.mjs      # 21 项：端到端（本地 mock 上游）
node rust/tests/fresh-machine-dryrun.mjs  # 29 项：模拟另一台电脑，从 zip 装一遍
node rust/tests/capture-opencode-request.mjs  # 抓 OpenCode CLI 的真实请求
node rust/tests/replay-gate-probe.mjs         # 对着真实上游逐项回放，定位门禁
node selftest.mjs                  # 22 项：Node 版自测
```

**对拍测试是这个项目的安全网。** 重写最容易出的错是「一边改了另一边没改」——
比如 models.dev 的返回形状（供应商有时裹在 `providers` 下、有时直接摊在根上），
只认一种会让整个元数据判定静默失效，然后所有名字带 `free` 的模型都被放行，
下架的也混进来。对拍把两个实现放在同一组断言下跑，任何一边跑偏都会被抓到。

## 免责声明

- 本项目与 OpenCode、ZCode 官方**没有任何关系**，也不是官方插件。
- 它通过模拟 OpenCode CLI 的请求特征，使用 OpenCode Zen 的**匿名免费通道**。
  这条通道官方本意只开放给自家客户端使用——没有盗用任何账号或密钥
  （凭据是公开的占位符 `public`），但确实是在对方设了限制的地方走了侧门。
- 上游随时可能改规则让它失效（2026-09-16 就收紧过一次会话 id 校验）。
  用的时候请节制，不要拿它跑大批量任务把免费通道打爆。
- 本项目仅用于学习与个人使用，风险自负。如果你不接受这些，请直接注册
  OpenCode 账号或使用其它正规渠道。

## 配套技能与命令（可选）

`skills/opencode-probe/` 里带了配套的 ZCode 技能与命令：装到
`~/.zcode/skills/opencode-probe/SKILL.md` 和 `~/.zcode/commands/opencode-probe.md`
之后，在 ZCode 里输入 `/opencode-probe` 就能一键体检所有免费渠道，
输出 S/A/B/C 档位、上下文窗口与 OpenRouter 社区热度，辅助选模型。

## 致谢 🫡

这个项目站在好几层前人的肩膀上，每一层都实名感谢：

- [**JasonYu0822/opencode2pi-desktop**](https://github.com/JasonYu0822/opencode2pi-desktop)（MIT）—
  **本工具的直接移植来源** 🫡。伪装头、体门禁、目录 S1∩S2、SSE 透传都出自它的
  `lib/zen.js`，没有它就没有这个项目。本项目的 Responses 线修复也已回馈为它的
  Issue 与 PR。
- [**FishBottle7/opencode2dsh**](https://github.com/FishBottle7/opencode2dsh)（MIT，© FishBottle7）—
  上一层的来源：伪装头与规范会话 id 形状的出处，架构文档写得极好。
- [**eric8bit/pi-commandcode-desktop**](https://github.com/eric8bit/pi-commandcode-desktop)（MIT）—
  「回环端点 + 静态 provider 声明」这套架构模式的样板。
- [**jasonxu114514/opencode2api**](https://github.com/jasonxu114514/opencode2api)（GPL-3.0）—
  整个伪装思路的祖师爷。本项目没有复制它的代码，其开创的协议参数
  （头名称、会话 id 形状、门禁要求）是功能事实，已由本项目自己的抓包
  独立复验（见 `rust/tests/capture-opencode-request.mjs`）。
- [**OpenCode**](https://opencode.ai) — 匿名 Zen 免费通道的提供方，没有这份慷慨
  就什么都不会有。
