# 长目标被 `CONTEXT_WINDOW_EXCEEDED` 中断、压缩也失败

日期：2026-11-09 ｜ 会话 `session-25830b8e-dbcd-49fd-b839-5b48bde30169`（`dsh-fallback-auto-pool-arch`）

## 报错原文

```
Requested token count exceeds the model's maximum context length of 262144 tokens.
You requested a total of 349626 tokens: 218554 tokens from the input messages
and 131072 tokens for the completion.
```

随后 `/compact`：
```
Compaction could not produce a useful summary. The attempt is recorded in the session log.
```

## 这不是一个 bug，是三个配置问题叠成了一个死锁

### 1. 虚拟链宣称 1M 窗口，真实下游只有 262144

日志里的关键序列（turn 3）：

| seq | 事件 | 内容 |
|---|---|---|
| 20 | `request/header` | `FallbacksChain/Auto maxTokens=131072` |
| 21 | `request/context` | `contextWindow: 1000000` |
| 976 | `request/header` | 同上，95 个工具 |
| 981 | `turn/end` | `349626 > 262144` |
| 975/979 | `compaction/end` | `283378 > 262144`（压缩自己也超） |
| 984 | `compaction/end` | `429 Qwen3.8-Flash-Next at concurrency limit` |

`dsh-llm-fallbacks@0.7.0` 的 `FallbacksChainAdapter.resolveModel()` 把**链头模型的能力**原样报给内核：

```js
const info = await llm.resolveModelInfo(head.provider, head.model, signal)
return { ...info.context, ...info.defaultMaxTokens }
```

链头当时是 `amd/Qwen3.8-Flash-Next`（`contextWindow: 1000000`），内核于是放心保留了 218554 tokens 的输入历史。但 `walkChain()` 真正发请求时：

```js
llm.stream({ ...options, provider: target.provider, model: target.model, messages })
```

**只换 provider/model，`maxTokens` 原样透传**。请求可能落到链上任意一个模型——本例真实下游只有 `262144`。内核按 1M 算的预算，被原封不动送到 262144 的窗口里。

### 2. `maxTokens: 131072` 自己吃掉一半窗口

profile 里 4 个 `contextWindow: 262144` 的模型全都声明 `maxTokens: 131072`（占窗口 50%）：

```
google/diffusiongemma-26b-a4b-it, Gemma-4-31B-IT,
MiniCPM-V-4.7-35B-A3B, Qwen3.8-27B   ->  maxTokens: 131072
```

一旦历史超过 131072，加上这个输出预留就必然溢出。报错里的 `131072 for the completion` 正是这个值。

### 3. 压缩死锁：要压缩，得先带着全部历史发一次请求

`dsh-compaction-basic` 的默认配置：

| 字段 | 默认 |
|---|---|
| `thresholdRatio` | `0.8` |
| `headroomTokens` | `65536` |
| `maxTokens`（摘要输出上限） | `= headroomTokens` = `65536` |
| `summarizationProvider/Model` | 空 → **复用最近一次路由目标** |

而摘要请求本身会带上全部历史（`...input.messages`）：

```js
const options = { ...  messages, maxTokens: config.maxTokens, purpose: "compaction" }
for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
```

于是：**217842 输入 + 65536 摘要输出 = 283378 > 262144**，压缩必然失败。这就是「上下文满了 → 想压缩 → 压缩请求本身也超了 → 永远出不来」的死锁。手动 `/compact` 那次又撞上 `Qwen3.8-Flash-Next` 并发限流 429，雪上加霜。

官方 README 其实写明了这个陷阱：「Small-window deployments must configure headroom that fits their capacity; lower `thresholdRatio` to compact earlier」，并给出 `modelPolicies` 的写法。

## 已落地的修复（profile `cordis.patch.yml`）

备份：`cordis.patch.yml.bak-ctxfix-20261109-120650`

### A. `compaction-basic` 加显式 config

```yaml
- id: compaction-basic
  disabled: false
  config:
    thresholdRatio: 0.12        # 默认 0.8
    headroomTokens: 8192        # 默认 65536
    maxTokens: 8192             # 摘要输出上限，默认 65536
    retainRatio: 0.12
    compactionRetries: 2
    maxOverflowRetries: 2
    summarizationProvider: workbuddy
    summarizationModel: hy4free       # 实测 960000 窗口，单独走大窗口模型
    modelPolicies:
      - provider: FallbacksChain
        model: Auto
        thresholdRatio: 0.12
        headroomTokens: 8192
        maxTokens: 8192
        retainTokens: 16000
```

**为什么是 0.12 而不是 0.8 或 0.4**：虚拟链宣称 W=1000000，`floor(min(W × ratio, W − O − B))` 在 ratio=0.4 时算出 400000，远大于真实 262144 下游模型的消息预算（131072）——等触发压缩时历史早就溢出了。ratio=0.12 算出 **120000 < 131072**，能赶在真实溢出之前触发。实测两种 W（1000000 / 1048576）都满足。

### B. 4 个 262144 窗口模型的 `maxTokens` 131072 → 32768

给输入留出 ~229376 tokens，而不是只剩 131072。其余 16 处 `131072` 属于大窗口模型，不动。

### C. 静态校验全部通过

用内核自己的校验逻辑复核（`tools/_verify-ctx-config.mjs`）：

- 所有键都在 `BASIC_COMPACT_CONFIG_KEYS` / `MODEL_POLICY_KEYS` 白名单内（拼错会在加载时直接拒绝）
- `retainRatio` 与 `retainTokens` 互斥约束满足
- `summarizationProvider/Model` 成对
- 四种 W/O 组合下 `pressureBudget > 0` 且 `retain < threshold`
- 19 个 bundles、无 tab、`amd` compat、legacy 键、三处 `streamIdleTimeoutMs: 300000`、`allowBuilds` 全部完好

## 还需要你做的

1. **完全退出 DSH 再重启**（HMR 已关，profile 配置改动必须重启）。
2. 那个已经卡死的长目标：重启后建议**回滚到溢出之前的点**再继续，或者干脆新开一个会话恢复目标——因为现存历史已经 218K，即使新配置生效，第一次请求仍可能超过 262144。新配置的价值是**防止下一次再攒到这个程度**。
3. 恢复后可以让 agent 定期 `/compact`，或依赖 `thresholdRatio: 0.12` 自动触发。

## 长期建议（不在本次改动内）

- **虚拟链的能力声明是结构性缺陷**：`resolveModel()` 报链头、`walk()` 却可能落到任意下游。只要链里混着 262144 和 1M 窗口的模型，就有错位风险。更彻底的做法是让链里所有模型的 `contextWindow`/`maxTokens` 取**最小值**，或者不用 `FallbacksChain/Auto` 跑超长目标。
- **`maxTokens` 应按模型窗口比例声明**，而不是所有模型统一 131072。大窗口模型可以留 131072，小窗口模型应显著更低。
- **压缩摘要模型应显式指定大窗口模型**（本次已做），不要默认复用「最近一次路由目标」——那正是溢出时的目标。
