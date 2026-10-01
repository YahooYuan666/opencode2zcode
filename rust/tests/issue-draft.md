# 草稿：给 JasonYu0822/opencode2pi-desktop 的 issue

> 以下是要发到 https://github.com/JasonYu0822/opencode2pi-desktop/issues 的正文。
> 英文写的——那个仓库的代码注释和 README 都是英文，作者读英文没障碍。
> 想改中文版随时说。

---

## Title

`opencode-free-responses` returns 403 for every request — the anonymous-lane gate is never applied to the Responses wire

---

## Body

### What I'm seeing

Every request to the `opencode-free-responses` provider (e.g. `muse-spark-1.3-contributor-free`) fails:

```
plugin:com.opencode2pi:opencode-free-responses API error (403): {"type":"FreeTierError",
"message":"Error from provider (Console): OpenCode's free tier can only be used from within OpenCode"}
```

The chat provider (`opencode-free`) works fine, so this isn't a general breakage — it's specific to the Responses lane.

### Root cause

`main.js` line ~295 documents the assumption:

```js
 *   chat      -> buildUpstreamBody (stream, reasoning_effort, bash/read gate)
 *   responses -> stream forced on, everything else untouched (muse-spark is
 *                served natively by Zen's own /v1/responses endpoint)
```

The "served natively" reading is the problem. The anonymous-lane gate is **not** chat-specific — it applies to `/v1/responses` exactly as it does to `/v1/chat/completions`. Your own comment at `lib/zen.js:188` says the gate is about the *body* ("any chat body that does not stream AND carry function tools named `bash` AND `read`"), and that holds for both wires. Since `handleUpstream` only calls `zen.buildUpstreamBody()` on the chat branch, the Responses body goes out without `bash`/`read` and the anonymous lane rejects it 100% of the time.

### The gate is the same for both wires — but the shaping isn't

Worth spelling out, because applying `buildUpstreamBody` to the Responses branch as-is will *not* work. Two wire-format differences bite:

1. **Tool definitions must be flat.** Responses expects `{ type, name, description, parameters }`. The nested `{ type, function: { name, ... } }` shape from `freeLaneGateTool` is rejected with `400 tools[0] missing required field name`.
2. **No `tool_choice` at all.** `ensureFreeLaneShape` sets `tool_choice: 'none'` when the host sent no tools. The Responses endpoint accepts only `auto` / `required` / a specific tool name — `"none"` returns 400 (`only ... are supported`).

### Evidence

I probed this by capturing a real OpenCode CLI request and replaying it against the live endpoint with one field removed at a time:

| Change | Result |
| --- | --- |
| Original CLI request (12 real tools) | 200 |
| `tools` removed | **403 FreeTierError** |
| `instructions` removed | 200 |
| `store` / `include` / `prompt_cache_key` removed | 200 |
| Tracing headers (`b3`, `traceparent`) removed | 200 |
| `user-agent` swapped for the plugin's own | 200 |
| Only `bash` + `read` stubs (flat shape) | **200** |
| Only one stub (`bash`) | 403 |
| Nested `function{name}` tool shape | 400 |

So the minimal working body is: `bash` + `read`, flat shape, no `tool_choice`.

### Suggested fix

Roughly a dozen lines. Shape the two wires from one shared rule:

```js
// lib/zen.js
const GATE_DESCRIPTION = 'Reserved for the host runtime; do not call it.';

function freeLaneGateToolChat(name) {
  return {
    type: 'function',
    function: { name, description: GATE_DESCRIPTION, parameters: { type: 'object', properties: {} } },
  };
}

// Responses wire: `name` sits directly on the tool, not under `function`.
function freeLaneGateToolResponses(name) {
  return { type: 'function', name, description: GATE_DESCRIPTION, parameters: { type: 'object', properties: {} } };
}

function ensureFreeLaneShape(body, lane) {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const nameOf = (t) =>
    lane === 'responses'
      ? t?.name ?? t?.function?.name
      : t?.function?.name ?? t?.name;
  const names = new Set(tools.map(nameOf));
  const missing = FREE_LANE_GATE_TOOL_NAMES.filter((n) => !names.has(n));

  const next = { ...body };
  if (missing.length > 0) {
    const build = lane === 'responses' ? freeLaneGateToolResponses : freeLaneGateToolChat;
    next.tools = [...tools, ...missing.map(build)];
    if (tools.length === 0 && lane === 'chat') next.tool_choice = 'none';
  }
  // Responses rejects "none" outright; drop it if the host sent one.
  if (lane === 'responses' && next.tool_choice === 'none') delete next.tool_choice;
  return next;
}

function buildUpstreamBody(hostBody, lane) {
  const source = hostBody && typeof hostBody === 'object' ? hostBody : {};
  const body = { ...source, stream: true };
  if (lane === 'chat') body.reasoning_effort = upstreamEffort(source.reasoning_effort);
  return ensureFreeLaneShape(body, lane);
}
```

and in `main.js`:

```js
const isResponsesLane = upstreamPath.endsWith('/responses');
const body = zen.buildUpstreamBody(hostBody, isResponsesLane ? 'responses' : 'chat');
```

Verified against the live endpoint through a ZCode build using exactly this shaping: `muse-spark-1.3-contributor-free` returns 200 and streams a normal completion.

### One more thing worth reconsidering

`reasoning_effort` is currently set unconditionally (`body.reasoning_effort = upstreamEffort(...)`), which means the field is present with value `undefined` when the host sent an off/none/unknown level. That's harmless on the chat wire, but it's easy to make explicit — and `undefined` is not valid JSON, so it disappears on serialize anyway. Just flagging it in case you want `delete` instead, for the same reason the Responses `tool_choice` gets deleted.

### Happy to send a PR

I have this working in a sibling project (a ZCode port of this same plugin) and can open a PR against this repo if that's useful. Just say the word.
