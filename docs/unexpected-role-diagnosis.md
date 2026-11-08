# `TIMEOUT` + `Unexpected message role.` 诊断（session-662585fd）

日期：2026-11-08 ｜ 会话：`session-662585fd-515b-4afd-9e1f-18f2fa755d17`（`Agent_novel_system` 工作区）

## 结论：两个故障叠加，都不是 session-suite 的问题，也和 `after step preparation fixed` 无关

用户截图里有两条错误：

| 错误 | 回合 | 根因 |
|---|---|---|
| `pi-ai stream idle timeout after 120000ms`（`TIMEOUT`） | turn 58 | profile 把 `streamIdleTimeoutMs` 压到 120000，内核默认是 300000。第 8 步流已经产出 `block-start` + `text-chunks`，只是**空闲超过 2 分钟**就被判失败——慢而健康的流被误杀 |
| `Unexpected message role.`（`PI_AI_ERROR`） | turn 59 / 60 | `amd` provider **漏配 `supportsDeveloperRole: false`**。pi-ai 对带 `reasoningEfforts` 的模型用 `developer` 角色发系统提示，AMD 上游不认这个角色，第一次请求就回 `Unexpected message role.` |

**因果链**：turn 58 超时 → 换到 `amd/Qwen3.8-27B`（seq 8853/8854 `model/selection`）→ turn 59/60 连续两次 `Unexpected message role.`，整轮立刻死（`usage` + `finish` 两个 chunk，0 input/0 output token）。

## 证据

### 1. `Unexpected message role.` 只发生在这个会话、只发生在这个模型

对全部 21 个会话日志统计（`tools/_probe-role-scope.mjs`）：

```
"Unexpected message role." errors across all sessions: 2
  by session: 2  session-662585fd
  by route:   2  amd/Qwen3.8-27B
  Qwen3.8-27B overall: 2 attempts, 0 successful turns
```

不是随机故障，是**该路由 100% 必挂**。

### 2. pi-ai 的角色决策（决定性证据，`app.asar` 偏移 144,749,850）

```js
const instructionRole = model.reasoning && compat.supportsDeveloperRole ? "developer" : "system";
```

`Qwen3.8-27B` 在 profile 里声明了：

```yaml
- id: Qwen3.8-27B
  contextWindow: 262144
  maxTokens: 131072
  reasoningEfforts:            # ← 这是 reasoning 模型
    off: null
    low: low
    medium: medium
    high: high
```

而 `amd` 块（原第 219 行）是**唯一一个 `api: openai-completions` 却没有 `compat.supportsDeveloperRole` 的 provider**：

```
agnes            OK      agnes-backup     OK
zhipu            OK      nvidia           OK
siliconflow      OK      amd              MISSING   ← 根因
llm-pi-ai        MISSING（无 reasoning 模型，暂时无害）
```

pi-ai 自带文档（`app.asar` 偏移 144,352,911）也写明：

> Some OpenAI-compatible servers do not understand the `developer` role used for reasoning-capable models. For those providers, set `compat.supportsDeveloperRole` to `false` so the system prompt is sent as a `system` message instead.

### 3. `Unexpected message role.` 不是内核抛的

全盘搜索 `app.asar` 与所有已装插件，该字符串出现 **0 次**。它是 pi-ai/上游的原始 `errorMessage`，被内核 `classifyPiAiError()` 兜底成 `PI_AI_ERROR`（`app.asar` 偏移 108,749,626）：

```js
case "error": {
  const text = message.errorMessage ?? "pi-ai stream error";
  return { kind: "error", failure: { message: text, code: classifyPiAiError(text) } };
}
```

所以错误文本来自上游响应，不是 DSH 自身代码。

### 4. TIMEOUT 是配置压低了阈值

profile 三处 `streamIdleTimeoutMs: 120000`（agnes-backup / siliconflow / amd），内核默认 `DEFAULT_STREAM_IDLE_TIMEOUT_MS = 3e5`。turn 58 的 `assistant/attempt`（seq 8850）有 3 个 chunk：`block-start`、`text-chunks`、`finish`——模型在输出，只是慢。

## 已做的修复（profile 配置，本地，未发版）

备份：`cordis.patch.yml.bak-devrole-20261108-192034`

1. **`amd` 补 `compat`**（原第 219 行）：
   ```yaml
   amd:
     ...
     compat:
       supportsDeveloperRole: false
       maxTokensField: max_tokens
   ```
2. **`llm-pi-ai` 补同样的 `compat`**：同一 Agnes 上游，保持一致，防止以后给它加 reasoning 模型时复发。
3. **三处 `streamIdleTimeoutMs` 从 120000 调回 300000**（内核默认值）。

校验：7 个 `openai-completions` provider 现在全部有 `supportsDeveloperRole: false`；无 tab 混入；`compat:` 缩进一致（8 空格，flags 10 空格）。

## 你需要做的

1. **完全退出 DSH 再重启**——`cordis.patch.yml` 是 profile 配置，HMR 已禁用，不重启不生效。
2. 回到 `session-662585fd` 后，**把模型切离 `amd/Qwen3.8-27B`**（比如切回 `trae/deepseek-v4.1-flash` 或 `FallbacksChain/Auto`），再点「继续」。修复后 `Qwen3.8-27B` 本身应该也能用了，但先离开失败状态更稳妥。
3. 如果 turn 59/60 的失败状态仍卡住，用「回滚到此步骤」回到 turn 57 或更早（turn 57 是正常完成的），再继续。

> 注意：这个会话早期（turn 1/2/3/13/56）还有 `after step preparation fixed` 报错，那是 0.6.13 时代的遗留；现在装的是 0.7.0，该路径已删除。修复后新回合不会再出现。

## 为什么这次不用改 session-suite

- 错误发生在 **LLM 请求构造/上游响应**阶段，早于记忆注入和任何 session-suite 钩子。
- `assistant/attempt` 显示 0 input / 0 output token，请求尚未进入模型。
- 与 `dsh-session-suite` 的 `conflicts` / `pain` / `maintain` 路径无交集。
