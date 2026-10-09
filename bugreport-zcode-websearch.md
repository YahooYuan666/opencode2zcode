# Bug 报告:WebSearch(原生联网搜索)对 OpenAI 兼容管道完全不可用

- **产品**:ZCode 桌面版 3.14.4.7912(Windows 10 x64)
- **报告日期**:2026-10-05
- **严重程度**:中(功能不可用 + 报错文案误导,但无数据风险)
- **复现率**:100%

---

## 一、现象

在对话中让模型执行联网搜索(「搜索 查找 …」),WebSearch 工具直接报错:

```
Current model does not support native WebSearch
```

受影响范围:**所有走 OpenAI 兼容管道的模型**,包括:

- 用户自建的个人 Provider(API 类型 `openai-chat-completions` / `openai-responses`)
- 内置模板里的 OpenAI 兼容模型

Anthropic 管道的模型是否受影响未验证(推断可用,见第四节源码分析)。

## 二、复现步骤

1. 设置 → 模型服务,添加或使用一个 API 类型为「OpenAI Compatible」的个人 Provider
2. 对话中选择该 Provider 下的任意模型
3. 输入需要联网搜索的任务(例如「搜索 xxx 的最新消息」),触发 WebSearch 工具
4. 工具报错 `Current model does not support native WebSearch`,任务中断

即使在该模型的能力配置里手动打开「原生联网搜索」(supportsNativeWebSearch)开关,
错误消失,但请求会转而在另一处失败(见下文「第二道门」),仍然不可用。

## 三、期望与实际

- **期望**:WebSearch 工具在 OpenAI 兼容模型上可用;或至少给出明确、可行动的提示。
- **实际**:第一层直接按能力位拒绝;绕过能力位后,第二层按「API 类型不支持编码」拒绝。

## 四、根因(源码证据)

共两道门,逐层拦截:

### 第一道门:WebSearch 工具入口按能力位拒绝

WebSearch 工具的 handler(`resources/glm/zcode.cjs`)在执行前检查模型能力位:

```js
if (!o.properties.supportsNativeWebSearch)
  throw Gr(fr.ConfigurationError, "Current model does not support native WebSearch", ...)
```

自定义 Provider 的模型配置里没有这个字段(默认缺省为假),于是必然命中。

### 第二道门:请求编码层只实现了 Anthropic 管道

即使能力位为真,把内部工具契约(`executionMode: "providerNative"`,logicalName 为
`WebSearch`)翻译成线上格式时,只有 Anthropic 分支有实现:

```js
function fFs(e, t) {
  ...
  switch (t.providerKind) {
    case "anthropic":
      if (!t.supportsNativeWebSearch) throw "Effective Model Config does not support provider-native WebSearch"
      return x8r.tools.webSearch_20260209({...})    // Anthropic 服务端 web_search 工具
    default:
      throw new w1(Cs.InvalidModelRequest,
        `Provider API kind ${t.providerKind ?? "unknown"} does not encode provider-native WebSearch`)
  }
}
```

OpenAI 兼容管道(openai-chat-completions / openai-responses)落入 `default`,请求期报
`Provider API kind ... does not encode provider-native WebSearch`。

### 旁证:该能力位在产品内从未开启

在整个服务端 bundle(`zcode.cjs`)中检索 `supportsNativeWebSearch: true`,**出现 0 次**
——包括 ZCode 自家的全部内置模型模板。即当前版本中没有任何一个内置模型实际启用过
原生联网搜索。

### 结论

「原生联网搜索」当前是一个**仅对 Anthropic API 管道实现、且无任何内置模型启用**的
休眠功能。对 OpenAI 兼容模型,它处于「入口拒绝 → 绕过后请求期拒绝」的双重不可用状态,
而设置界面里「原生联网搜索」开关(设置 → 模型服务 → 模型能力)对所有 API 类型都
可勾选,与实际能力不符。

## 五、建议(按优先级)

1. **提供客户端执行的搜索兜底**:WebSearch 由 ZCode 自行调用搜索后端、把结果作为
   工具结果注入上下文,不依赖模型管道的服务端搜索能力。这样所有模型(含 OpenAI
   兼容自定义 Provider)都能用上联网搜索,也是同类工具的普遍做法。
2. 若短期不做兜底:**在 UI 上按 API 类型置灰「原生联网搜索」开关**,并在报错文案中
   说明「当前 API 类型不支持原生联网搜索,请改用 WebFetch 或切换 Anthropic 管道」,
   避免用户在设置里反复尝试。
3. 长期:为 OpenAI Responses 管道补上服务端 web_search 工具的编码(OpenAI 该 API
   已有对应能力)。

## 六、附注

- 报错上下文中的模型当时通过一个本地回环代理访问上游,但该因素与本 bug 无关:
  错误在请求发出前即由客户端抛出,换任何 OpenAI 兼容 Provider 均可复现。
- WebFetch(读取指定 URL)不受此影响,工作正常。
