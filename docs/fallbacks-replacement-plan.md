# 自研降级插件方案（只给方案，暂不落地）

日期：2026-11-08 ｜ 目标：比 `dsh-llm-fallbacks` 好用

前置阅读：`docs/fallbacks-analysis.md`（现状与三个根因）。

---

## 一、先想清楚：到底要不要自研

**诚实的结论：如果只是修症状，不需要自研。**

| 需求 | 现成手段 | 成本 |
|---|---|---|
| 不再抛 `after step preparation fixed` | 升级 0.7.0（已删除该钩子） | 5 分钟 |
| 不再 400 `max_tokens exceeds` | 给 `llm-pi-ai` 补 `maxTokens: 65536` | 2 分钟 |
| 失败后自动换模型 | 0.7.0 的虚拟适配器已实现 | 0 |

**自研值得做的判据**（满足两条以上才动手）：

1. 需要在**切换时按目标模型重算输出上限**——0.6.13 明确没有做（`maxTokens` 全文件只出现 1 次），0.7.0 是否修好需另测，但这是最容易复发的坑。
2. 需要**按真实错误语义分类**，而不是被内核的 `CONTEXT_WINDOW_EXCEEDED` 误判牵着走。
3. 需要**降级过程可见**：现在换没换、为什么换、换了之后成不成功，用户在 UI 上完全看不到，只能从错误里猜。
4. 需要**按失败类型选不同补救**：输出超限→降 maxTokens 重试同一模型；限流→换 provider；超时→换更快模型。现在所有 code 走同一条“换模型”路径。

我的判断：**第 3 点最值得做**。用户这次的核心抱怨是“我不知道它为什么没换”，而不是“它没换”。

---

## 二、架构选择：虚拟适配器，不是钩子

**硬约束（内核实证）**：`agent/request` waterfall 返回的 provider/model 必须等于 `selection`，否则抛错。所以**任何**在步骤准备后改路由的实现都是错的。

正确形态：

```js
// 注册一个可被用户在模型选择器里选中的虚拟路由
ctx.inject(['llm'], (llmCtx) => {
  const adapter = createChainAdapter({ readConfig, walk })
  const dispose = llmCtx.llm.registerAdapter(['ChainAuto'], adapter)
  return () => dispose()
})
```

`adapter.stream(options)` 内部完成整条链的遍历与重试，**对内核只表现为一个普通模型**。内核的 `selection` 始终是 `ChainAuto/Auto`，永远不会变化，因此永远不会触发那个校验。

这同时解决了一个隐性痛点：**用户切模型时不需要知道自己在切链**。选中 `ChainAuto` 就等于“给我最好的可用模型”。

---

## 三、核心设计：三层决策

### 3.1 第一层——能力对齐（解决 400）

**问题**：从 nvidia（maxTokens 262000）切到 agnes（65536）时，旧上限会跟着过去。

**方案**：切换时**必须**从目标模型的能力描述重新解析，不允许沿用 seed。

```js
async function routeWithCapability(route, seed) {
  const info = await llm.resolveModelInfo(route.provider, route.model)
  return {
    ...seed,
    provider: route.provider,
    model: route.model,
    // 关键：上限取目标模型的能力，取不到就不猜
    maxTokens: Math.min(seed.maxTokens ?? Infinity, info?.maxTokens ?? seed.maxTokens),
    contextWindow: info?.contextWindow,
  }
}
```

**原则**：`min(请求值, 目标上限)`，而不是直接覆盖。用户主动要 1000 token 的输出时，不该被抬到 65536。

### 3.2 第二层——错误分类（解决“换错方向”）

把失败分成**三类补救**，而不是一律换模型：

| 失败语义 | 真实 code | 补救 |
|---|---|---|
| 输出上限超了 | `INVALID_REQUEST` + 消息含 `max_tokens exceeds` | **同模型重试**，`maxTokens` 降到目标上限 |
| 输入上下文超了 | `CONTEXT_WINDOW_EXCEEDED`（真正的溢出） | 换上下文窗口**更大**的模型；没有则报错不换 |
| 限流 / 配额 / 鉴权 | `RATE_LIMIT` / `QUOTA` / `AUTH` | 换 provider（这条链的核心场景） |
| 超时 / 传输 / 5xx | `TIMEOUT` / `TRANSPORT` / `SERVER` | 换模型，优先选响应更快的 |
| 其他 4xx | `INVALID_REQUEST` | **不换**——换模型只会让同一个请求再错一次 |

**这是与现版本最大的差异**：现版本对 `CONTEXT_WINDOW_EXCEEDED` 单独处理，但那个 code 本身是被内核**误判**出来的（`max_tokens exceeds the limit of N` 命中了 `/exceeds the limit of \d+/i`）。自研版要**在适配器内部重新看原始错误消息**，不信任内核的 code。

### 3.3 第三层——冷却与回退

复用现版本已被验证的机制，不重新发明：

- **冷却**：失败的路由按 key 压制 N 秒（`cooldownMs`）。
- **半开探测**：冷却到期后允许一次试探（`recovery: 'half-open'`），失败则指数退避。
- **`revertPolicy`**：`never` = 一旦切换就停在新模型；`timer` = 冷却后回退到用户原选。
- **每步切换上限**（`maxSwitchesPerStep`）：防止一条链上反复横跳。

这些在 0.6.13/0.7.0 里都实现得不错，直接照抄思路即可。

---

## 四、最有价值的增量：可观测性

用户这次的抱怨本质是**黑盒**。所以自研版应该把“降级”做成**可见的一等公民**：

### 4.1 每次切换留一条结构化记录

```js
{
  at: 1794128294407,
  agentId: 'session-b374638f-…',
  turn: 209, step: 92,
  from: { provider: 'amd', model: 'Qwen3.8-Flash-Next' },
  to:   { provider: 'agnes-backup', model: 'agnes-3.0-flash' },
  reason: 'RATE_LIMIT',
  rawMessage: '429 Too Many Requests',
  capabilityAdjusted: { maxTokens: 262000 → 65536 },
  outcome: 'succeeded' | 'failed' | 'still-running',
  latencyMs: 1840,
}
```

写到 `~/.dsh/storages/<plugin>/fallback-log.jsonl`，环形保留最近 500 条。

### 4.2 设置页显示「降级时间线」

一行一次切换：`时间 · 从 → 到 · 原因 · 结果`。这比任何文档都管用——用户一眼就能看出“它到底换没换”。

### 4.3 一个「现在会选谁」的诊断按钮

给定当前配置和冷却状态，算出下一条链的头是谁、为什么，**不实际发请求**。这是排查“为什么没换”最快的手段。

### 4.4 内置契约自检

启动时检查：内核是否仍要求 `selection` 不变、`llm.registerAdapter` 是否存在、`resolveModelInfo` 是否可用。任一缺失就在设置页报警——而不是等运行到一半才发现。

---

## 五、配置形态

沿用现版本的形状，降低迁移成本，只加新键：

```yaml
- id: llm-chain
  name: dsh-llm-chain
  config:
    # 有序候选链（第一个可用者胜）
    chain:
      - nvidia/deepseek-ai/deepseek-v4.1-flash
      - agnes-backup/agnes-3.0-flash
      - agnes/agnes-3.0-flash
      - workbuddy/hy4free
    # 按失败类型分派补救，而不是一律换模型
    policy:
      RATE_LIMIT:   { action: switch, scope: request }
      QUOTA:        { action: switch, scope: route }
      AUTH:         { action: switch, scope: route }
      TIMEOUT:      { action: switch, scope: request }
      TRANSPORT:    { action: switch, scope: request }
      SERVER:       { action: switch, scope: request }
      # 输出上限：不换模型，降 maxTokens 重试
      OUTPUT_LIMIT: { action: shrink-max-tokens, retry: same-model }
      # 输入上下文：只换更大的
      CONTEXT_WINDOW_EXCEEDED: { action: switch-larger-context }
      # 其他 4xx：不换
      INVALID_REQUEST: { action: fail-fast }
    cooldownMs: 60000
    recovery: half-open
    revertPolicy: timer
    maxSwitchesPerStep: 2
    # 可观测性
    logSwitches: true
    logKeep: 500
```

**与现版本的差别只有两处**：`policy`（按 code 分派）与 `logSwitches`。其余照抄。

---

## 六、实现清单（如果要落地）

| 模块 | 职责 | 预估 |
|---|---|---|
| `lib/chain.js` | 候选链解析、冷却、半开、切换计数 | 复用现版本逻辑，约 300 行 |
| `lib/adapter.js` | 虚拟 LlmAdapter，`stream()` 内遍历链 | 约 250 行 |
| `lib/capability.js` | 切换时重算 maxTokens/contextWindow | 约 100 行，**最关键的 100 行** |
| `lib/classify.js` | 从原始消息重新判定失败语义 | 约 150 行 |
| `lib/trace.js` | 切换日志与诊断 | 约 120 行 |
| `client.js` | 设置页时间线 + 诊断按钮 | 约 300 行 |
| 测试 | 契约测试 + 分类表驱动测试 | 约 400 行 |

**总计约 1600 行**，比 session-suite 小一个量级。

**必测的四条**（对应这次踩的坑）：

1. 切换后 `maxTokens` 等于目标模型上限（用 nvidia→agnes 复现）。
2. `max_tokens exceeds the limit of 65536` 被归类为 `OUTPUT_LIMIT`，**不**触发换模型。
3. `agent/request` 钩子**完全不存在**（静态断言，防止回退）。
4. 用户选择 `ChainAuto` 后，内核 `selection` 在整个链遍历过程中**不变化**。

---

## 七、我的建议

**分两步，先便宜后昂贵：**

**第一步（今天就能做完，零风险）**
1. 修 `llm-pi-ai` 的 `maxTokens: 65536`。
2. 升级 `dsh-llm-fallbacks@0.7.0`。
3. 用真实请求验证：故意触发限流，确认它换模型且不抛 `after step preparation fixed`。

**第二步（可选，看第一步结果）**
如果升级 0.7.0 后仍然“报错不换”或“换了用户看不见”，再自研。届时只做**可观测性 + 能力对齐 + 错误分类**三件事，不做别的——现版本的冷却、半开、时间槽这些机制已经够用，重写它们是浪费。

**不建议现在就自研的理由**：0.7.0 已经删掉了抛错的那条路径，而我们还没测过它。在没测过替代品的情况下重写一个，很可能把已经修好的问题再写回来——这正是这个插件在 0.6.x 到 0.7.0 之间发生的事。
