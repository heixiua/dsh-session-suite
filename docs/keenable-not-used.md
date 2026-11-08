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

> 顺带：用户截图那个 `session-662585fd` 创建于 11/6 16:32，而 keenable 是 11/8 11:00 才装的。**旧会话本来也不会自动获得新工具**，这是次要因素；但 `listTools` 是实时视图里也没有，说明主因在注册本身。

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
2. **开一个新会话**再测。当前会话 `session-b374638f`（11/5 创建）和截图那个 `session-662585fd`（11/6 创建）都早于插件安装，工具列表不会追溯刷新；在旧会话里即使重启也未必能看到新工具。
3. 重启后可以在新会话里输入 `/fallbacks` 类似的诊断，或直接让 agent 搜一句话，确认它调的是 `keenable_search` 而不是 `web_search`。

## 附：官方 `web_search` 为什么报错

它读的是 `DEEPSEEK_API_KEY`，`.env` 里只有注释掉的 `# DEEPSEEK_SEARCH_KEY=sk-…` 和 `DEEPSEEK_MODEL`，没有 `DEEPSEEK_API_KEY`。所以只要 agent 选了官方工具就必失败。修好 keenable 后两个工具仍会并存——如果希望 agent **只**用 keenable，可以在设置页关掉官方 web-search 行（`web-search-deepseek` / `tool-web`），或给官方工具配上 key。当前先不改动，因为 keenable 修好后 agent 有得选，且关官方工具会影响别的功能。
