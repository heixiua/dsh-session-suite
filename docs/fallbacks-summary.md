# dsh-llm-fallbacks 故障降级：结论摘要

日期：2026-11-08 ｜ 环境：DSH 0.2.2-rc.1，profile `desktop`，`dsh-llm-fallbacks@0.6.13`

> **完整技术报告见 [`fallbacks-analysis.md`](./fallbacks-analysis.md)**（46KB，含偏移级源码证据、复现脚本、未验证项清单）。
> 本文是给决策用的摘要，只回答“是什么、为什么、怎么办”。

---

## 一、三个症状 = 三个独立故障

| # | 症状 | 根因 | 性质 | 修法 |
|---|---|---|---|---|
| 1 | 报错后不换模型，反而弹 `agent/request proposed "X" after step preparation fixed "Y"` | 插件同时装了**两套互斥机制**：新式虚拟适配器 + 旧式 `agent/request` 钩子。旧钩子在**步骤准备之后**用 `overrideConfig()` 改路由，被内核硬校验拦截并抛错 | 插件缺陷（0.7.0 已修） | 升级 0.7.0 |
| 2 | `400 max_tokens exceeds the limit of 65536` | profile 里 `llm-pi-ai/agnes-3.0-flash` **漏写 `maxTokens`**，落到内核默认 `128e3 = 131072`，而 Agnes 真实上限 65536 | **配置错误** | 补一行配置 |
| 3 | 只有 trae 的模型“能用” | 不是特权。硬机制是「任何 triggerCodes 失败 → 改写 → 抛错 → 整轮死」，各 provider **踩中概率不同**，trae 概率最低 | 归因澄清 | 随 1 一起消失 |

**最重要的一条**：症状 1 在 **0.7.0 已从结构上消除**——该版本删除了 `agent/request`、`agent/request-error`、`overrideConfig` 三条路径（实测出现次数均为 0），只保留虚拟适配器。**不需要自研。**

---

## 二、机制：为什么会抛那个错

内核 `prepareRequest()`（`app.asar` ~19,446,156）在 `agent/request` waterfall 之后硬性比较：

```js
if (proposedConfig.provider !== selection.provider || proposedConfig.model !== selection.model)
  throw new Error(`... use agent.model.select() before step preparation`);
```

即：**步骤准备阶段已把路由冻结，之后不许改**。而 0.6.13 的旧钩子正是在之后 `return overrideConfig(seed, applied.to)`。

更糟的是它**必然复现**：`commit()` 的 `writePending` 会清空 `appliedTurnStep`，使第二次 `prepareRequest` 必然再次 `applyPending` → 再次改写 → 再次抛错。这是自毁循环，不是“偶尔没生效”。

`overrideConfig` 只写 `provider` / `model` / 条件性 `reasoningEffort`，**其余字段全量透传 `...seed`**——这直接导致症状 2 在降级时被放大（见下）。

---

## 三、症状 2 的完整链路

```
profile: llm-pi-ai 的 agnes-3.0-flash 没写 maxTokens
   ↓
内核 DEFAULT_MAX_TOKENS = 128e3 = 131072
   ↓
请求带 max_tokens=131072
   ↓
Agnes 上限是 65536 → 400 invalid_request
   ↓
内核溢出正则 /exceeds the limit of \d+/i 命中（该条注释写的是 GitHub Copilot）
   ↓
被误判成 CONTEXT_WINDOW_EXCEEDED（而非 INVALID_REQUEST）
   ↓
fallbacks 用「上下文窗口」维度去筛候选 —— 用错了维度
```

**对照证据**：同一份 profile 里 `agnes:` 和 `agnes-backup:` 的同一个模型**都写了** `maxTokens: 65536`，只有 `llm-pi-ai:` 那条漏了。所以走 `agnes/` 不会 400，走 `llm-pi-ai/` 必 400。

**插件侧零能力适配**：`maxTokens` 在 0.6.13 全文件只出现 1 次，且是无关的角色选择调用（`maxTokens: 32`）；`contextWindow` 出现 14 次。切换 provider 时不会重算输出上限。

---

## 四、症状 3：我的一个猜想被推翻了

我最初推断「trae 不在 `rootChain` 里，所以降级逻辑不会碰它」。**这个推论是错的。**

实测（`tools/_verify-analyst.mjs`）：

```
=== throws where the FIXED route was trae
  turn 113: fixed=trae/deepseek-v4.1-flash proposed=workbuddy/deepseek-v4.1-flash
  turn 140: fixed=trae/deepseek-v4.1-flash proposed=nvidia/deepseek-ai/deepseek-v4.1-flash
```

用户选的是 trae，插件照样试图切走并抛错。**trae 一样会被碰、一样会崩，只是概率低。**

正确解释：各 provider 失败中命中 `triggerCodes` 的比例不同（nvidia 100%、amd 100%、trae 60%、workbuddy 40%、agnes-backup 0%、llm-pi-ai 0%），叠加 trae 是默认模型且最健康，于是“大概率不崩”被体感成“只有它能用”。

> 这张比例表来自协作者的 attempt 级统计。**我用 `llm/retry` 事件独立归因时只能对上 1/125**，说明 `agent/request-error` 触发的降级不总伴随 `llm/retry` 事件——两种失败通道日志覆盖不同。**结论方向（概率差异而非特权）与我的证据一致，具体数字请当参考量级。**

---

## 五、立即可做的两件事（零风险）

### 1. 补配置，消掉 400

`D:\AI agent cache\dsh\profiles\desktop\cordis.patch.yml`，`llm-pi-ai` 块（第 334 行起）：

```yaml
      llm-pi-ai:
        displayName: Agnes 3.0 Flash【炜】
        apiKeyEnv: LLM_PI_AI_API_KEY
        api: openai-completions
        baseURL: https://apihub.agnes-ai.com/v1
        models:
          - id: agnes-3.0-flash
            name: agnes-3.0-flash
            contextWindow: 524288     # ← 新增
            maxTokens: 65536          # ← 新增（关键）
```

### 2. 升级 fallbacks，消掉 `after step preparation fixed`

```bash
# 铁律：先完全退出 DSH 全部 6 个进程，再装
pnpm add dsh-llm-fallbacks@0.7.0
```

**⚠️ 升级有一个陷阱**（协作者发现，我认为可信）：0.7.0 的语义变成「**只有选 `FallbacksChain/Auto` 才有降级**，选真实 provider 时一律交给 llm-retry」。所以升级后必须把模型切到 `FallbacksChain/Auto`，否则等于关掉了自动降级。而当前链头是 `amd/Qwen3.8-Flash-Next`（实测 2/4 失败）——**不调 timeSlots 的话，等于把 trae 换成 amd**。

### 3. 最快的止血（如果不想动插件）

清空 `llm-fallbacks` 的 `triggerCodes`（或整行 `disabled: true`）→ 钩子第一行就 `return next()`，报错立刻消失。代价：暂时没有自动降级。

---

## 六、要不要自研

**我的建议：先做上面两步，别急着自研。**

理由：0.7.0 已经删掉了抛错的那条路径，而我们**还没测过它**。在没测过替代品的情况下重写，很可能把已经修好的问题再写回来——这正是这个插件在 0.6.x → 0.7.0 之间发生的事。

**只有满足以下两条以上，自研才值得**：

1. 需要**切换时按目标模型重算输出上限**（0.6.13 明确没做，这是最容易复发的坑）。
2. 需要**按真实错误语义分类**，而不是被内核的 `CONTEXT_WINDOW_EXCEEDED` 误判牵着走。
3. 需要**降级过程可见**——现在换没换、为什么换、换完成没成功，用户在 UI 上完全看不到。**这是本次抱怨的真正核心。**

我的判断：**第 3 点最值得做**。用户这次说的是“我不知道它为什么没换”，不是“它没换”。

完整方案见 [`fallbacks-replacement-plan.md`](./fallbacks-replacement-plan.md)（约 1600 行工作量，只做可观测性 + 能力对齐 + 错误分类三件事，冷却/半开/时间槽等现成机制不重写）。
