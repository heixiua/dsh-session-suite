# dsh-llm-fallbacks@0.6.13 源码分析报告

> 只读分析。所有结论均标注证据来源（文件路径 + 字节偏移/行号 + 代码片段）。
> 分析对象：
> - 插件：`D:\AI agent cache\dsh\profiles\desktop\node_modules\dsh-llm-fallbacks\dist\index.js`（128304 B，已压缩但保留换行与注释）
> - 内核：`D:\AI app\DSH\resources\app.asar`（213,202,918 B；用 `fs.readFileSync` + `buf.toString('latin1')` + `indexOf` 定位，偏移即 `latin1` 字符串下标）
> - Profile 配置：`D:\AI agent cache\dsh\profiles\desktop\cordis.patch.yml`
> - 实测语料：会话日志 `sessions\--D-AI~0020sandbox-dsh-sandbox-DSH~0020Optimize--\session-b374638f-a5a1-4d75-bf57-fc2518174b0e\session.v4.jsonl.zstd`（zstd 解压后 88,883,708 B / 41,029 条事件），下文简称 **SESSION**。

---

## 0. 摘要（先看这个）

| # | 问题 | 结论 |
|---|---|---|
| 1 | `overrideConfig(seed, applied.to)` 改了什么 | 只改 `provider` / `model` 两个键（外加按 route-changed 规则删掉 `reasoningEffort`）。它绕不过校验，因为内核在 `agent/request` waterfall **之后**、用 waterfall 之前的 `selection` 做硬相等比较 |
| 2 | 正确 API | `agent.model.select({provider, model, reasoningEffort?})`（`Model` 接口）。必须在**本步 `preStep()` 读取 `model.current()` 之前**调用；`decision.selection` 在一整步（含 request-error 重试循环）内被冻结，所以 `agent/request-error` 里调 select **改不了本次重试**，只能改下一步 |
| 3 | `{kind:"retry"}` 会重走 prepareRequest 吗 | **会**。重试循环 `continue` 回到 `prepareRequest(turn, step, decision.selection, ...)`，用的是**同一个** `decision.selection`；而插件的 `applyPending` 在 commit 后必然返回 pending → 必然 `overrideConfig` → 必然抛错。这是**死循环式自毁**，不是"没生效" |
| 4 | 为什么只有 trae 能用 | **证据不足以下单一因果结论**，但已可证明一个**必要机制**：任何 `triggerCodes` 命中都会触发改写 → 崩溃。trae/workbuddy 之所以"能用"是因为它们失败率低且大部分失败被 `llm-retry` 在 fallbacks 之前吸收；nvidia/amd 的失败 **100% 命中 triggerCodes**，所以每次失败必崩。详见 §4 |
| 5 | `max_tokens exceeds the limit of 65536` | 是 **AgnesAI 上游的输出上限**。来源：`llm-pi-ai` provider 里 `agnes-3.0-flash` 未声明 `maxTokens`，落到 provider 级默认 `defaultMaxTokens = 128000`，按 `max_tokens` 字段发出 → 超限。插件**零**能力适配（全文件只有 1 处 `maxTokens`，是无关的角色选择调用）。内核还把它误判成 `CONTEXT_WINDOW_EXCEEDED` |
| 6 | 0.6.13 vs 0.7.0 | 0.7.0 **完全删除**了 `agent/request` / `agent/request-error` / `overrideConfig`，改为纯虚拟适配器 `FallbacksChain/Auto`，在 adapter 内部 `walk()` 换 provider。**升级即可从结构上消灭这个报错** |

---

## 1. Q1：`overrideConfig(seed, applied.to)` 到底改了什么？为什么绕不过校验？

### 1.1 定义

`dist/index.js` 偏移 **51247**（`//#region .build/host/override.js`）：

```js
function overrideConfigWithRouteRule(seed, to, explicitEffort) {
	if (explicitEffort !== void 0) return {
		...seed,
		reasoningEffort: explicitEffort,
		provider: to.provider,
		model: to.model
	};
	if (!(to.provider !== seed.provider || to.model !== seed.model)) return {
		...seed,
		provider: to.provider,
		model: to.model
	};
	const { reasoningEffort: _routeOwned, ...withoutRouteOwnedEffort } = seed;
	return {
		...withoutRouteOwnedEffort,
		provider: to.provider,
		model: to.model
	};
}
```

偏移 **105251** 有同名薄包装（供 gateway 使用）：

```js
function overrideConfig(seed, to, explicitEffort) {
	return overrideConfigWithRouteRule(seed, to, explicitEffort);
}
```

**写入的键（穷举）**：`provider`、`model`，以及条件性地 `reasoningEffort`（显式给出时写入；路由改变且未显式给出时**删除**）。除此之外 `...seed` 全量透传 —— 注意这意味着 `maxTokens` 等控制项**原样跨 provider 传递**（见 §5）。

`dist/override.d.ts` 的文档注释也自证这是"纯函数、路由改写"：

```
 * - Route changed without an explicit effort → the seed effort is dropped
 *   (never carry a stale effort into a different provider/model route).
```

### 1.2 调用点（4 处，全在 `agent/request` / 决策路径里）

`grep overrideConfig` 命中偏移：`51247, 105251, 105302, 119188, 122596, 123478`。真正改写的三处：

- **119188** — `ctx.on("agent/request")` 主分支：
  ```js
  ctx.on("agent/request", async ({ agent, turn, step }, next) => {
      const seed = await next();
      const state = states.peek(agent.id);
      const applied = state === void 0 ? void 0 : states.applyPending(state, turn, step);
      if (applied !== void 0) return overrideConfig(seed, applied.to);
  ```
- **122596** — subagent role-inject 分支：`return overrideConfig(seed, to);`
- **123478** — always-mode 重试上限分支：`if (appliedCap !== void 0) return overrideConfig(seed, appliedCap.to);`

### 1.3 为什么绕不过校验

内核 `prepareRequest`（asar 偏移 **19446156** 附近，`dsh-agent-loop` 的 `Agent.prepareRequest`）：

```js
async prepareRequest(turn, step, selection, signal) {
    const { session } = this;
    const maxTokens = this.options.maxTokens;
    const { provider: _provider, model: _model, reasoningEffort: _effort, ...controls } =
        this.requestHeaderLogged ? requestProposal(session.requestHeader())
        : maxTokens === void 0 ? {} : { maxTokens };
    const seedConfig = deepFreeze(structuredClone({ ...controls, ...selection }));
    const proposedConfig = await this.dispatch.waterfall("agent/request", { turn, step, signal },
        () => Promise.resolve(seedConfig));
    signal.throwIfAborted();
    if (proposedConfig.provider !== selection.provider || proposedConfig.model !== selection.model)
        throw new Error(`agent "${this.id}": agent/request proposed "${proposedConfig.provider}/${proposedConfig.model}" after step preparation fixed "${selection.provider}/${selection.model}"; use agent.model.select() before step preparation`);
    if (proposedConfig.reasoningEffort !== selection.reasoningEffort)
        throw new Error(`agent "${this.id}": agent/request proposed reasoning effort ...`);
    ...
}
```

要点：
1. `selection` 是**函数参数**，由 `preStep()` 在 waterfall **之前**捕获，`agent/request` 事件载荷里**根本不含** selection，插件拿不到也无法改。
2. 校验是 `!==` 硬相等，**没有**"允许改写"的开关、没有白名单。
3. 抛的是普通 `Error`（不是 `LlmError`），所以不会被任何 `LlmError` 分支捕获；它直接冒泡到 `step()` → `turn()` → `turn/end {reason:{kind:"error", error:{code:"UNKNOWN"}}}`。

**实测印证**（SESSION）：全库只有 6 类"proposed ≠ fixed"配对，共 9 次，全部落在 `turn/end` 且 `code: "UNKNOWN"`：

```
2 llm-pi-ai/agnes-3.0-flash  <-fixed-  amd/Qwen3.8-Flash-Next
2 llm-pi-ai/agnes-3.0-flash  <-fixed-  nvidia/deepseek-ai/deepseek-v4.1-flash
1 amd/DeepSeek-V4.1-Flash    <-fixed-  FallbacksChain/Auto
1 workbuddy/deepseek-v4.1-flash <-fixed- trae/deepseek-v4.1-flash
1 nvidia/deepseek-ai/deepseek-v4.1-flash <-fixed- workbuddy/hy4free
1 nvidia/deepseek-ai/deepseek-v4.1-flash <-fixed- trae/deepseek-v4.1-flash
1 trae/deepseek-v4.1-flash   <-fixed-  workbuddy/deepseek-v4.1-flash
```

注意第 3 行 `fixed "FallbacksChain/Auto"` —— 说明即使用户选了虚拟路由，插件的 `agent/request` 钩子仍会把 `FallbacksChain/Auto` 改成具体 provider，照样撞墙。**这个钩子与虚拟适配器在 0.6.13 里是并存的，前者会毁掉后者。**

---

## 2. Q2：内核正确 API 是什么？

### 2.1 服务名与签名

`Agent` 接口（asar **19145166** 的 types 声明）：

```
export interface Agent {
    readonly id: SessionId;
    readonly options: AgentOptions;
    readonly session: Session;
    readonly model: Model;        // <-- 这里
    readonly inbox: Inbox;
    readonly status: AgentStatus;
    ...
}
```

`Model` 接口（asar **19166574**）：

```
export interface Model {
    current(): Readonly<ModelSelection> | undefined;
    select(selection: Readonly<ModelSelection>): void;
}
```

`ModelSelection`（同处）：

```
export interface ModelSelection {
    provider: string;
    model: string;
    reasoningEffort?: ReasoningEffortId;
}
```

> 这是**每个 Agent 实例上的对象**，不是 `ctx.get(...)` 服务。拿 `agent` 的途径：`agent/*` 系列事件的载荷、`ctx.get("agents").get(sessionId)`、`ctx.agents.list()`。

### 2.2 `select()` 的实现：只追加一条 durable 事件

asar **19881887**（`AgentModel` 类）：

```js
select(selection) {
    if (sameModelSelection(this.recordedSelection(), selection)) return;
    this.session.append('model/selection',
        toSelection(selection.provider, selection.model, selection.reasoningEffort));
}
recordedSelection() {
    const state = this.readState();
    return state.pending ?? state.lastUsed;
}
```

`selection` 如何被更新 —— 投影 `modelSelectionProjectionDefinition`（asar **19817875**）：

```js
const modelSelectionProjectionDefinition = {
    key: "modelSelection",
    stateVersion: 3,
    stateSchema: z.object({ lastUsed: selectionSchema, pending: selectionSchema }),
    init: () => ({ lastUsed: null, pending: null }),
    apply: (state, event) => {
        if (event.type === "model/selection")
            return sameModelSelection(state.pending, event.data) ? state : { ...state, pending: event.data };
        if (event.type !== "request/header") return state;
        const lastUsed = selectionOfHeader(event.data.header);
        const pending = sameModelSelection(state.pending, lastUsed) ? null : state.pending;
        return ...;
    },
    wire: { viewSchema: ..., view: (state) => ({ lastUsed: state.lastUsed, next: state.pending ?? state.lastUsed }) }
};
```

链路：`select()` → 追加 `model/selection` → 投影 `pending = 新值` → `AgentModel.current()` 返回 `pending ?? lastUsed` → 下一个 `preStep()` 捕获为 `selection` → `prepareRequest` 用**同一个** `selection` 校验 → 通过。
同时 `request/header` 落盘后，若 `pending` 与 header 一致则清空 pending（`pending → lastUsed`）。

### 2.3 时机：「before step preparation」精确指哪一刻

asar **19435152** 附近的 `preStep()`：

```js
async preStep(target, position) {
    const signal = this.phase.abort.signal;
    const claimed = this.inbox.claim(target, position.turn);
    const selection = this.model.current();          // <-- ① 在这里冻结
    if (selection === void 0) throw new Error(...);
    const toolSet = await this.loopCtx.tools.resolve({ agent: this, modelSelection: selection, signal });
    try {
        const assembly = await this.loopCtx.systemPrompt.assemble({ ..., modelSelection: selection, toolSet });
        const decision = await this.dispatch.waterfall("agent/pre-step", {
            messages: claimed, ...position, signal,
            modelSelection: selection                    // <-- ② waterfall 拿到的只是快照
        }, () => { ... });
        ...
        return { ...decision, assembly, selection, toolSet };
    }
}
```

**关键结论（三条，都可直接写代码）**：

1. **`agent/pre-step` 监听器里调 `select()` 太晚** —— ①在 ②之前执行，`selection` 已经冻结。想改**当前步**，必须在 `preStep()` 之前（即上一个 step 结束之后 / turn 开始之前）。
2. **`agent/request-error` 监听器里调 `select()` 也改不了本次重试** —— `step()` 的重试循环是
   ```js
   while (true) {
       const { config, preparedCall } = await this.prepareRequest(turn, step, decision.selection, signal);
       ...
       const action = await this.dispatch.waterfall("agent/request-error", {...}, () => Promise.resolve(void 0));
       if (action?.kind !== "retry") throw new LlmError(...);
       continue;                                  // <-- 回到上面，仍是 decision.selection
   }
   ```
   `decision.selection` 整步不变。
3. **因此：单靠 `model.select()` 无法在同一次请求内换模型。** 想"失败即换、不中断"，唯一被内核认可的做法是**让 selection 本身是虚拟路由**，在适配器内部换 provider —— 这正是 0.7.0 的做法（见 §6）。

### 2.4 内核自己在用这个 API 的地方（可作范式）

- `applyConfiguredRoute`（asar **19461966** 区域）：
  ```js
  applyConfiguredRoute(agent, options) {
      const { provider, model, reasoningEffort } = options;
      if (!provider || !model) return;
      const previous = agent.model.current();
      const selection = { provider, model, ...reasoningEffort === void 0 ? {} : { reasoningEffort } };
      if (selection.reasoningEffort === void 0 && previous !== void 0 &&
          previous.provider === selection.provider && previous.model === selection.model &&
          previous.reasoningEffort !== void 0) selection.reasoningEffort = previous.reasoningEffort;
      agent.model.select(selection);
  }
  ```
- `sessionController.selectModel(request)`（asar **22471961**，即 GUI 走的那条）：
  ```js
  async selectModel(request) {
      const agent = await this.resolveAgent(request.sessionId);
      return this.agents.serializeImageAdmission(agent, async () => {
          try {
              await this.requireModel(request);
              const selected = { provider: request.provider, model: request.model,
                  ...request.reasoningEffort === void 0 ? {} : { reasoningEffort: ReasoningEffortId(request.reasoningEffort) } };
              await this.ctx.llm.resolveCallConfig(selected);   // 先验证能力
              agent.model.select(selected);                     // 再落盘
              this.ctx.agentDefaultModel.saveSelection(selected).catch(...);
              return { selected: { ...selected } };
          } catch (error) { ... throw new RemoteError("session/model-unavailable", ...); }
      });
  }
  ```
- ACP 侧 `set(configId, value, signal)`（asar **19035497**）走 `MODEL_CONFIG_ID` 分支后 `this.model.select(selected)` —— 这是 lead 已找到的那处，属于 ACP 适配层，**不是插件该用的入口**。

> 用户可见副作用：`installModelSelection`（asar **19820865**）在下一个 `agent/pre-step` 会追加一条 `[model changed: ... → ...]` 的 `user/message` 通知（`source.kind = "model-selection"`），`decision.messages` 为空时跳过。

---

## 3. Q3：`agent/request-error` 的 `{kind:"retry"}` 是否重走 prepareRequest？

**是，且必然复现同一个错误。**

### 3.1 插件侧（`dist/index.js` 偏移 **118018**）

```js
ctx.on("agent/request-error", async ({ agent, turn, step, provider, failure }, next) => {
    const config = source();
    if (!isFallbackActive(config) || !config.triggerCodes.includes(failure.code)) return next();
    const current = currentModel(agent, provider, config, new Date());
    if (!current.model) return next();
    try {
        const pending = await decide(agent, turn, step, current, "trigger-code", states.peek(agent.id), failure.code);
        if (pending === null) { failHalfOpenProbe(agent.id, current); return next(); }
        const scope = REQUEST_SCOPED_CODES.has(failure.code) ? "request" : void 0;
        commit(states.get(agent.id), scope === void 0 ? pending : { ...pending, scope }, turn, step);
        return { kind: "retry" };                 // <-- 这里
    } catch (error) { ... return next(); }
});
```

`commit()`（偏移 **116914**）先 `states.writePending(state, pending)`，`writePending` 会把 `appliedTurnStep` 清成 `undefined`：

```js
writePending(state, pending) { state.pendingSwitch = pending; state.appliedTurnStep = void 0; }
applyPending(state, turn, step) {
    const pending = state.pendingSwitch;
    if (pending === void 0) return void 0;
    const applied = state.appliedTurnStep;
    if (applied !== void 0 && applied.turn === turn && applied.step === step) return void 0;
    state.appliedTurnStep = { turn, step };
    state.pendingSwitch = void 0;
    return pending;
}
```

### 3.2 因果链（实测 9/9 复现）

```
attempt 失败 (code ∈ triggerCodes)
  → agent/request-error waterfall → 插件 commit(pending) + return {kind:"retry"}
  → step() `continue`
  → prepareRequest(turn, step, decision.selection)      ← selection 仍是旧值
      → agent/request waterfall
          → applyPending() 返回 pending（因为 commit 刚清空了 appliedTurnStep）
          → return overrideConfig(seed, pending.to)      ← 改了 provider/model
      → 硬校验 proposed ≠ selection → throw Error
  → turn/end { kind:"error", error:{ code:"UNKNOWN" } }
```

**不是"retry 沿用同一 selection 所以没生效"，而是"沿用同一 selection 所以必然炸"。**
也不是"commit 的 pending 只在下一次 request 才 apply" —— `applyPending` 在**同一次** turn/step 的第二次 prepareRequest 上就会返回（`appliedTurnStep` 已被 `writePending` 清空）。

**实测交叉验证**（SESSION，按 turn 聚合）：

```
turns WITH >=1 trigger-code attempt error:
  -> ended in the mismatch hard error : 9
  -> completed anyway                 : 3
  -> ended in some OTHER error        : 1
turns with NO trigger-code error but mismatch error: 0
```

`mismatch ⟹ trigger-code 失败`，反向为 0，**因果闭合**。

那 3 个"居然成功了"的 turn（26 / 35 / 36）经查是 `llm/retry` 在 fallbacks 之前把 `TRANSPORT`/`SERVER`/`TIMEOUT` 重试掉了（`llm/retry` 事件 `policyKey: ["normal",5,["EMPTY_RESPONSE","RATE_LIMIT","SERVER","TIMEOUT","TRANSPORT"],500,10000,0.1]`），**根本没走到 fallbacks 的 `agent/request-error`**。这也解释了插件 `bundle/cordis.patch.yml` 里那段注释：

```yaml
# Insert position matters for the host waterfall: the profile must list the
# llm-retry bundle BEFORE dsh-llm-fallbacks, so this plugin's
# `agent/request-error` listener composes after llm-retry and only intervenes
# once retry policy is exhausted (normal mode) or delegates downstream first
# (always mode).
```

即：**能被 llm-retry 吸收的失败不会崩；一旦 llm-retry 用尽（5 次）→ fallbacks 接手 → 必崩。** 用户看到的就是"重试 5 次后突然报一个莫名其妙的 `use agent.model.select()`"。

---

## 4. Q4：为什么只有 trae 能用？

### 4.1 先排除两个流行假设

**假设 A：「trae 不在 rootChain 里，所以不被插件碰」→ 已证伪。**

- 当前 `cordis.patch.yml` 的 `rootChain` 确为 `nvidia / agnes-backup / agnes / workbuddy×3 / deepseek-official`，无 trae（实测 `trae-refs=0`，脚本扫全部 `cordis.patch.yml*` 备份确认；旧备份 `bak-086` 里曾有 `trae/deepseek-v4.1-flash`，现已被移除）。
- 但插件**不检查 selection 是否在链上**：`decide()` 只要 `triggerCodes` 命中就沿链取下一个候选。所以 trae 失败时同样会被改写。
- **实证**：turn 113 `proposed "workbuddy/deepseek-v4.1-flash" after step preparation fixed "trae/deepseek-v4.1-flash"`；turn 140 `proposed "nvidia/..." fixed "trae/..."`。**trae 一样被碰、一样崩。**

**假设 B：「trae 自带降级/自己注册 adapter，所以不依赖 fallbacks」→ 部分成立但不是"能用"的原因。**

- `dsh-connect-trae@4.9.0` 确实自己注册 adapter（`lib/index.js` 偏移 **525560**：`handle: ctx.llm.registerAdapter([provider], trae.adapter)`），也自带 `retryPolicy`（偏移 **63015**：`retryPolicy: resolveRetryPolicy(void 0, "dsh-connect-trae retryPolicy")`）与账号池轮换（`setRotatedAccount`，偏移 **134113**）。
- 但它**没有**注册 `agent/request` / `agent/request-error` 钩子（`grep` 均为 0），也就是说它**不参与、也不能阻止** fallbacks 的改写。所以"trae 能用"不是因为它自带降级逻辑挡住了插件。

### 4.2 实测数据（这是唯一站得住的解释方向）

按 **turn 首个请求的 provider** 统计结局：

```
provider         turns  ok  fail   death codes
trae                67  61    6    {CTX:1, forked:2, UNKNOWN:3}
workbuddy           31  28    3    {PI_AI_ERROR:1, UNKNOWN:2}
FallbacksChain      11   9    2    {UNKNOWN:1, CTX:1}
deepseek-account     8   8    0    {}
nvidia               5   2    3    {max-tokens:1, TIMEOUT:1, UNKNOWN:1}
amd                  4   2    2    {UNKNOWN:2}
agnes-backup         2   1    1    {CTX:1}
llm-pi-ai            1   0    1    {CTX:1}
```

按 **attempt 所属请求的 provider** 统计失败码（`TRIGGER = {AUTH,QUOTA,RATE_LIMIT,TIMEOUT,SERVER,TRANSPORT}`，即本 profile 的 `triggerCodes`）：

```
provider       attempts  errors  triggerCodeErrors  codes
nvidia             16      16            16          {TIMEOUT:11, TRANSPORT:4, SERVER:1}
trae               10      10             6          {TRANSPORT:2, SERVER:4}
workbuddy           7       5             2          {TIMEOUT:1, QUOTA:1}
FallbacksChain      3       3             1          {TIMEOUT:1}
llm-pi-ai           2       2             0          {}            ← 全是 CONTEXT_WINDOW_EXCEEDED，不在 triggerCodes
amd                 2       2             2          {TIMEOUT:1, RATE_LIMIT:1}
agnes-backup        1       1             0          {}            ← 同上
```

**核心不对称**：
- `nvidia`：16/16 失败，**100% 是 triggerCodes** → **每一次失败都必然触发改写 → 必然崩**。
- `amd`：2/2 失败，100% triggerCodes → 必崩。
- `trae`：10 次失败里只有 6 次是 triggerCodes，另外 4 次（`CONTEXT_WINDOW_EXCEEDED`）**不在** `triggerCodes` → 不触发改写 → 走正常错误路径/压缩恢复。
- `workbuddy`：2/5 是 triggerCodes。
- `agnes` / `llm-pi-ai`：失败码是 `CONTEXT_WINDOW_EXCEEDED`（即那个被误判的 400），**0% 触发** fallbacks。

再叠加两个事实：
- 用户默认模型是 **trae**（`cordis.patch.yml` 顶部 `agent-default-model: provider: trae, model: deepseek-v4.1-flash`），且 trae 是健康度最高的 provider（61/67 完成）。
- `subagent-model-selection-settings.allowedModels` 里同时列了 `trae/deepseek-v4.1-flash` 和 `FallbacksChain/Auto`，所以切模型时两条路都能选。

### 4.3 结论（明确表述）

> **「只有 trae 能用」不是"trae 有特权"，而是"trae 是最不容易踩到 triggerCodes 的那条，而踩到就必崩"。**

可证明的机制链：
1. 任何 `triggerCodes` 失败 → 插件改写 provider/model → 内核硬校验抛错 → **整轮 turn 直接死**（§3，9/9 实测）。
2. 各 provider 的 `triggerCodes` 失败率差异极大：nvidia 100%、amd 100%、trae 60%、workbuddy 40%、agnes/llm-pi-ai 0%。
3. 因此体感上"nvidia/amd 一用就报错"、"agnes 报 400 但不报 `use agent.model.select`"、"trae 基本能用"。

**证据不足的部分（明确声明）**：
- 无法从日志证明"用户每次切到非 trae 模型都必然失败" —— 因为用户切过去的模型也常在**第一步**就失败（`llm-pi-ai` 1/1 失败、`amd` 2/4 失败），失败原因混杂（上下文 400、限流、超时），样本太小。
- 无法证明 trae 上游本身"更稳" —— trae 也有 6 次 trigger-code 失败，其中 2 次直接崩（turn 113/140）。
- **未验证**：`dsh-connect-trae` 的账号池轮换是否在"单账号被限流"时自动换号从而把 QUOTA 类失败在 adapter 内部消化掉（代码里有 `setRotatedAccount` 与 `pooled account` 逻辑，但未实测其触发条件与成功率）。如果成立，这会额外抬高 trae 的"存活率"，但**不是**本报告已验证的结论。

**已排除的假设**：
- ❌ "trae 不在 rootChain 所以插件不碰它" —— 已被 turn 113/140 反证。
- ❌ "trae 自带 adapter 所以绕过 fallbacks" —— trae 不注册任何 `agent/request*` 钩子，无法阻止改写。
- ❌ "trae 从不失败" —— 10 次 attempt 失败，6 次命中 triggerCodes。

---

## 5. Q5：`max_tokens exceeds the limit of 65536` 从哪来？

### 5.1 是哪个 provider 的限制

**AgnesAI**。上游原文（SESSION，`assistant/attempt` 流内的 `finish.reason.failure.message`）：

```json
{"message":"400: {\"message\":\"max_tokens exceeds the limit of 65536 (request id: 202611080301253458878143yo2ngDR)\",\"type\":\"AgnesAI_error\",\"param\":\"\",\"code\":\"invalid_request\"}",
 "code":"CONTEXT_WINDOW_EXCEEDED"}
```

出现 19 次（`session-b374638f`）+ 33 次（Infinite_Canvas 会话），全部 `provider = llm-pi-ai` 或 `FallbacksChain`（虚拟路由把请求转给 `llm-pi-ai/agnes-3.0-flash`）。

### 5.2 maxTokens 从哪来（完整链路）

1. **provider 级默认值**：`dsh-llm-pi-ai` 的 Config 里
   `asar 108726062`：`const DEFAULT_MAX_TOKENS = 128e3;`（注释 `Output capability assumed for a model neither configuration nor the catalog sizes.`）
   `asar 108729976` / `108730028`：`defaultMaxTokens: z.number()....default(DEFAULT_MAX_TOKENS)`
   `asar 108736427`：`defaultMaxTokens: source.defaultMaxTokens ?? 128e3`
2. **模型未声明 → 落到默认**：`asar 108713723`
   `const maxTokens = entry.maxTokens ?? base?.maxTokens ?? request.defaultMaxTokens;`
3. **profile 里 `llm-pi-ai` 这个 provider 的 `agnes-3.0-flash` 没有 `maxTokens`**（`cordis.patch.yml`）：
   ```yaml
   llm-pi-ai:
     displayName: Agnes 3.0 Flash【燎】
     apiKeyEnv: LLM_PI_AI_API_KEY
     api: openai-completions
     baseURL: https://apihub.agnes-ai.com/v1
     models:
       - id: agnes-3.0-flash
         name: agnes-3.0-flash          # ← 无 maxTokens / 无 contextWindow
   ```
   对比同文件里 `agnes:` / `agnes-backup:` 两个 provider 的 `agnes-3.0-flash` 明确写了 `maxTokens: 65536`。
4. **落到 pi-ai 的模型对象**：`asar 108507268`
   `defaultMaxTokens: configured?.maxTokens ?? connection.maxTokens`；随后 `buildBaseOptions`（`asar 144848100`）
   `maxTokens: clampMaxTokensToContext(model, context, options?.maxTokens ?? model.maxTokens)`。
5. **字段名**：`compat.maxTokensField`（`asar 144767960` 的 `detectCompat`）对 openai-compatible 端点默认 `max_completion_tokens`，`isNvidia/isDeepSeek/isMoonshot/isZai/isTogether/...` 时为 `max_tokens`；profile 里显式 `compat: { maxTokensField: max_tokens }` → 发出 `max_tokens`。
6. 于是 `max_tokens = 128000 > Agnes 上限 65536` → 400。

### 5.3 fallbacks 有没有把别的模型的 maxTokens 透传给不支持的上游？

**没有透传，但也没有适配 —— 它是"零能力适配"的中转。**

- `overrideConfigWithRouteRule`（偏移 51247）**全量 `...seed` 透传**，只覆盖 provider/model/reasoningEffort。所以 seed 里若带 `maxTokens`，会原样带到目标 provider。
- 但更关键的是**从不主动解析目标模型的上限**。全文件 `maxTokens` 只出现 **1 次**（偏移 17377），且是无关的角色选择调用：
  ```js
  for await (const chunk of llm.stream({ provider: route.provider, model: route.model, system: prompt, messages: [...], maxTokens: 32, signal: ... }))
  ```
  对比：`contextWindow` 在插件里出现 14 次（`makeContextWindowOf` 只用于 `CONTEXT_WINDOW_EXCEEDED` 的"换更大上下文"筛选）。**`maxTokens` 没有任何按 provider 的能力适配。**
- 实测两个 header 的对照（SESSION `request/header`）：
  ```
  seq 25354  {"provider":"agnes-backup","model":"agnes-3.0-flash","maxTokens":65536}  adapterDefaults:{"maxTokens":true}
  seq 28558  {"provider":"agnes-backup","model":"agnes-3.0-flash","maxTokens":65536}  adapterDefaults:{"maxTokens":true}
  seq 36167  {"provider":"llm-pi-ai","model":"agnes-3.0-flash"}                        adapterDefaults: undefined
  seq 38066  {"provider":"FallbacksChain","model":"Auto"}                              adapterDefaults: undefined
  ```
  即：声明了 `maxTokens: 65536` 的 `agnes-backup` 请求是**合规**的；未声明的 `llm-pi-ai` 请求 header 里根本没有 `maxTokens`，由下游 adapter 补 `defaultMaxTokens=128000` → 400。
  而走虚拟路由时（seq 38066/38074）header 连 `maxTokens` 都没有，`FallbacksChainAdapter.stream()`（偏移 98450 区域）只是
  ```js
  return llm.stream({ ...options, provider: head.provider, model: head.model, messages: restoreEnvelopeProvenance(options.messages) });
  ```
  **完全继承调用方的控制项**，不做任何 provider 能力换算。

### 5.4 附带发现：内核把它误判成 `CONTEXT_WINDOW_EXCEEDED`

同一个 `failure` 对象的 `message` 是输出上限 400，`code` 却是 `CONTEXT_WINDOW_EXCEEDED`。这是内核的溢出识别正则（`/exceeds the limit of \d+/i`，注释里写的是 GitHub Copilot 的措辞）误命中。后果有两个，都实测可见：
1. 插件把它当作"上下文不够"处理（`REQUEST_SCOPED_CODES` 只含 `CONTEXT_WINDOW_EXCEEDED`，走 `scope: "request"` 不冷却），但本 profile 的 `triggerCodes` **不含** `CONTEXT_WINDOW_EXCEEDED` → 干脆不触发。
2. `compaction-basic` 的 `agent/request-error` 溢出恢复会被唤醒，去做一次"最大平衡头部削减"——但这次根本不是上下文溢出，属于无效动作。

---

## 6. Q6：0.6.13 vs 0.7.0 的 diff 级证据

**只下载对比，未安装到 profile。** 下载方式：`npm pack dsh-llm-fallbacks@0.7.0` 到 `%TEMP%\fb070` 后 `tar -xzf`。

### 6.1 版本清单（`npm view dsh-llm-fallbacks versions --json`）

最新为 `0.7.0`；本机装的是 `0.6.13`（`package.json` 实测 `name=dsh-llm-fallbacks version=0.6.13`）。

### 6.2 关键词计数对比

| 关键词 | 0.6.13 (`dist/index.js`, 128304 B) | 0.7.0 (`dist/index.js`, 122341 B) |
|---|---|---|
| `agent/request` | **2**（偏移 118018 是 `agent/request-error`，118944 是 `ctx.on("agent/request")`） | **0** |
| `agent/request-error` | **1**（偏移 118018） | **0** |
| `overrideConfig` | **6**（51247, 105251, 105302, 119188, 122596, 123478） | **0** |
| `registerAdapter` | 1（100527） | 1（25261） |
| `FallbacksChain` | 14 | 18 |
| `chain-walk` | 0 | 1（26189，新 region） |
| `model.select` / `.select(` | **0 / 0** | **0 / 0** |

> 注：两版都**从不**调用 `agent.model.select` —— 这本身就是 0.6.13 设计错误的旁证（它想换模型却用了错误的 API）。

### 6.3 文件级 diff（`dist/*.d.ts`）

0.7.0 **删除**了三个模块的公开类型：
- `dist/automatch.d.ts`
- `dist/authorized-route.d.ts`
- `dist/override.d.ts` ← 就是 `overrideConfigWithRouteRule` 的类型文件

0.7.0 **新增**：
- `dist/chain-walk.d.ts`（10834 B）

0.7.0 显著缩小：`state.d.ts` 9791 → 5922（`pendingSwitch` / `applyPending` / `writePending` 那套"改写待办"状态被删）；`index.d.ts` 10466 → 9237。

### 6.4 0.7.0 的新架构（源码证据）

`dist/index.js` 偏移 **26189** 起是新 region `.build/host/chain-walk.js`，核心是适配器内部**逐跳重试**：

```js
async function* walk(deps, start, options) {
    ...
    let switches = 0;
    for (;;) {
        const key = selectorKey(target.provider, target.model);
        let committed = false;
        let swallowed;
        for await (const chunk of llm.stream({ ...options, provider: target.provider, model: target.model, messages })) {
            const failure = chunk.type === "finish" && chunk.reason.kind === "error" ? chunk.reason.failure : void 0;
            if (failure !== void 0 && !committed && config.triggerCodes.includes(failure.code)) { swallowed = { chunk, code: failure.code }; break; }
            if (chunk.type === "finish") { ...; yield chunk; return; }
            yield chunk;
            committed = true;
        }
        if (swallowed === void 0) return;
        bookFailure(target, swallowed.code);
        const next = switches < config.maxSwitchesPerStep ? await advanceFrom(target, swallowed.code, "trigger-code") : void 0;
        if (next === void 0 || next.target === void 0) { yield swallowed.chunk; return; }
        switches += 1;
        deps.log.info("llm-fallbacks: agent \"%s\" fallback switch (降级切换) %s/%s -> %s/%s ...");
        target = next.target;
    }
}
```

适配器注册（偏移 **25261**）签名也变了，多了一个 `walk`：

```js
function installFallbacksAdapter(ctx, readConfig, walk) { ... }
const adapter = new FallbacksChainAdapter(readConfig, () => llm, walk);
...
disposeAdapter = llm.registerAdapter([FALLBACKS_PROVIDER$1], adapter);
```

`FallbacksChainAdapter.stream()` 在 0.7.0 简化为：
```js
stream(options) { return this.walk(options); }
```

**关键：0.7.0 里唯一的换模型发生在 `llm.stream()` 的 chunk 循环内 —— 这是 adapter 层，不经过 `agent/request` waterfall，因此完全绕开了内核的 selection 硬校验。**

### 6.5 0.7.0 的语义变更（README 原文，偏移见文件）

0.7.0 `README.md`：

> A session on any **real** provider/model has **no plugin fallback**: `llm-retry` alone handles it. **Select `FallbacksChain / Auto` in the model picker to get a chain.**

> - **Who gets a chain**: only sessions whose model selection routes to `FallbacksChain / Auto`. ... A real provider/model selection — root or subagent — is left entirely to llm-retry.
> - **Partial output is committed**: once an attempt has emitted a chunk, a later failure is **not** switched inside the request — yielded output cannot be unsent.

以及 `> **Upgrade note (breaking)**: the config-level `enabled` switch is **removed**`。

### 6.6 升级结论

| 维度 | 0.6.13 | 0.7.0 |
|---|---|---|
| 换模型机制 | `agent/request` 钩子改 seed（非法） | 虚拟 adapter 内部换 provider（合法） |
| `use agent.model.select() ...` 报错 | **必然复现**（9/9） | **结构上不可能**（无该钩子） |
| 生效范围 | 任意 selection（含真实 provider） | **仅 `FallbacksChain/Auto`** |
| 部分输出后的切换 | 会尝试（并炸） | 明确不切换（已 yield 的输出不能撤回） |
| 配置项 | 有 `enabled` | `enabled` 移除（breaking） |

⚠️ **升级到 0.7.0 的代价**：用户当前是"在 trae 上工作、失败自动降级"，升级后 **trae 不再有任何自动降级**（真实 provider 一律交给 llm-retry）。必须**主动把 selection 切到 `FallbacksChain/Auto`** 才能恢复降级能力。而 `FallbacksChain/Auto` 的链头来自 `timeSlots`/`rootChain` —— 当前 15:42 属 `liang-peak` 窗口，链头是 `amd/Qwen3.8-Flash-Next`（正是用户报错里那个"fixed"的模型），而 amd 实测 2/4 失败。**升级后必须同步修链，否则等于把 trae 换成了 amd。**

---

## 7. 症状 → 根因 对照表

| # | 用户看到的症状 | 直接触发点 | 根因 | 证据 |
|---|---|---|---|---|
| 1 | `agent "session-…": agent/request proposed "llm-pi-ai/agnes-3.0-flash" after step preparation fixed "amd/Qwen3.8-Flash-Next"; use agent.model.select() before step preparation` | 插件 `agent/request` 钩子 `return overrideConfig(seed, applied.to)`（`dist/index.js:119188`） | 内核 `prepareRequest` 在 waterfall 后用**冻结的** `selection` 做 `!==` 硬校验（asar ~19446156）。插件用了 0.6.x 的旧写法，内核已改为"只能 `agent.model.select()`" | 2 次（turn 204/205），`turn/end` `code:"UNKNOWN"` |
| 2 | 同上，但 fixed 是 `nvidia/deepseek-ai/deepseek-v4.1-flash` | 同上 | 同上 | 2 次（turn 207/208） |
| 3 | 报错总在"重试 5 次之后"才出现 | `llm-retry` 用尽 → `agent/request-error` → 插件 `commit` + `{kind:"retry"}` → `continue` 复用同一 `decision.selection` → 必炸 | 重试循环不重算 selection（asar step() `while(true)`） | `mismatch ⟹ trigger-code 失败` 9/9，反向 0 |
| 4 | `400: max_tokens exceeds the limit of 65536 (AgnesAI_error, invalid_request)` | `llm-pi-ai` 的 `agnes-3.0-flash` 未声明 `maxTokens` → 落到 `defaultMaxTokens = 128000` → `max_tokens=128000` | profile 配置缺 `maxTokens`（同文件 `agnes:`/`agnes-backup:` 有 65536，`llm-pi-ai:` 没有）+ 内核 `DEFAULT_MAX_TOKENS = 128e3` | asar 108726062 / 108713723 / 144767960；header seq 36167 vs 25354 |
| 5 | 该 400 被当成"上下文溢出" | 内核溢出正则误命中 `exceeds the limit of \d+` | 误分类为 `CONTEXT_WINDOW_EXCEEDED` | SESSION 里 `failure.code = "CONTEXT_WINDOW_EXCEEDED"` 而 message 是输出上限 |
| 6 | 该 400 之后没有降级 | 本 profile `triggerCodes` 不含 `CONTEXT_WINDOW_EXCEEDED` | 配置与内核错误分类不一致 | `cordis.patch.yml` triggerCodes 列表 |
| 7 | 「只有 trae 能用」 | nvidia/amd 的失败 **100%** 命中 triggerCodes → 每次必崩；trae 60%、agnes/llm-pi-ai 0% | 见 §4 | attempt 级统计（nvidia 16/16 trigger，trae 6/10，agnes 0/1） |
| 8 | 切到 `FallbacksChain/Auto` 也报 `proposed "amd/DeepSeek-V4.1-Flash" fixed "FallbacksChain/Auto"` | 虚拟适配器已注册，但 `agent/request` 钩子仍在 | 0.6.13 两套机制并存，旧钩子毁掉新适配器 | turn 84，seq 19946-19961 |

---

## 8. 「为什么只有 trae 能用」——结论

**结论（分级表述）：**

1. **确定**：只要失败码落在 `triggerCodes` 里，插件就会改写 provider/model，内核就会抛错，**整轮 turn 必死**。这是 9/9 实测、无例外的硬机制。
2. **确定**：各 provider 的 `triggerCodes` 失败率极度不均 —— nvidia 16/16（100%）、amd 2/2（100%）、trae 6/10（60%）、workbuddy 2/5（40%）、agnes 0/1、llm-pi-ai 0/2。
3. **因此（高置信）**："nvidia/amd 一用就报 `use agent.model.select()`" 与 "agnes 报 400 但不报那句" 都是 1+2 的必然结果，而不是模型本身好坏。
4. **因此（高置信）**："trae 能用" 的主因是 **trae 是健康度最高（61/67 完成）+ trigger-code 失败占比最低 + 是 profile 默认模型**，所以绝大多数轮次根本走不到崩溃分支。
5. **证据不足**：无法证明"用户每次切到非 trae 模型都必然失败"。样本里 `deepseek-account` 8/8 全成功且失败率 0（但它不在可选链里，只在会话早期出现）；`llm-pi-ai` 只有 1 个 turn，统计无意义。
6. **未验证**：trae 的账号池轮换（`setRotatedAccount` / `pooled account`）是否在 adapter 内部消化了部分 QUOTA/RATE_LIMIT 失败。若成立会进一步抬高 trae 存活率，但本报告未取得该路径的实测触发记录。

**已排除的假设**：
- ❌ trae 不在 `rootChain` 所以不被插件碰 → turn 113/140 直接反证（trae 被改写并崩溃）。
- ❌ trae 自带 adapter/降级逻辑绕过 fallbacks → trae 不注册任何 `agent/request*` 钩子，无法阻止改写。
- ❌ trae 从不失败 → 10 次 attempt 失败、6 次命中 triggerCodes。

---

## 9. 自研替代插件必须使用的正确 API 清单

> 这一节可以直接拿去写代码。所有签名均来自 asar 内的 types 声明。

### 9.1 路由切换（唯一合法方式）

| 项 | 值 |
|---|---|
| 服务 | **无 ctx 服务名**。是每个 Agent 实例上的对象：`agent.model`（类型 `Model`） |
| 获取方式 | `ctx.get("agents")?.get(sessionId)`；或从 `agent/*` 事件载荷取 `agent`；或 `ctx.agents.list()` |
| 方法 | `current(): Readonly<ModelSelection> \| undefined` / `select(selection: Readonly<ModelSelection>): void` |
| 入参 | `{ provider: string; model: string; reasoningEffort?: ReasoningEffortId }` |
| 时机 | **必须在目标步的 `preStep()` 读取 `model.current()` 之前**。实践中：① 在上一轮 `turn/end` 之后；② 在 `agent/request-error` 里（只对**下一步**生效，对本次重试无效）；③ 由 UI/定时器触发 |
| 副作用 | 追加 durable `session` 事件 `model/selection`；投影 `modelSelection.pending = 新值`；下一个 `preStep` 会追加一条 `[model changed: A → B]` 的 `user/message`（`source.kind="model-selection"`） |
| 禁止 | ❌ 在 `agent/request` waterfall 里改 `proposedConfig.provider/model`（内核硬校验直接抛错）；❌ 在 `agent/pre-step` 监听器里指望改当前步（selection 已冻结） |

**推荐写法 A（要在同一次请求内换模型 → 不要用 select，用虚拟 adapter）：**

```js
// 1) 注册一个虚拟 provider 路由
const handle = ctx.llm.registerAdapter(["MyChain"], adapter);   // 返回 disposer，带 .replace(routes)
// 2) 让用户把 selection 选到 MyChain/Auto（agent.model.select）
// 3) 在 adapter.stream(options) 内部循环换真实 provider —— 这是唯一能"失败即换、不中断"的位置
```

**推荐写法 B（必须用 select 时，选择合法时机）：**

```js
// 在 turn 之间 / 下一个 step 之前切换；不要试图救当前请求
ctx.on("agent/request-error", async ({ agent, turn, step, failure }, next) => {
    // 只记录意图；真正的切换必须发生在下一步之前
    // 直接在这里 select() 只会影响下一个 step，本 step 的重试仍用旧 selection
    agent.model.select({ provider: nextRoute.provider, model: nextRoute.model });
    return next();          // 不要返回 {kind:"retry"} 去"配合"改写 —— 会撞校验
});
```

### 9.2 虚拟适配器（0.7.0 的正确范式）

| 项 | 值 |
|---|---|
| 服务 | `ctx.llm`（`LlmRuntime extends TypertRemoteService`） |
| 方法 | `registerAdapter(providers: string[], adapter: LlmAdapter): AdapterRegistrationHandle` |
| 语义 | 任一 provider 已被注册则整体抛 `LlmError(code="DUPLICATE_ADAPTER")`（all-or-nothing）；随 fiber 释放 |
| 返回句柄 | `handle()` 释放；`handle.replace(routes)` 换路由集（已释放则抛 `REGISTRATION_DISPOSED`） |
| 需实现的 `LlmAdapter` 方法 | `providerInfo(provider)` / `listModels(provider)` / `resolveModel(provider, model, signal)` / `prepareCall(provider, model, signal)` → `{ model: LlmResolvedModelInfo, stream }` / `stream(options)` / `providerRetryPolicy(provider)` / `imageRequestPricing(provider, model)` / `imageRequestTarget(provider, model, image)` |
| `LlmResolvedModelInfo` 关键字段 | `context?: {contextWindow}`、**`defaultMaxTokens?: number`**、`reasoning?: {efforts, defaultEffort}`、`inputModalities`、`systemPromptUpdate`、`toolUpdate` |
| 换 provider 的位置 | `adapter.stream(options)` 内部：`llm.stream({ ...options, provider: target.provider, model: target.model })`，用 `for await` 读 chunk，遇到 `chunk.reason.kind === "error"` 且 `!committed` 时切下一个（**已 yield 过内容就不能切**） |

### 9.3 能力适配（必须自己做的，插件没做）

| 项 | 做法 |
|---|---|
| 输出上限 | 切 provider **前**用 `llm.resolveModelInfo(provider, model)` 或 `llm.listModels(provider)` 读目标模型的 `defaultMaxTokens` / `maxTokens`，**显式**写进请求 config 的 `maxTokens`；不要依赖 provider 级 `defaultMaxTokens`（默认 128000，会把 Agnes 这类 65536 上限的端点打挂） |
| 上下文容量 | 读 `context.contextWindow`；内核 `compaction-basic` 的 model-switch 检查会在**下一个请求**做 `MODEL_SWITCH_COMPACTION_FAILED` 校验 |
| reasoningEffort | 目标模型不支持时必须**显式删除**（参考 `overrideConfigWithRouteRule` 的 route-changed 规则），否则 `prepareRequest` 的第二个硬校验会抛 `proposed reasoning effort ...` |
| 错误分类 | 不要用 `CONTEXT_WINDOW_EXCEEDED` 判断"上下文不够" —— 内核会把 `400 ... exceeds the limit of N`（输出上限）也标成它 |

### 9.4 事件与钩子的正确用途（别再用来改路由）

| 钩子 | 允许做什么 | 禁止做什么 |
|---|---|---|
| `agent/request` (waterfall) | 只读观察；可改 **非路由** 控制项（如 `maxTokens`，需自行保证目标模型支持） | ❌ 改 `provider`/`model`/`reasoningEffort` |
| `agent/request-error` (waterfall) | 决定是否 `return {kind:"retry"}`；`select()` 只对下一步生效 | ❌ 指望 `retry` 能带着新模型重试 |
| `agent/pre-step` (waterfall) | 注入消息、persona、通知 | ❌ 改当前步的 selection（已冻结） |
| `agent/pre-step` 之后 / `turn/end` | ✅ `agent.model.select()` 的合法窗口 | — |

---

## 10. 可执行建议（按优先级）

1. **立刻止血（不改代码）**：把 `cordis.patch.yml` 里 `llm-fallbacks` 的 `triggerCodes` 清空或把该插件行 `disabled: true`。空 `triggerCodes` 会让 `agent/request-error` 钩子在第一行就 `return next()`，`agent/request` 钩子也拿不到 pending，**报错立即消失**，代价是没有自动降级。
2. **短期修配置**：给 `llm-pi-ai` 的 `agnes-3.0-flash` 补 `maxTokens: 65536`（对齐 `agnes:`/`agnes-backup:`），消除 400。
3. **中期升级到 0.7.0**：结构上消灭该报错；但**必须同时**把 selection 切到 `FallbacksChain/Auto` 并修 `timeSlots`/`rootChain`（当前 15:42 属 `liang-peak`，链头是实测 2/4 失败的 `amd/Qwen3.8-Flash-Next`）。
4. **自研替代**：按 §9 写虚拟 adapter，**不要**碰 `agent/request` 的 provider/model。

---

## 附录 A：复现脚本

```powershell
# 1) 在内核里定位校验点
$code = @'
const fs=require("fs");
const s=fs.readFileSync("D:\\AI app\\DSH\\resources\\app.asar").toString("latin1");
const i=s.indexOf("after step preparation fixed");
console.log(i);                                   // 19446156
console.log(s.substr(i-1200, 2600).replace(/\r/g,""));
'@
$code | node --max-old-space-size=4096 -

# 2) 解压会话日志做统计
$code = @'
const fs=require("fs"), zlib=require("zlib");
const f="D:\\AI agent cache\\dsh\\sessions\\--D-AI~0020sandbox-dsh-sandbox-DSH~0020Optimize--\\session-b374638f-a5a1-4d75-bf57-fc2518174b0e\\session.v4.jsonl.zstd";
const evs=zlib.zstdDecompressSync(fs.readFileSync(f)).toString("utf8").split("\n").filter(Boolean).map(l=>JSON.parse(l));
console.log("events:", evs.length);
'@
$code | node --max-old-space-size=6144 -

# 3) 对比 0.7.0（只下载，不安装）
cd $env:TEMP; mkdir fb070 -Force; cd fb070
& "D:\Node\npm.cmd" pack dsh-llm-fallbacks@0.7.0 --silent
tar -xzf dsh-llm-fallbacks-0.7.0.tgz
```

## 附录 B：本报告未能验证的项

- `dsh-connect-trae` 账号池轮换在真实限流下的触发与成功率（代码存在，未取到实测记录）。
- `deepseek-account` 为何 8/8 全成功、且不在可选模型列表里（可能是会话早期残留 selection）。
- 0.7.0 在实际 profile 中的运行行为（**按要求未安装**，仅静态对比）。
