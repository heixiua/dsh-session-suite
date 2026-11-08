# 0.7.0 升级后的五个问题

日期：2026-11-08 ｜ 环境：`dsh-llm-fallbacks@0.7.0`（已装）、DSH 0.2.2-rc.1

## 1. 弹窗：`检测到旧模式配置字段（alwaysModeRetryCap, roleAutoMatch）`

**这两个键在 0.7.0 里已经完全移除了，运行时不读取，只是被检测出来提示你迁移。**

源码证据（`x/fb-070/package/dist/index.js`）：

```js
const CONFIG_KEYS = {          // 0.7.0 实际生效的键，共 10 个
  triggerCodes, rootChain, roles, cooldownMs, revertPolicy,
  maxSwitchesPerStep, presets, timeSlots, tz, recovery
};                             // ← 没有 alwaysModeRetryCap / roleAutoMatch

function detectLegacyKeys(source) {   // 只用于弹窗，不参与任何行为
  if (Object.hasOwn(source, "chains")) keys.push("chains");
  if (Object.hasOwn(source, "alwaysModeRetryCap")) keys.push("alwaysModeRetryCap");
  if (Object.hasOwn(source, "roleAutoMatch")) keys.push("roleAutoMatch");
  ...
}
```

`config.d.ts` 第 186 行也注明：「the removed always-mode retry cap and dispatch role-auto-match keys（`alwaysModeRetryCap` / `roleAutoMatch` — direction C, virtual-chain-only fallback）」。

**已处理**：从 `cordis.patch.yml` 第 453/455 行删掉这两行。验证脚本 `tools/_verify-legacy-clean.mjs` 用与插件相同的检查逻辑复核，`detectLegacyKeys` 会标记的 6 类键现在全部为 `ok`，10 个生效键全部在位。

> 弹窗里的「请按 docs/configuration.md 迁移表手工改写」有点误导：npm 包里**并没有** `docs/configuration.md`（只有 README），迁移表实际在 `dist/config.d.ts` 的注释里。结论很简单：**没有替代键，直接删掉即可**。删掉后行为不变，弹窗消失。

## 2. 三个分时槽：调好了，没有空档，但有一个设计上的重叠

0.7.0 的预设窗口（`PRESETS` 常量）：

| 预设 | 窗口 | complement |
|---|---|---|
| `liang-peak` | 周一至周五 09:00–12:00、14:00–18:00 | false（命中窗口内） |
| `liang-valley` | 同上 | **true**（命中窗口外，即取补集） |

你的三个槽（配置顺序 = 优先级，**第一个命中生效**）：

1. `三更半夜`：custom，00:00–08:59，每天
2. `梁文峰`：`liang-peak`
3. `梁文谷`：`liang-valley`

实测一周 168 个小时采样（`tools/_probe-slots.mjs`）：

- **gaps = 0**：任何时刻都有槽命中，不会掉回 `rootChain`
- **overlaps = 63**：`三更半夜` 与 `梁文谷` 在 00:00–08:59 每天重叠 9 小时；因为 custom 排第一，总是 `三更半夜` 抢到，`梁文谷` 拿不到夜间
- 工作日 09:00–12:00 / 14:00–18:00 → `梁文峰`
- 工作日 12:01–13:59、18:01–23:59、周末 09:00 之后 → `梁文谷`
- 当前（周日 20:xx）→ `梁文谷`，**与截图里「梁文谷 激活」一致**

**结论：逻辑正确、已生效。** 唯一要注意的是那 63 小时重叠：如果你本意是「梁文谷 = 除了三更半夜和梁文峰之外的所有时间」（截图里梁文谷的说明确实是「Liang Peak 之外的所有时间」），那现在就是这样，只是被 custom 抢走了夜间——`梁文谷` 说明文字里的「所有时间」实际不含 00:00–08:59。这不是 bug，但说明文字与行为有出入，可以改名/改说明让它更清楚。

另外截图里 `梁文峰` 标了「高消耗 ×2」，这是 UI 对链头的成本提示，不是配置错误。

## 3. 备份已清空

删除了 21 个路径（约 52 MB）：

- profile 下 11 个 `.bak*` 文件（`cordis.patch.yml.bak-*` / `package.json.bak-*` / `pnpm-lock.yaml.bak-*` / `pnpm-workspace.yaml.bak-*`）
- profile 下 8 个备份目录（`_plugin-backup-*` / `_repair-backup-*`）
- 工作区下 `_memory-backup/` 和 `_subagent-backup-20261108/`

清理后复核：运行中的 `cordis.patch.yml` 完好（`amd` compat、`streamIdleTimeoutMs: 300000`×3、19 个 bundles 都在），0 个备份文件/目录残留。

## 4. 「角色实体」和「子代理」是什么

这**两个页面都属于 `dsh-llm-fallbacks` 插件**，不是 DSH 自带的。

### 角色实体（roles.list）

**它不是一个独立的 agent，也不创建任何东西。** 它只是给「子智能体」准备一张人设 + 一条专用降级链的**查找表**：

- `id`（task / sonic / scout / reviewer / security-reviewer）= 名字
- `persona` = 一段人设文本，命中该角色时注入到子智能体的系统提示里
- `chain` = 这个角色专用的模型降级链
- `fallback: inherit-root` = 角色链用尽后追加 `rootChain`

`roles.rules` 是「什么子智能体映射到什么角色」的规则，你的配置里是 `[]`（空），所以**目前没有任何子智能体会自动套用这些角色**——除非插件按 label 自动关联（0.7.0 已移除 `roleAutoMatch`，见第 1 项）。

截图里那句黄色的「角色链或默认降级链有未保存的修改 — 请先保存再同步」是 UI 提示：**改了角色链要先点右上「保存」，再点「同步到宿主允许列表」**，两步都要做，改动才会写进 DSH 的子智能体允许列表。

### 子代理（DSH 自带那页）

第 4 张截图是 **DSH Host 自带**的 `@deepseek-ai/dsh-tool-subagent` 设置页，和 fallbacks 的角色实体是两回事：

- **最大递归深度 1**：子智能体不能再开子智能体
- **子智能体并行数量上限 8**：同时最多 8 个
- **允许 Agent 为子智能体选择模型（开）**：主 Agent 可以从下面的允许列表里，给每个子智能体挑 provider / 模型 / 推理强度
- 下面的复选框 = 允许列表。截图里只勾了 `FallbacksChain/Auto` 和 `Agnes 3.0 Flash` 两项

**两者怎么串起来**：fallbacks 会读 DSH 这张允许列表（源码 `mergedAllowlist` / `subagent/model-selection-policy`），把角色链里的候选路由合并进去。所以「角色实体页的同步」按钮，就是把角色链里的模型写进第 4 张图那张允许列表。

**一句话**：角色实体 = fallbacks 给子智能体用的「人设+链」配置；子代理页 = DSH 管「能开几个、能用哪些模型」。前者通过「同步」写进后者的允许列表。

## 5. 会不会和 DSH 自带子智能体插件冲突？

**不会冲突，是设计好的共存关系。** 逐项核对 0.7.0 源码：

| 检查项 | 结果 |
|---|---|
| `tools.register` | **0 次**——fallbacks 不注册任何工具，不会和 `subagent` / `list_agents` 抢名字 |
| 服务名 | 只 `provide("llm-fallbacks")`，命名空间独立 |
| 子智能体服务 | 源码里 `subagentModelSelection` **0 次**；它通过 `ctx.get("agents")` 和 `subagent/model-selection-policy` 事件**读** Host 的允许列表，不注册同名服务 |
| 虚拟适配器 | `llm.registerAdapter(["FallbacksChain"], adapter)` 1 次，只占 `FallbacksChain` 一个 provider 名 |
| 路由改写 | **0 次** `agent/request` 钩子（这是 0.6.13 抛错的那条路径，0.7.0 已删）；也不调用 `agent.model.select()` |
| 人设注入 | 用内核公开的 `PERSONA_PREFIX_SECTION`（`@deepseek-ai/dsh-system-prompt`），且源码明确：若该 section 已存在就**主动退让**并记日志「already exists in its scope」，不覆盖、不报错 |
| 监听的事件 | `agent/pre-step`（只发一次角色提示）、`agent/created`、`agent/disposed`、1 个 `session/*`——都是观察/补充，不改路由 |

**唯一真实的交叠点**：两边都往子智能体的系统提示里写东西。但 fallbacks 用的是同名 section + 显式退让，所以最坏情况只是「人设没注入，子智能体照常跑」（源码 `contain()` 里写得很清楚：失败时 contained，child runs unchanged），不会崩、不会让会话失败。

**一个值得注意的细节**：第 4 张图里允许列表只勾了 2 项，而角色链里有一堆 amd / workbuddy / nvidia 模型。0.7.0 会在切换前用允许列表过滤候选（`decide()` 里的 `policy.state === "enabled"` → `firstAllowedCandidate`，全是列表外就记日志「blocked: resolved candidates are all outside the subagent allowlist — no switch」并放弃降级）。**所以对子智能体来说，如果允许列表不补全，角色链里大部分模型永远用不上**——这就是角色实体页那个「同步」按钮存在的意义。建议：想要角色链真正生效，就在角色实体页点「保存」→「同步到宿主允许列表」，然后回子代理页确认复选框。

---

## 需要你做的

1. **完全退出 DSH 再重启**（HMR 已关，配置和删掉的旧字段都要重启才生效）。重启后弹窗应消失。
2. 如果想让子智能体角色链真正可用：角色实体页 → 保存 → 同步到宿主允许列表 → 子代理页确认允许列表勾选。
3. 分时槽不用再调，当前状态是对的。
