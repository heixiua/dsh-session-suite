# dsh-session-suite（会话套件）

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）提供会话检查点能力：把对话
**连同工作区文件和会话记忆一起**回滚到任意一条消息，永久删除会话，把会话导出成图片或单文件网页，
并且维护一套**跨会话、跨工作区的长期记忆**。

这是一个 DSH 插件包（Host + Web Client），对标 Trae 的会话操作体验，已在 desktop profile 上验证加载。

| 能力 | 位置 |
|---|---|
| 回滚到某条消息（对话 + 文件 + 记忆） | 每条最终助手消息的 ↺ 按钮，输入框上方的行内确认条 |
| 删除某一轮（只动对话与记忆） | ↺ 旁边的 🗑 按钮 |
| 删除选中的一段对话 | 会话 `…` 菜单 → **删除对话片段**（可选轮次） |
| 永久删除会话 | 会话 `…` 菜单 → **删除任务**（二次确认弹窗） |
| 分享选中的片段 | 会话 `…` 菜单 → **分享会话**：勾选轮次后生成图片 / 网页 / Markdown / JSON / 复制文本 |
| 快照管理 | 会话 `…` 菜单 → **会话快照**，以及 设置 → **会话快照** |
| 长期记忆（全局 + 工作区双库） | 设置 → **长期记忆**；`【记住：…】`；`memory` 工具 |
| 用 WorkBuddy / Trae 积分跑模型 | **不在本包内** —— 见 [用 WorkBuddy 和 Trae 的积分](docs/credits.zh.md) |

### 长期记忆

两个隔离的库（`global` 与按工作区划分的 `workspace`）、四因子重要性评分（频率 · 新近度 · 情感强度 · 独特性）、
动态衰减加冷归档、相似聚类并压缩成摘要、以及从重复标签里提炼规则型记忆。

最关键的一点：**隐式记忆不会偷偷入库**。每轮结束后由一次轻量模型调用提出候选，进入设置页的待确认队列，
只有你点「保留」才真正写入；而 `【记住：…】` / `【新增全局记忆：…】` 这类显式指令会跳过队列直接写入。

评分公式、阈值、生命周期、指令、存储结构都在 [docs/long-term-memory.md](docs/long-term-memory.md)。


### 各操作分别动到什么

| 操作 | 对话 | 会话记忆 | 工作区文件 |
|---|---|---|---|
| 回滚（↺） | 截断到该消息 | 裁剪到该处 | **恢复到该轮快照** |
| 删除一轮（🗑） | 提问 + 回答 + 中间的步骤一起移除 | 裁剪到该处 | 不动 |
| 删除对话片段 | 从选中的第一轮（含它的提问）截断 | 裁剪到该处 | 不动 |
| 删除任务 | 从磁盘移除 | 移除 | 不动（文件夹保留） |

只有回滚会把文件写回去，其它删除都不碰工作区。会话日志是只追加的，所以「截断」只能是「保留前缀 + 原来的会话退休」——选中范围之后的内容会一起消失。

### 分享

分享弹窗会列出每一轮对话（你的提问 + 回答预览），默认全选，取消勾选即可排除。然后选输出形式：

* **图片**：把选中轮次画成一张 PNG（用 canvas 直接画，不依赖任何第三方库）；
* **网页文件**：单文件 HTML，内联样式、跟随明暗主题、可直接打印成 PDF；
* **Markdown** / **JSON**：贴进 issue 或喂给别的工具；
* **复制文本**：纯文本进剪贴板。

两种富格式都会真正**渲染 Markdown**，而不是原样吐出：标题、粗体/斜体、行内代码、代码块、有序/无序列表、引用、管道表格、链接。Host 侧把日志解析成带内联样式的 block（`lib/markdown.js`），HTML 渲染器和 canvas 渲染器吃的是同一份结构，所以网页和图片不会出现两种排版。

截图会跟着一起导出：附件不在会话日志里，Host 通过 `attachments.imageHostPath` 取到原文件，按预算内联成 data URL，网页因此仍是单文件。图片里截图按整卡宽度绘制（限高、保持比例）；网页里每张截图是一个按钮，点开用内置查看器按原始分辨率看——页面只带一小段内联脚本，不发任何外部请求。

另外要说清楚：**位图（PNG/JPG）里的图片不可能点开**。需要「点开看原图」就分享网页文件，而不是导出的 PNG。

### 导出到底包含什么

会话日志里大部分不是对话：运行环境、技能目录、时间采样、子代理回执、工具调用，以及模型在工具之间写的过渡性说明。这些都不该进导出：

* 只有 `source.kind === "user"` 的消息才算「你说了什么」，user 角色下的其它事件全部丢弃；
* 默认勾选 **只导出最终回答**：每轮保留你的提问 + 最后那条答复；
* 取消勾选则导出每个助手片段，包括工具调用之间的过程说明；
* 富格式里永远不出现工具输出，Markdown / JSON 也走同一套取舍。

同一轮里的多个助手片段会合并成一张卡片，只有工具调用、没有正文的步骤直接丢弃，不会导出成一堆空标签。

真正的「在线链接」需要一台服务器托管内容；这个包用可离线打开的网页文件来替代，而不是生成一个只有本机能打开的链接。

## 安装

从 npm 安装：

```bash
dsh plugin --profile desktop install @heixui/dsh-session-suite
```

> 发布用的是带作用域的包名，因为不带作用域的 `dsh-session-suite` 在 npm 上属于另一个项目
> （`chc-1986/dsh-session-suite`），不是这个。作用域只是 npm 上的包身份——插件 id、存储目录、
> bundle 名仍然是 `dsh-session-suite`，所以旧版本留下的数据照样能找到。

从本仓库检出目录安装：

```bash
# 从本仓库检出目录安装
dsh plugin --profile desktop install .
```

或者让运行中的 Harness 安装（`plugin_manager` 就是这样做的）：

```js
plugin_manager({ action: 'install_bundle', target: 'D:/path/to/dsh-session-suite' })
```

安装后刷新页面即可。整个套件只有一个 Host 行（`session-suite`），配置写在 `cordis.patch.yml`；Client 部分由
`package.json` 的 `dsh.client` 字段自动发现。

## 回滚是怎么实现的

DSH 的会话日志是**只追加**的，而且是唯一事实来源，所以回滚不能删除事件。套件把它做成一次原子的三段式操作：

1. **保护**：先给工作区和记忆账本拍一个临时 *undo* 快照（10 分钟有效）。
2. **对话**：`sessionController.fork({ sessionId, atSeq })` 把事件前缀完整分叉成新会话（边界包含该消息、
   沿用同一个 `cwd` 与 agent preset）。
3. **文件**：恢复该轮开始时记录的快照——改过的文件写回、轮次里新建的文件删除、会话开始前就存在的文件不动。
4. **记忆**：裁掉晚于目标序列的记忆条目。
5. **退休**：把原会话归档（侧边栏隐藏，日志保留），整个过程不销毁任何数据。

「撤销回滚」会把这五项全部还原：文件、记忆、被归档的会话，以及分叉出来的子会话。

## 快照在磁盘上

```
%DSH_HOME%/storages/dsh-session-suite/
  sessions/<sessionId>/index.json        # 检查点索引
  sessions/<sessionId>/manifests/*.json  # 路径 -> {hash, size, mtime}
  sessions/<sessionId>/blobs/<ab>/<hash> # gzip 压缩的文件内容，按内容寻址
  memory/<sessionId>.json                # 会话记忆账本
  memory/_global.json                    # 跨会话长期记忆
  undo/<id>.json                         # 回滚撤销包
```

* **增量**：manifest 只记录路径与哈希，相同内容只存一份；未变化的文件靠上一份 manifest 的
  `(size, mtime)` 指纹直接跳过，不再读取。
* **配额**：每个会话保留最近 10 个自动检查点；锁定的一律保留；临时撤销包不占配额，10 分钟后清理。
* **忽略清单**：`node_modules`、`.git`、缓存、构建产物、日志、锁文件、二进制文件都不记录；`config.ignore`
  可追加自定义规则。
* **上限**：单文件超过 2 MiB、单次超过 4000 个文件会跳过，避免拖慢对话。

## 配置

```yaml
- insert:
    - id: session-suite
      name: dsh-session-suite
      config:
        keep: 10               # 每个会话保留的自动检查点数量
        autoCheckpoint: true   # 每轮开始时自动拍快照
        maxFileBytes: 2097152
        maxFiles: 4000
        sweepIntervalMs: 300000
        ignore: []             # 追加的忽略规则
```

## 目录结构

```
index.js            Host 半部：注册路由、按轮拍快照、清理定时器
client.js           Client 半部：菜单行、消息操作、确认条、弹窗、设置页
lib/api.js          受保护的 Fetch 路由（POST api/session-suite）
lib/service.js      会话操作：rollback / undo / delete / share / deleteMessage
lib/checkpoints.js  内容寻址的增量快照存储
lib/memory.js       会话记忆账本（支持按序列裁剪）
lib/share.js        会话日志 → Markdown / 文本 / JSON
locale/{en,zh}.json 插件管理器的展示信息与文案
tools/              自测脚本与预清理脚本（不随插件打包）
docs/               需求与 API 笔记
```

## 0.4.0 改了什么

本次重构的是记忆引擎，会话相关功能未变。

| 方面 | 改前 | 改后 |
|---|---|---|
| 重复记忆 | 46 条里同一主题占 7 条 | 维护幂等（连续 6 轮验证）；存量重复已合并进冷库 |
| 常驻层 | 2 条扁平记忆，混在「相关」区块里 | 最多 5 张主题卡片，独立分区标注 |
| 情景记忆 | 没有 | `kind: 'episode'`，带发生时间、情境、结果；衰减加倍 |
| dense 重排 | 实现了但默认关，权重未验证 | **可选，默认关**；权重经实测校准（8 条改写查询 MRR 0.535→0.760，recall 不变） |
| 隐私分级 | 只有 scope | `public`/`internal`/`secret`；凭据自动识别；secret 永不注入、永不导出 |
| 隐式队列 | 关键词闸门误杀 7/10 合法候选 | 闸门已移除；空队列会说明原因 |

**embedding 是可选增强，默认不下载任何东西。** 不装模型就是纯词法检索，功能完整；装了才有跨语言与改写召回。
实测效果与安装方式见 `docs/memory-architecture.md` 和 `tools/download-embedding.mjs`。

## 0.4.1 改了什么

新增侧边栏入口，修掉几个「看起来能用、实际没生效」的问题，并把界面上说不清的数字说清楚。

| 方面 | 改前 | 改后 |
|---|---|---|
| 入口位置 | 只能在 设置 → 会话快照 / 长期记忆 里找，三步才能到 | **左侧栏「会话套件」图标**，点开即用；设置页那三个重复入口已移除 |
| 记忆总数 | 面板显示 17，设置页显示 51 —— 同一句话两个数 | 面板遍历**所有已登记工作区**；每个数字都写明统计口径，并给出分工作区明细 |
| 归档恢复 | 点了没反应，磁盘上的标记纹丝不动 | 修了两个 Host 服务参数形状不一致的问题，恢复真正生效 |
| 快照数量 | 预算 10 张，列表却有 16 张，无从解释 | 区分「自有 10 张」与「继承 6 张」，继承项打徽章并说明为何不计入预算 |
| 隐式提取模型 | 只能选「关闭」和「用当前模型」，看不到自己配的模型 | 从 Host 的 llm 服务枚举真实可用模型；**默认关闭，不选就不消耗 token** |
| 长列表 | 配置区被五十条记忆挤到看不见 | 列表独立滚动，配置区始终可见 |
| 会话记忆 | 一个从未写入的残缺区块，旁边就是 dsh 自带的轨迹 | 已移除 —— 轨迹是权威且不可改，手写笔记只会误导 |

**关于记忆总数为什么会有多个数字**：长期记忆分「全局库」和「各工作区的库」。
`longterm.list` 不带 `cwd` 时只返回全局库，带上才是全局 + 该工作区。面板没有工作区概念，
于是只显示了全局那部分。现在面板会遍历所有已登记工作区，并在界面上直接列出每个库的条数。

## 测试

全部自测脚本都在临时目录里跑，不会碰真实的 DSH 数据。

```bash
node tools/selftest.mjs                    # 快照 / 忽略规则 / 恢复 / 淘汰 / 记忆
node tools/selftest-memory-dedupe.mjs      # 维护幂等，重复不再生成
node tools/selftest-resident-cards.mjs     # 常驻卡片分组与预算
node tools/selftest-episode-memory.mjs     # 情景记忆类型与衰减
node tools/selftest-memory-privacy.mjs     # 隐私分级与导出过滤
node tools/selftest-implicit-queue.mjs     # 隐式候选不再被误杀
node tools/selftest-memory-conflicts.mjs   # 矛盾对只入队，绝不自动裁决
node tools/selftest-pain-distill.mjs       # 失败轮自动提炼教训，去重且封顶
node tools/selftest-p2p3-wiring.mjs        # 两个功能每一层都真的接上了
node tools/selftest-surface-shadow.mjs     # 就地回退标记绝不会被当成用户提问
node tools/probe-dense-rerank.mjs          # dense 重排的实测对比（需要模型）
```

## 1.0.3 改了什么

修掉三件互相咬合的事：**工具报错被当成"用户的教训"入库**、**裁决过的记忆在界面上看不出痕迹**、**模型能替你裁决冲突**。

**1. 工具报错不再变成"用户说"**
`cueSentence()` 在消息里找不到纠正线索时会退回"正文开头 120 字"。用户把
`HTTP 503: {"code":"video_queue_full"...}` 和 `edit error: old_string was not
found in` 贴进对话后，这两段机器输出就被抄进了 `用户说：…` 槽位，生成 5 条
"教训"。教训是免淘汰的（`LESSON_TAGS`），所以这类噪声是**永久**的，而且其中
两条后来还凑成了一对"互相矛盾"，逼用户在两段堆栈之间做裁决。

- 新增 `looksLikeToolError()`：识别 HTTP 状态、JSON `"code"/"message"` 对、
  异常类名、`ENOENT/EACCES/ZSTD_error_*` 等 errno、`error:` 前缀、
  `old_string was not found`、`at f (` 栈帧、`Traceback`。判定为机器输出的一律
  不入库。
- `cueSentence()` 找不到线索时返回**空串**，不再退回正文开头。
- `distillLessons()` 二次把关：即使找到了线索，引用本身若是机器输出也不采用。

**2. 裁决过的东西现在看得见**
`supersededBy` 一直写在磁盘上，但列表行只渲染 `frozen` 徽标，没有"已淘汰"。
于是昨天裁决过的记忆，今天看起来和普通记忆一样，用户以为自己的记忆丢了。

- 列表行新增 **已淘汰** 徽标（hover 显示被哪条取代）。
- 冲突队列为空时不再渲染 `null`（等于什么都不显示，和"面板坏了"无法区分），
  而是明说：没有需要裁决的，输的一方标为已淘汰、赢的一方标为已冻结。

**3. 模型不再能替你裁决**
`settleConflict()` 有两个入口：界面按钮，以及 `memory` 工具的 `resolve`
action。后者意味着模型可以在你没参与的情况下把一对冲突裁决掉——本次事故正是
如此：11/16 20:26 由模型写入 `supersededBy` 与 `frozen`，用户 11/17 才看到面板，
还以为是自己的操作没生效。

- `resolve` 现在**只预览**：返回将被淘汰/冻结的是哪一条，不写盘。
- 真要写必须传 `confirm: true`（已在工具 schema 里声明，否则该参数会被校验丢弃，
  守卫永远走不到）。
- 未知 id 返回说明而不是抛错。

测试：新增 `tools/selftest-pain-noise.mjs`（21 项，含"贴着报错原文的纠正仍被拒绝"
和"真实纠正仍然入库"双向断言）与 `tools/selftest-conflict-ux.mjs`（8 项）。
全量 62/62 通过。

## 1.0.2 改了什么

修掉「点了删除，界面没反应」，以及一个让归档空白会话**永远删不掉**的判定错误。

- **列表不刷新（主因）**。隐藏会话与归档会话两处 `runClean` 删完只调
  `setSelected(new Set())`，唯独没调 `bump()`；而这两个列表只由 `[rev]`
  副作用重新拉取。于是文件已经删掉、行却还留在屏幕上——被当成「删不掉」。
  现在两处都在 `finally` 里 `bump()`，失败也会刷新。
- **`registrySessionIds()` 把「标记」当成了「占位符」**。它原先会把
  `global.archivedSessionIds` / `global.pinnedSessionIds` 一并收进返回值，而
  `hiddenSessions()` 用这个集合判断「已注册的空白会话 = 工作区 New Session
  占位符，必须保护」。结果是：任何**被归档过的**空白会话都被误判成受保护
  占位符，既不出现在隐藏列表、也不出现在归档列表，任何面板都碰不到它。
  现在它只返回 `tables.workspaces[*].sessionIds`；需要「所有提到过的 id」
  （幽灵清理用）请用新增的 `allRegistrySessionIds()`。
- **运行中的行被静默丢弃**。`sweepHiddenSessions` 把 running 的行从候选里
  过滤掉后返回 `removed=0 failed=0`，一句提示都没有。现在这类行进
  `skipped` 并带原因，界面显示「仍在运行，请先关掉」。
- **确认后什么都没删也要说话**：新增 `hidden.nothingDone` 文案（中英各一）。
- **级联方向明确为只向下**：选中一行时连带删除它名下的子智能体，绝不向上
  找父会话。实测删掉一个子智能体后，父会话日志 sha256 完全不变、3052/3052
  事件仍可解码，子智能体 relay 回来的内容也仍在父会话里。
- 测试：`tools/selftest-hidden-delete.mjs` 新增 11 项；`selftest-cleanup.mjs`
  把原先「归档标记也算已注册」的断言（它把这个 bug 固化成了预期）改为
  「只算工作区入口」，并加了一条回归用例。全量 60/60 通过。

## 1.0.1 改了什么

修掉「删除子智能体会话后 Host 直接退出」。`hiddenSessions()` 用流式 zstd
只读每条日志的 header；删除/重写日志的竞态会留下半帧，`ZstdDecompress`
异步抛 `ZSTD_error_prefix_unknown`，而 readline 不会把这个错误转发进
`for await`，于是在 Node 24 上变成未捕获异常、整个 Host exit 1。

- `readSessionHeader()` 给文件流和解压流都挂 error 监听，记录首个错误并
  关闭 readline 释放迭代器，`finally` 里幂等销毁两个流；坏帧按函数原有
  契约降级为「无 header」，不再拖垮 Host。监听刻意保留到流销毁为止——
  在 `finally` 里提前移除，会让迟到的 `error` 重新变成 unhandled。
- 纯防御改动：零新依赖、零签名变更。
- `tools/selftest-hidden-sessions.mjs` 从 12 项加到 15 项：截断帧、覆写
  magic、以及**源文件侧读错误**（删除竞态下的 ENOENT/EACCES 同类，用同名
  目录稳定产生 EISDIR）三种坏输入，断言扫描正常返回且零未捕获异常。
- `tools/mutation-zstd-guard.mjs` 用固定 ref `d271187` 的旧实现跑同一用例
  并与工作树对照：旧实现抛 `uncaught EISDIR`、新实现安静，证明用例真能
  抓到 bug、守卫真的生效。
- 实测澄清：**坏 zstd 帧本身并不致命**。magic 在偏移 0 就坏时，readline
  会把 error 转发进 `for await` 的 catch（旧实现本来就接得住）；尾部损坏
  则因为读到 header 后立刻销毁源流而根本没被解压到。两版 Node
  （22.22.2 / 24.21.0）行为一致。真正致命的是 `input.pipe(zstd)` 不转发
  **源流**错误，而旧实现没给 `input` 挂 error 监听。

**profile 层不归本仓库管**：`cordis.patch.yml` 的 `compaction-basic` 必须
保持 `retainRatio < thresholdRatio`（引擎 `index.js:156` 用 `>=` 校验，相等
会让插件加载失败并连带 `command-compact: pending`）。本套件自带的
`cordis.patch.yml` 只声明 session-suite 自己的行，**不含 `compaction-basic`**；
不要往里写全局压缩策略，那会覆盖所有使用者的配置。

## 1.0.0 改了什么

修掉「这几个会话一直清理不掉」。之前我给的「它们不是归档会话」数据上没错，
但**作为解释是错的**：真因是宿主有一层过滤跑在归档过滤**之前**。

`dsh-client-ui-workspace` 的 `sessionVisible()` 会先隐藏
`origin === 'subagent'` 的会话、以及 `blank === true` 且不是当前会话的会话，
**然后**才轮到 `archivedFilter`。所以哪怕切到「显示归档」，blank 会话照样
出不来；而 `@` 候选来自 `sessionPersistence.list()`，完全不看这两个标记。
结果：bot 插件留下的日志在侧边栏看不见、归档页够不着，却永远出现在 `@`
列表里。本机实测 **15 条 / 5.8 MB**，包含 `Chief` 两条、归档的 blank 空壳，
以及一堆 subagent 调研会话。

**新增「隐藏会话」页**（套件面板第四个入口）：

- `hiddenSessions()` 只扫一遍 `sessions/` 与投影缓存，用流式 zstd 解压
  只读每条日志的 header，不全量载入。只列 `blank` / `subagent` 行，显示
  `@` 里那个标题、cwd、日志大小和归档标记。
- 判定保守：正常对话绝不出现在列表；仍登记在 `workspace.json` 的 blank
  行是对应工作区的**新会话占位**，受保护；当前 blank 会话受保护；
  执行时运行中的会话一律跳过。
- `previewHiddenSweep` / `sweepHiddenSessions` 沿用归档页那套显式
  `sessionIds` 契约：预览 dry-run，执行时重新扫描并与**当前**隐藏集合求交，
  伪造 id 或已变可见的会话都删不到。删除复用 `deleteSession`，注册表标记、
  缓存、记忆、undo 包走同一套规则。
- 新增 12 项自测（占位保护、当前会话保护、白名单、空选择、部分失败、
  真变异验证、zstd 支持）+ 1 条 wiring 断言。59/59 自测、locale 331/331、
  插件审计 0 失败、暗色模式未改动。

1.0.0 的意义：三类会话残留——归档标记、孤儿缓存、宿主隐藏会话——
现在都能在插件里清掉了。

## 0.10.8 改了什么

把 2026 年 [LLM Wiki 模式](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
里对长期记忆**有用的一半**落地了——没有把记忆库改成一堆 Markdown 文件，
因为那样会丢掉 `scope` / `privacy` / `factKey` / 衰减，也会破坏 Windows 上
Host 侧的安全集成。

核心区别是**工作在什么时候做**：RAG 在查询时重新发现知识，编译式 wiki
在导入时整合新材料并维护一个可导航的索引。我们的引擎本来就有轻量编译
（`maintain()` 聚类成 summary/rule、`factKey` 取代、`residentCards`），
但检索仍是一次性把 top-k 文本贴进 prompt。三处定点改动：

1. **编译式索引 + 按需展开。** 新增 `indexCards()`：给出「主题 → 稳定条目
   id」的小目录；`expand(ids)` 按 id 精确取全文。`indexMode: true`
   （**默认关闭**）时注入目录而非扁平卡片，并告诉模型只对真正需要的主题
   调 `memory(action=expand, ids=[...])`。索引构建失败自动回退到扁平卡片，
   所以开关随时可以翻回去。secret 既不进索引，也不允许展开。
2. **矛盾检测前移到写入时。** `#detectIngestConflicts()` 在 `remember()`
   内运行，新写入的相反断言立即进矛盾队列，不用等 30 分钟的 `maintain()`
   定时器。只扫同 store 配对（跨 store 仍由 `maintain()` 负责，它本来就要
   加载两个库）。整段包 try/catch——记账绝不能拖垮一次写入。
   `ingestConflictScan: false` 是关闭开关，也是测试里的变异钩子。
3. **只读 `lint()`。** 报告无标签、缺 `factKey`、无结构条目、未决矛盾、
   secret 数量、维护是否超期。**不改任何分数、不归档任何条目**；设置页新增
   「运行体检」卡片。

新增 API action `longterm.index` / `longterm.expand` / `longterm.lint`，
工具新增 `expand`；新增 15 项自测（含真变异验证：关掉 ingest 扫描后早期
队列必须消失）、1 条 wiring 断言。58/58 自测、locale 316/316、插件审计
0 失败、暗色模式未改动且仍通过。

## 0.10.7 改了什么

社区对 0.10.6 归档清理的反馈：「希望能选择删除哪些归档会话」「我筛了 50 个，
预览还是全部」。两条都成立——第二条是实打实的 bug：`previewArchivedSweep`
分支根本没把 `limit` 传给 service，所以预览永远覆盖整个归档集合，而且当时
压根没有逐条勾选。

- **显式选择驱动全流程。** 每行都有复选框，另有「全选 / 清空选择 / 选前 50 个」。
  预览和执行发送**同一份** `sessionIds`：选 50 → 预览 50 → 只删这 50。
  空选择是 no-op（两个按钮都禁用），绝不会静默变成"全选"。
- **服务端白名单。** 已选 id 与**当前**归档集合求交集；过期、伪造、或已被恢复的
  id 一律忽略并通过 `ignoredIds` 报告。选择里运行中的会话跳过并报告。另有 5000
  条上限防止超大载荷。
- **预览过期保护。** 选择、目标、批次数任一变化都会让预览失效；执行前还会再比对
  一次 id 列表，变了就拒绝并提示重新预览。
- `limit` 现在**同时**传给预览和执行，作为「全选」时的二级上限保留。
- 新增 6 项自测（`selftest-archive-sweep.mjs` 共 19 项）覆盖「80 个里选 50」、
  空选择、白名单、运行中跳过、预览与执行字节数一致；2 条 wiring 断言锁死 API 透传。
- 反馈确认暗色模式已通过，本版未改动该部分。

## 0.10.6 改了什么

三个改动，都来自实测反馈，不是凭印象。

**暗色模式。** 面板用了 5 个主题里根本不存在的 CSS 变量名
（`--dsw-alias-bg-l2`、`--dsw-alias-bg-l3`、`--dsw-alias-brand`、
`--dsw-alias-bg-overlay`、`--dsw-alias-state-warning-primary`），还自造了一个
`--dsw-alias-bg-layer-4`。它们全部静默回退到写死的 `#fff`，而文字 token
**会**随暗色翻转——结果就是白底配近白字。现在 19 个引用 token 全部换成
真实存在的 `bg-layer-1..3` / `bg-overlay` / `brand-primary` /
`state-warn-primary` / `link`；新增自测会直接读 DSH 自带的主题插件，断言每个
颜色 token 都有明暗两份定义、旧名字一个都不许回来。

**归档会话批量清理。** Bot 类插件（BotHarness / Tobs 等）会留下上千个归档标记，
既没有会话日志也没有快照。Host 没有批量入口，而归档页还雪上加霜：每行都调
`list()` + `stats()`，上千行就是上千次目录遍历，页面直接超时、快照数全显示 0。
本机实测：15 个归档 id 里 **14 个是纯注册表残留**（没有日志）。

- 新 action `listArchived`：从注册表 + **一次** `snapshotIndex()` 扫描拼出整张表；
  页面最多渲染 200 行，剩下的走批量清理。
- 新 action `previewArchivedSweep` / `sweepArchivedSessions`，两个目标：
  `sessions`（删会话、日志、快照、缓存、记忆）和 `snapshots`（只清快照、保留会话）。
  **预览是 dry-run，执行必须过确认弹窗**，`limit` 可控制每批数量。
- 没有物理日志的幽灵标记直接清注册表，不走 `deleteSession`（后者会按设计拒绝
  「无文件」的会话，否则上千个全都会失败）。运行中的会话一律跳过并报告。
- `lib/cleanup.js` 新增纯函数 `sweepArchived` / `sessionLogSizes` /
  `snapshotIndex`，13 项自测在临时目录里验证落盘行为。

**回归**：57/57 自测全绿、中英文案齐全、插件审计 0 失败（1 项已记录的 KNOWN）、
5 个入口文件语法检查通过。

## 0.10.5 改了什么

排查「删了会话，用 `@` 还能看到」时确认：`@` 的候选来自 DSH 内核
`sessionPersistence.list()`（只扫真实 `.jsonl.zstd` 日志），**不读本插件数据**，
所以删除日志文件后 `@` 本来就不会再列。但同一轮排查确实挖到两类真残留：

| 残留 | 数量（本机实测） | 影响 |
|---|---|---|
| `storages/session_projcache/sessions/` 里无日志的孤儿缓存 | **23 个 / 4.0 MB** | 占磁盘，旧版本删除路径留下的 |
| `workspace.json` 里指向已删会话的死 id | **11 个**（`archivedSessionIds` 11、工作区 `sessionIds` 3） | 别的插件仍能把幽灵 id 解析出来 |

根因是 `#purgeSession` 末尾的 `#unarchive()` 只清**归档标记**，而
`workspace.json` 的其它数组、以及 Host 之后写回的 id 都清不掉。

**已做的两件事**：

1. **本机存量已清理并备份**：删 23 个孤儿缓存、从注册表移除 11 个死 id；
   27 个真实会话日志和它们的缓存一条没动。备份在
   `D:\AI sandbox\dsh-sandbox\_cleanup-backup-20261111-2113`。
2. **删除能力增强**：新增 `lib/cleanup.js`（纯函数，可单测）
   - `deleteSession` 末尾额外 `purgeRegistryId()`（按 id 清所有数组）+ 只针对本 id 的缓存清理
   - 两个新 action `sweepGhostCaches` / `purgeRegistryGhosts`，**默认 dry-run**，
     设置页「清理会话残留」按钮两步确认，可清历史孤儿
   - 判定保守：缓存只在**没有任何会话日志**时才算孤儿；单会话删除绝不扫别人的缓存
   - 15 项新自测 + 一条 wiring 断言固定住接线

`@` 的行为没变也不该变——它归内核管。这版清的是我们自己的删除尾巴。

## 0.10.4 改了什么

0.10.3 的 Markdown 导出实测发现一个真问题：侧边栏面板拿不到 cwd（`runtime.resolveCwd()`
返回空），于是导出只有**全局库 69 条**，工作区记忆整节是空的，但文件看起来完整——
比报错更危险。

- 改为**导出全部已登记工作区**，每个工作区单独一节，不依赖调用方提供 cwd
- 同名路径的多个 hash 条目合并，不再出现重复章节
- 头部写明「全部 N 个」，末尾仍报 secret 隐藏数
- 实测：207 条（原 69）、6 个工作区、隐藏 2 条 secret

顺带把「长期记忆」页拉宽：`.dss-panel` 760→1120、`.dss-section` 720→1080，
消除宽屏下两侧大片空白。

## 0.10.3 改了什么

对照 [zilliztech/memsearch](https://github.com/zilliztech/memsearch/tree/main/plugins/dsh) 做的两项「可迁移性 / 可观测性」补强，不引入任何外部依赖。

**① 记忆可导出为纯 Markdown（`longterm.exportMarkdown` / `longterm.exportMarkdownFile`）**

以前的 `longterm.export` 是给「分享给别人」用的 JSON，只导 `public`；而库里绝大多数条目默认是
`internal`，拿它当个人备份几乎是个空文件。新的导出是给**拥有者自己**看的：

- `public` / `internal` 都导出，`secret` 永不出现（连 id 和占位名都不写，只报总数）
- 热库和冷归档都带上，换机器不会静默丢掉归档条目
- 每段标注日期、隐私级、`archived` / `pinned`、标签；纯文本，可进 git、可喂给别的 Agent
- 明确写了「不是回导入格式」——本插件不提供从 Markdown 反向写库，避免误以为双向同步
- 渲染器是纯函数（`lib/memory-markdown.js`），10 项单测固定住 secret 排除、计数、转义等契约

设置页「可迁移的记忆快照」一键下载。实测本机真实库导出 125 条、隐藏 1 条 secret。

**② 失败可见（`longterm.status` 的三个诊断进设置页）**

`longterm.status` 早就返回 `recall` / `install` / `extraction`，但界面只显示了 `pain`，
所以「召回重建失败、钩子没装上、提取没跑」三种状态从外面看都是「没有记忆」。新增一张
「记忆子系统状态」卡片，把这三件事直接说出来。

顺带修了一个接线缺陷：`LONGTERM_ACTIONS` 是显式白名单，新增两个 `longterm.*` action 时如果
不登记，关掉 `longTermMemory` 后会绕过守卫打到 undefined 引擎。现在 `selftest-p2p3-wiring.mjs`
会扫描所有 `case 'longterm.*'` 并断言它们都在白名单里——这条断言就是这次加出来的。

已发布为 `@heixui/dsh-session-suite@0.10.3`。

## 0.10.2 改了什么

一个修复，针对只有「另一个插件就地回退」时才会出现的缺陷。

DSH 的事件日志是只追加的：回退删不掉事件。所以 `dsh-purge-community` 的做法是追加一条**空**的
`user/message`，带 `surfaceOp` 去替换一段 seq 区间，由渲染层把被覆盖的部分藏起来。这条记录
`source.kind === 'user'`（它确实是以用户身份写的）、`content: []`。

本项目所有走 seq 的路径都排除了「非 user 来源」，却从没检查过一条 user 消息**有没有内容**，
于是装上 purge 之后：

| 位置 | 之前 | 现在 |
|---|---|---|
| 「重发这一轮」 | `lastUserTurn` 返回标记所在的轮次，对话框答「第 N 轮不是由你发的提问开始的」——指向一个根本不存在的轮次 | 跳过标记轮，找到真正的最后一条提问 |
| 「删除到此为止」 | `previousUserSeq` 返回标记的 seq，切点整体晚一轮 | 切点只来自真实提问 |
| 导出头部 | 回退标记、压缩检查点都被算进条数，头部声称的用户消息比正文里能看到的多一条 | `summarize` 只数真实提问 |
| 导出正文 | `curateEvents` 放行标记，`renderMarkdown` 于是输出一个空的 `### User` 标题 | 控制记录不再进入任何投影 |

判定看形状而不看插件名：`surfaceOp.op === 'replace'` 能抓住任何一家用同一套写法的实现，
`rewind-` 的 id 前缀只是老版本的补充信号。`lib/util.js` 里的 `isUserPromptEvent` 现在是这
四处共用的一条断言；纯图片提问仍然算数——没有文字的一张截图也是提问。

同时装两套回退仍然不是好主意，但理由在另一处（两者对文件和记忆的处理不一致），那是配置选择，
不是 bug。事件形状由 `node tools/selftest-surface-shadow.mjs` 固定住。

## 0.10.1 改了什么

0.10.0 上线后对着真实记忆库审计发现的五个缺陷，全部有实测证据。

| 方面 | 之前 | 现在 |
|---|---|---|
| 跨 store 矛盾 | 扫描在「每个 store 的循环内部」，所以全局规则与工作区规则互相矛盾时，**两条都注入同一个提示词、且永不入队**（实测：相似度 0.737，两侧都注入，队列为空） | 扫描额外把全局库与各工作区库对比；裁决时把输的一方写回它自己所在的 store |
| 队列读取 | `conflicts(cwd)` 用工作区过滤共享队列文件后把过滤结果写回，于是「不是我的」被当成「已失效」——**在任一工作区打开记忆页，就删掉其他所有工作区待裁决的矛盾**（实测 1 → 0） | 只清理本次真正检查过的条目，其他工作区的原样写回 |
| 教训里带凭据 | 失败信息里回显 `sk-…` 会让整条提炼出的教训被标 `secret`，而 secret 永不注入——**教训（防止该错误的知识）消失了，凭据却留在库里** | 捕获时脱敏成 `[已脱敏]`，教训保持可注入 |
| 解析不到工作区 | `remember({scope:'workspace'})` 没有 `cwd` 会抛错，hook 捕获后只记日志，教训静默丢失 | 回退到全局库——一条到处都适用的教训本就该放那里 |
| 每轮开销 | 痛苦轮 hook 在每次 `turn/end` 重读并重解析整个会话日志：4 万事件实测 **JSON 解析 186ms，而检测只要 1.15ms** | 只读最后一轮窗口，开销降低 94% |

另有两个小的：自查纠错线索仍会误伤散文（「实际上全部生效了…算错了」）；反转裁决后旧赢家同时带 `supersededBy` 和 `frozen`，让一条已退役的记忆看起来像被用户钉住的。

## 0.10.0 改了什么

两个功能出自同一个毛病：记忆库对错误的东西很自信。

| 方面 | 之前 | 现在 |
|---|---|---|
| 互相矛盾的记忆 | 被纠正的旧观念原样留在库里，和新观念一起注入，模型只能按新旧掷硬币 | 成对检测后**入队**，由人来选哪条为真；输的那条标 superseded，赢的冻结 |
| 纠错被吞 | 长记忆只改一个从句，相似度 0.88 就会走「重复」分支：旧说法被强化，新说法**被静默丢弃** | 反极性的近重复不再被吞，两边都留在库里交给队列裁决 |
| 失败的轮次 | 一轮搞砸了什么都不会留下——模型当时正在救火，最不会写教训 | 从该轮自己的事件日志**自动提炼**教训，按失败主题去重，每库封顶 12 条 |
| 聚类 | 矛盾对会被合并成一句「必须…；绝不…」 | 待裁决的矛盾对不聚类；教训也不聚类 |
| 密钥误标（P2a） | 光出现「密钥 / token / secret」就算凭据，实测 8 条误标全部是误判，被静默封存 | 只认凭据**实体**（前缀、分隔符、17 位号、卡号、手机号、邮箱） |

**为什么矛盾不自动裁决。** 「同主题、反极性」同样能匹配：被撤回的旧观念、加了条件的规则、计划与实情。检测器分不清这三种，猜错就等于悄悄改写用户的信念。所以检测自动，裁决留给人。

**立场是按从句比的，不是按整条。** 真实记忆有 100–300 字、包含多个从句；实测本库 64 条活跃记忆里有 29 条同时含「要求」和「否定」，所以「这条是不是在禁止」对它们没有答案。第一版遇到这种就放弃判断，45 个人造矛盾里漏掉 20 个。改成按句号/分号切句、逐句比对后，改一个从句就能被发现，其余部分不必变。

**为什么教训提炼不调模型。** 本套件试过七次「每轮后台调一次小模型」，一次都没触发过，其中一次直接把 Host 搞崩；而且它对每一轮都要花钱，包括没出问题的那些。改成读该轮自己的事件日志：不调模型、不联网、不花 token，这才让它有资格每轮都跑。

## 已知边界

* 回滚不改写日志，而是「分叉到目标消息 + 归档原会话」。这是只追加日志支持的唯一形态，也正是撤销能够成立的原因。
* 快照覆盖的是文件，不覆盖外部副作用：数据库状态、运行中的进程、网络调用都不在其中。
* 跨会话记忆是本套件自己的账本（`memory/`），不是 DSH 内核能力；因为由套件拥有，所以能一起回滚。
* HTTP 路由受 DSH Connection 保护（Host/Origin 校验 + 浏览器会话），只有已鉴权的 Web GUI 能访问。

## 许可证

MIT。
