# dsh-keenable-search 为什么没被 agent 用上

日期：2026-11-08 ｜ 结论：**插件行是 active，但两个工具从未注册到 agent 可见的工具列表**

## 症状

截图里 agent 说「let me first do a fact-check search on the platforms」，然后调用的是官方 `web_search`，报：

```
Error: DeepSeek search has no API key for "DEEPSEEK_API_KEY"; store it through
the credentials service (the web Models page writes it), export it in the launchi…
```

## 实测证据（不是猜测）

### 1. 包、配置、挂载全都正常

| 检查 | 结果 |
|---|---|
| `node_modules/dsh-keenable-search` | 存在，v0.1.0，`file:` 本地依赖 |
| `package.json` bundles + dependencies | 都有 `dsh-keenable-search` |
| `plugin_manager` 的 `include:keenable-search` | **`enabled: true, fiberPhase: "active"`** |
| 自带的 `cordis.patch.yml` | `- insert:` + `name: dsh-keenable-search`，与 session-suite 语法一致 |
| `node tools/test-installed.mjs` | **RESULT: INSTALLED PACKAGE LOADS CORRECTLY**，fake ctx 下两个工具都注册 |
| `.env` 的 `KEENABLE_API_KEY` | 存在，80 字符 `keen_aot…` |
| `node tools/test-live.mjs` | **RESULT: ALL LIVE TESTS PASSED** —— 真实搜索返回结果、site 过滤生效、AUTH/TIMEOUT 结构化 |

### 2. 但 agent 从来没看到这两个工具

- `cordis_inspect Tool.listTools`（**当前实时**视图，104 个工具）：有 `web_search` / `web_fetch`，**没有** `keenable_search` / `keenable_fetch`，全文搜 "keenable" 0 命中。
- 全部 21 个会话日志：`keenable_search` / `keenable_fetch` **调用 0 次**；`web_search` 调用 13 次，其中 19 条结果含 "DeepSeek search has no API key"。
- 当前会话 `session-b374638f` 的 `request/header`：从 seq=14（36 个工具）到 seq=42795（93 个工具），`web_search` 一直在，`keenable_*` 一次都没出现。`memory` 工具是通过 `developer/message` 的 `tool-addition` 动态加入的，说明工具列表是会变的——不是"旧会话快照"能完全解释的。

> 顺带：用户截图那个 `session-662585fd` 创建于 11/6 16:32，而 keenable 是 11/8 11:00 才装的。这一点当时被我误当成"旧会话拿不到新工具"的次要因素——**这个判断是错的，见下节更正**。

### 更正：会话创建时间与工具可见性无关

初版结论曾建议"开一个新会话再测"，理由是这两个会话早于插件安装。**用户当场反问：装其他插件时现有会话里会注入新工具。** 复查内核 `buildRequest()`（`app.asar` 偏移 ~19,448,489）证明用户是对的：

```js
const previousNames = new Set(baseline.tools?.map(t => t.name))
const currentNames  = new Set(tools.map(t => t.name))
const additions = tools.filter(t => !previousNames.has(t.name))
if (additions.length > 0 || removals.length > 0)
  session.append("developer/message", {
    message: createDeveloperMessage({ source: {kind:"tool-registry"}, content: [...additions, ...removals] })
  }, { surfaceOp: "append" })
```

**工具列表每次请求都从 tools 服务重新取全量并 diff**，不快照、不绑定会话创建时间。新增工具会在下一次 `buildRequest` 写成 `request/header(reason:"change")` + `developer/message(tool-addition)`，正在运行的会话立刻可见。

实测佐证（`tools/_probe-midsession.mjs`）：`session-662585fd`（11/6 创建）在 turn 15 / 42 / 47 分别中途注入了 canvas 全套工具、`memory`、`computer_*`；`session-6738439d` 在 turn 6 一次注入 40 个工具；`session-b374638f` 有 82 次 `request/header reason="change"`。会话全程没换。

所以正确因果是：

- 其他插件：**真的注册进了 tools 服务** → diff 有新增 → 现有会话立刻出现工具
- keenable：**从未注册进 tools 服务** → diff 永远为空 → 重启/新会话都看不到

**结论：不需要开新会话。** 修好 `inject` 并完全重启 DSH 后，当前会话的下一次请求就会出现 `keenable_search`，日志里会多一条 `tool-addition`。开新会话只是保险，不是必要条件。

当时误判的原因：把「`listTools` 实时视图里没有」和「会话早于插件安装」两个现象凑成了因果，而没追问实时视图为什么也没有——那正是注册失败本身的证据。

## 根因：`inject = []`

对比同 profile 里其他能贡献工具的插件：

| 插件 | `inject` | 工具可见 |
|---|---|---|
| `@restregular/dsh-computer-use` | `['tools']` | ✅ `computer_screenshot` 等 |
| `@ninkch/dsh-infinite-canvas` | `['webServer', 'tools']` | ✅ `canvas_*` |
| **`dsh-keenable-search`（修复前）** | **`[]`** | ❌ |

`index.js` 原注释写着「The tool registry is reachable without injection (it is looked up with `ctx.get('tools')`)」——**这个假设是错的**。`apply()` 里：

```js
const tools = ctx.get('tools')
if (!tools?.register) {
  log('tools service unavailable; keenable_search not registered')
  return                       // ← 静默返回，不抛异常
}
```

因为没声明 `inject: ['tools']`，该 fiber 上 `ctx.get('tools')` 拿不到服务，于是走 fail-soft `return`。结果就是最迷惑人的状态：**行 active、包能 import、fake ctx 能注册、但真实 Host 一个工具都没挂上**。而源码故意把失败设计成不抛异常（为了防止拖垮 bundle），正好让它静默失效。

`ctx.get` 的 inject 门控在 `app.asar` 偏移 ~18,802,323 有明确实现：`cannot get property "X" without inject`。本 profile 历史上 0.6.2 那次 Host 崩溃也是同一个机制（timer 未 inject）。

## 修复

`keenable_search/index.js`：

```js
export const inject = ['tools']   // 原为 []
```

并同步：
- `tools/test-contract.mjs` 加断言 `inject.includes('tools')`，防止回归（原来的 fake-ctx 测试无条件提供 tools，所以旧 bug 测不出来——这正是它能溜过去的原因）。
- 源码注释改成记录这次实测结论。
- 通过 `pnpm install` 正规重装到 profile（**没有**手拷文件进 node_modules 后就算完；重装后验证 19 个 bundles、`amd` compat、legacy 键、allowBuilds 全部完好，session-suite 仍是 0.10.1）。

验证：`test-contract` / `test-installed` / `test-live` 全部通过。

## 还需要你做的

1. **完全退出 DSH 再重启**（HMR 已关；`inject` 是加载期契约，重启才生效）。
2. 重启后**在当前会话**里直接让 agent 搜一句话即可——工具列表每次请求动态重算，不需要开新会话。确认它调的是 `keenable_search` 而不是 `web_search`；日志里会出现一条 `tool-addition` 记录。开新会话只是保险，不是必要条件。

## 附：官方 `web_search` 为什么报错

它读的是 `DEEPSEEK_API_KEY`，`.env` 里只有注释掉的 `# DEEPSEEK_SEARCH_KEY=sk-…` 和 `DEEPSEEK_MODEL`，没有 `DEEPSEEK_API_KEY`。所以只要 agent 选了官方工具就必失败。修好 keenable 后两个工具仍会并存——如果希望 agent **只**用 keenable，可以在设置页关掉官方 web-search 行（`web-search-deepseek` / `tool-web`），或给官方工具配上 key。当前先不改动，因为 keenable 修好后 agent 有得选，且关官方工具会影响别的功能。
