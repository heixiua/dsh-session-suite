# dsh-fish-memory 架构分析

> 分析对象：`dsh-fish-memory@1.5.5`（Yuuyuko-uu，455★，1.6 万下载）
> 方法：直接读 `lib/index.js`（378 KB）与 `lib/client.js`（250 KB）源码，不靠猜测。
> 目的：找出我们做错的地方，以及可以**改造借鉴**（不照抄）的设计。

---

## 一、结论先行：我们的隐式提取方向从一开始就错了

**我们做了 7 轮的「每轮结束后调模型抽取记忆」，而 fish-memory 根本没有这个管线。**

它的机制是：

```
模型在对话中自己判断「这件事值得记」
        ↓
调用 remember 工具（模型主动，不是插件主动）
        ↓
工具 description 就是全部策略
```

`agent/turn-stopping` 在它那里**不生成任何记忆**，只做一件事：

```
assembled → consumed   （追踪「这轮召回的记忆有没有真的被用上」）
```

**这就是为什么我们修了 7 次都不成功**——我们在实现一个它根本没做的东西，而且
DSH 的 agent 作用域事件在我们的上下文里触发不了。方向错了，修多少次都不会对。

---

## 二、它是怎么注入记忆的（核心机制）

### 2.1 注册位置：`agent.ctx`，不是插件根 ctx

```js
const 注入off = agent.ctx.systemPrompt.context({
  name: 'memory',
  order: 900,
  interpolate: false,        // ← 关键，见 2.3
  text: () => { ... }
})
```

**必须在 agent 的上下文上注册。** 插件根 `ctx` 上的注册在 Cordis 作用域过滤下拿不到
该 agent 的会话——这正是我们之前监听器「注册成功但永不触发」的同一个根因。

### 2.2 `text()` 会被调用很多次，必须缓存

源码注释（实测数据）：

> **同一次请求里 `text()` 会被调 3~4 遍（实测平均 5.9 遍，长思考时到 24 遍）**。
> 每一遍都要重新检索整库 + 写一条 trace + 整份 saveStore（库 230KB 时就是 4 倍写盘）。

它的做法：按 `sid|query` 缓存 **1.5 秒**，并发进来的那几遍直接复用第一次结果。

**我们的实现**：`recallByScope` + `RECALL_TTL_MS` 缓存，但缓存键是 agent 对象，
**没有包含 query**。这意味着同一请求内 query 变了仍可能复用旧结果。这是可以改进的点。

### 2.3 `interpolate: false` —— 我们缺的防崩开关

源码注释：

> 宿主的 context / section 默认会做变量替换：`{{time}}` 这种会被当成变量名，
> 查不到就抛 `unknown prompt variable` —— **记忆里只要存了一句带双花括号的话**
> （代码片段、模板、日志都可能有），**整间会话每一轮都直接失败**，用户只能关插件。

**这是一个真实的崩溃级隐患。** 我们的记忆内容来自用户对话，完全可能包含 `{{...}}`
（写代码、写模板、贴日志时）。**我们必须加这个开关。**

### 2.4 查询词从哪来

```js
let query = 清掉注入上下文(选查询词(lastUserTextOf(agent.session), lastText))
```

**监听优先，会话兜底。** 原因（源码注释）：

> `systemPrompt.context` 的 `text()` 是**请求装配时**求值的，而这一轮的 user 消息
> 要等装配完才落进 session —— 所以「会话里最后一条」拿到的其实是**上一轮**。

它用 `agent/inbox/inserted` 收到的 `lastText` 才是这一轮的真话。

**我们不需要这个**：我们在 `agent/pre-step` 里拿 `decision.messages`，那是**本轮**
的消息，时序是对的。这是我们的做法优于它的地方。

### 2.5 剥离注入的内部上下文

```js
清掉注入上下文(文)   // 剥掉 "Current runtime context." / "Time sampled …" 这类行
```

宿主会往 user 消息里夹运行环境信息，拿它检索噪声比正文还大。

**我们已经做了**（`isUserAuthored()` 白名单 `source.kind`），这点是对的。

### 2.6 短句借上文

```js
if (query.trim().length < 6) query = 补线索(query, 最近几句(agent.session, 3))
```

一两个字（「推」「在吗」）单独搜什么都搜不到。

**我们的实现**：`contextualQuery()` 用代词检测 + 字符预算。**默认关闭**（0.5.1 起）。
它的做法更简单直接（按长度），我们的是按代词——各有道理，我们的更精确但要开才生效。

---

## 三、它的底层架构

### 3.1 存储布局

```
$DSH_HOME/
├── fish-memory/
│   └── <sessionId>.json          # 每个会话一个库文件
├── fish-memory-backup/           # 备份
├── fish-memory-config.json       # 全局配置
├── fish-memory-diag.log          # 诊断日志（它自己写的）
└── sessions/                     # 它读这里来算工作区键
```

**按会话分文件**，不是按工作区分。这意味着：
- 会话之间记忆隔离（它的产品定位是「AI 伴侣」，每个会话一个「她」）
- 删会话不会连带删记忆库（它注释里明确说了这点）

**我们的设计**：按工作区 + 全局两个库。**这是不同的产品定位，不是谁对谁错**：
- 它：每个会话一个 AI 伴侣，记忆独立
- 我们：跨会话的稳定事实，按工作区共享

### 3.2 挂载方式：500ms 轮询

```js
ctx.effect(() => ctx.interval(tick, 500))
```

`tick` 里调 `agents.list()`，发现新 agent 就 `mountFor(agent, sid)`。

**关键点**（源码注释，它踩过坑）：

> **agent 实例是会被换掉的**（会话重开、插件重载、宿主重建 agent 都会换一个新对象），
> 旧注册跟着旧 ctx 一起没了，而我们这边的账还写着「已挂上」⇒ 永远不重挂。

**为什么它轮询不出事，我们轮询崩了 Host？**

| | 它 | 我们（0.6.1） |
|---|---|---|
| `inject` | 含 **`timer`** | **只有 `connection`** |
| tick 体 | 内部 `try/catch` 包住 | **裸调，异常直接冒出去** |
| 结果 | 正常 | 每 500ms 抛 `cannot get property "timer" without inject` → 崩进程 |

**教训**：不是「轮询」这个做法有毒，是我们**没 inject 依赖服务**且**没包异常**。

### 3.3 路由与 client

```
HTTP: /dsh-fish-memory/list 等
client: dsh.client.inject = ['slots']
```

它的 `cordis.patch.yml` **极简**：

```yaml
- insert:
    - id: memory
      name: dsh-fish-memory
```

**没有 config 段。** 所有配置在运行时通过 `fish-memory-config.json` 和 UI 管理，
不走 patch。这样升级时 patch 不会冲突。

**我们的做法**：patch 里有大量 config（`keep`、`recallLimit`、`contextQueryChars`…）。
**各有优劣**：
- 它的：升级无冲突，但配置项在 UI 里，难以版本化
- 我们的：patch 可版本化、可审计，但升级时若用户改过 patch 会冲突

### 3.4 UI 设计（client.js）

250 KB 的单文件，`inject: ['slots']`。注册的 UI 主要是：
- 设置页（六页毛玻璃界面）
- 一个独立 HTML 页（`MEMORY_PAGE`，内联在 index.js 里，约 20 KB）
- 侧边栏入口

**它的 UI 特征**：
- **设置页分多页**（概览 / 策略 / 记忆库 / 日志 / 备份 / 高级）
- 策略参数**全部暴露给用户**（`baseHalfLifeDays`、`emotionHalfLifeDays`、`threshold`、
  `maxItems`、`dailyQuota`、`rarityK`、`queryGate`）
- 有**独立记忆浏览页**（内联 HTML，不走 React）

**我们可借鉴的 UI 设计**（改造，不是照抄）：
1. **策略参数暴露**：我们的衰减天数、压缩线、归档线目前是 patch 配置，UI 里改不了。
   可以做成设置项。
2. **记忆浏览页**：我们已有（面板里的记忆列表），但它的独立页更完整。

---

## 四、我们的插件可以怎么改（不照抄）

### P0 — 必须修（真实隐患）

| # | 问题 | 修法 | 理由 |
|---|---|---|---|
| 1 | **`systemPrompt.context` 没有 `interpolate: false`** | 加这个开关 | 记忆里含 `{{...}}` 会崩整间会话 |
| 2 | **recall 缓存键不含 query** | 缓存键改为 `agent + query` | 同一请求内 query 变了会复用旧结果 |

### P1 — 值得改进

| # | 问题 | 修法 |
|---|---|---|
| 3 | 记忆工具的 description 太弱 | 补上「一条一件事」「什么值得记」「不要汇报」等策略（**用我们自己的措辞**） |
| 4 | 策略参数只能在 patch 里改 | 暴露到设置 UI |

### 不做（它是它的产品定位，不是我们的）

| 项 | 为什么不做 |
|---|---|
| 按会话分库 | 我们做的是跨会话的稳定事实，按工作区共享才对 |
| 500ms 轮询挂载 | 我们是单次注册（agent/pre-step 已在工作），不需要轮询 |
| 自更新机制 | 它会从仓库拉新版本并热重载——**安全风险**，我们不引入 |
| 每会话一个「她」的人设 | 那是 AI 伴侣产品，我们是工具 |

---

## 五、关键数据（供以后查）

| 项 | 值 |
|---|---|
| 包名 | `dsh-fish-memory` |
| 版本 | 1.5.5 |
| 仓库 | github.com/Yuuyuko-uu/dsh-fish-memory |
| 文件规模 | index.js 378 KB / client.js 250 KB |
| `inject` | `['systemPrompt','agents','timer','tools','webServer','sessions','sessionTitle','llm']` |
| 注入点 | `agent.ctx.systemPrompt.context({name:'memory', order:900, interpolate:false})` |
| 挂载 | `ctx.effect(() => ctx.interval(tick, 500))` + `agents.list()` |
| 记忆写入 | **模型自己调 `remember` 工具** |
| turn-stopping 用途 | 只做 `assembled → consumed` 追踪 |
| 存储 | `$DSH_HOME/fish-memory/<sessionId>.json` |
