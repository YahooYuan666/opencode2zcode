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

```bash
# 1. 起代理（会自动写入/更新 ZCode 的个人 Provider 配置）
node zen-proxy.mjs

# 只想看会写成什么，不落盘：
node zen-proxy.mjs --print-config

# 只写配置不起服务：
node zen-proxy.mjs --write-config-only
```

Windows 下也可以双击 `start-zen-proxy.cmd`。

起来之后回 ZCode：**设置 → 模型服务**，应该能看到「OpenCode 免费模型」分组，
直接在模型选择器里选，不需要任何命令切换。

### 参数

| 参数 | 说明 |
| --- | --- |
| `--port <n>` | 回环端口，默认 `41930`（被占用时自动退到 41931/41932/41933） |
| `--config <path>` | 直接指定 `provider_config.json` 完整路径，跳过自动探测 |
| `--detect` | 只列出候选数据目录与判据，确认要写到哪儿 |
| `--print-config` | 只打印合并后的配置（**所有 apiKey 已脱敏**），不落盘不起服务 |
| `--write-config-only` | 只写配置后退出 |
| `--help` | 帮助 |

环境变量：

| 变量 | 说明 |
| --- | --- |
| `ZEN_BASE_URL` | 覆盖上游根地址，默认 `https://opencode.ai/zen`。指向自建网关或本地 mock 便于自测（本工具的档位兜底重试就是用本地 mock 验证的） |
| `ZCODE_DATA_BASE_DIR` | 决定个人 Provider 配置的落点；未设则用用户主目录 |

### 诊断

```bash
curl http://127.0.0.1:41930/healthz
curl http://127.0.0.1:41930/v1/models
```

`/healthz` 会回目录状态（`live` / `cache` / `static`）、暴露的模型数、请求数与错误数。

---

## 配置文件位置

与 ZCode 的 `getAppConfigDir()` 一致：

```
{ZCODE_DATA_BASE_DIR 或 用户主目录}/.zcode/v2/provider_config.json
```

**本机的实际路径是 `D:\Program\.zcode\v2\provider_config.json`。**

### 落点怎么定（这个包要在别人电脑上也能用）

配置路径按这个顺序决定，**不写死任何机器专属路径**：

```
--config  >  ZCODE_DATA_BASE_DIR 环境变量  >  自动探测  >  旁路文件  >  用户主目录兜底
```

> **⚠ 最容易踩的坑：`ZCODE_DATA_BASE_DIR` 不是持久环境变量。**
> 它注册表里没有（用户级、系统级都没有），只是 ZCode 启动自己子进程时注入的。
> 所以从资源管理器**双击 `.cmd` 拿不到它**，早先版本会退回到用户主目录
> （`C:\Users\Administrator\.zcode\v2\provider_config.json`）——而 ZCode 读的是另一个目录，
> 表现就是「代理明明在跑，设置里就是不出现模型分组」。

**现在改为自动探测**：给若干候选目录打分，判据是 `{数据根}/.zcode/v2/runtime`
是否存在（ZCode 准备运行资源时会建它），并会扫各固定盘的盘根与盘根下一层目录。
得分最高的那个就是答案，探测结果会记进 `zcode-data-dir.txt` 供 `.cmd` 双击时走快路径。

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
4. **目录** — S1（Zen `/v1/models`，带伪装头）∩ S2（models.dev 里 `cost 0/0` 且未废弃），
   5 分钟刷新；磁盘缓存 7 天，离线启动先读盘播种，不退化成缩水的静态兜底。

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
GET  /healthz                              -> 200，目录 source=live，84 个模型，暴露 11 个免费
GET  /v1/models                            -> 8 个 chat 模型
POST /v1/chat/completions  big-pickle      -> 200，SSE 流式正常返回
     同上，带 reasoning_effort:"none"       -> 200（档位被摘掉，不再 400）
     同上，带 reasoning_effort:"high"       -> 200（原样透传）
POST /v1/responses  muse-spark-1.3-...     -> 上游 RegionError（见下）
POST 不存在的模型                            -> 上游 ModelError + 401，原样透传
非回环 Host 访问 /healthz                    -> 403 loopback requests only
```

**三条限制，都不是本工具的 bug：**

1. **Muse Spark 系列有地区限制。** `muse-spark-1.2/1.3-contributor-free` 从本机请求返回
   `RegionError: This model is not available in your country.`
   所以 `opencode-free-responses` 这一组在本机点了会报错。不需要就把它从配置里删掉。
2. **`deepseek-v4-flash-free` 拿不到。** 它确实在 Zen 的实时清单里，但 models.dev 把它判成
   非免费（成本非 0），所以被 S1∩S2 过滤掉了——这与原项目行为一致。
   另外实测它对**所有** `reasoning_effort` 组合都返回 400，等于当前用不了。
   想强行加就手动写进 `personalModelIds`，但大概率报错。
3. **匿名通道按 IP 限速。** 429 会原样呈现。这是 OpenCode 提供的免费入口，
   且上游会检查「是不是从 OpenCode 里发出来的」——本工具靠伪装头 + 体门禁通过该检查，
   属于客户端伪装，**上游随时可能收紧导致失效**，原项目自己也写明「不保证可用性」。

---

## 排错

| 现象 | 处理 |
| --- | --- |
| 设置里看不到「OpenCode 免费模型」 | **先查配置写对地方没有**：ZCode 读的是 `{ZCODE_DATA_BASE_DIR}/.zcode/v2/provider_config.json`，而双击 `.cmd` 时这个变量通常不存在，程序会写到用户主目录去。看窗口里有没有打印「已写入 <路径>」，路径不对就用 `start-zen-proxy.cmd` 里的 `ZCODE_DATA_BASE_DIR` 那行修正，或加 `--config <完整路径>` |
| 同上，但路径是对的 | 确认代理在跑：`curl http://127.0.0.1:41930/healthz`。ZCode 每 1 秒轮询配置文件，写完稍等即可，不用重启 |
| 模型列表比预期少 | 看 `/healthz` 的 `catalog.status`：`static` 表示还没联网成功，用的是内置兜底清单；`lastError` 会写原因 |
| 对话报 403 `FreeTierError` | 伪装头或体门禁没过，上游收紧了。`x-opencode-client` / `user-agent` 的版本号可能要跟着官方 CLI 更新 |
| 对话报 429 | 匿名通道按 IP 限速，等一会儿 |
| 对话报 400 `invalid request` | 看代理 stderr 有没有「摘掉该字段重试」的日志；若重试也 400，多半是这个模型当前不可用 |
| 想撤销 | 把同目录的 `provider_config.json.bak-<时间戳>` 复制回去，或从配置里删掉那两个 providerId |

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
zen-proxy.mjs        回环代理 + ZCode 配置同步（唯一必需文件，无外部依赖）
start-zen-proxy.cmd  Windows 双击启动器
README.md            本文件，给人看的说明
AI-SETUP.md          给 AI 助手看的安装说明（拿到包的是 AI 时先读那份）
zcode-data-dir.txt   运行后自动生成，记录探测到的数据根；不要拷到别的电脑
```

## 拿到别人的电脑上用

整个目录可以直接拷走，**不含任何机器专属路径**——数据目录靠自动探测。
目标机上如果是 AI 在操作，让它读 **`AI-SETUP.md`**，里面有逐步命令、期望输出和排查分支。

## 致谢

- [opencode2pi-desktop](https://github.com/JasonYu0822/opencode2pi-desktop)（MIT）—
  本工具的移植来源，伪装头 / 体门禁 / 目录 S1∩S2 / SSE 透传都出自它的 `lib/zen.js`
- [opencode2dsh](https://github.com/FishBottle7/opencode2dsh)（MIT，© FishBottle7）
- [opencode2api](https://github.com/jasonxu114514/opencode2api)
- [OpenCode](https://opencode.ai) — 匿名 Zen 免费通道的提供方
