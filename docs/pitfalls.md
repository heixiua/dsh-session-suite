# 踩坑记录（Pitfalls）

本会话（构建 `dsh-session-suite` 全过程）踩过的每一个坑，按主题归类。每条都写明**症状 → 根因 → 修法**，便于下次直接检索。

标 **[致命]** 的是会让整块功能静默失效的坑；标 **[数据]** 的是可能损坏用户数据或文件的坑。

---

## 一、插件加载与生命周期

### 1. [致命] `apply()` 里抛异常 → 整块功能 404
**症状**：UI 点击报 `not found`，所有 HTTP action 全部失效，但插件看起来"已启用"。
**根因**：Cordis 把抛异常的插件行标成 `fiberPhase: "failed"`；HTTP 路由是在 `apply` 里注册的，`apply` 没跑完，路由就不存在，于是所有 action 落到 404。
**修法**：先注册 HTTP 路由，再做其它初始化；把可选依赖（记忆引擎等）包在 `try/catch` 里，失败只降级不致命。排查时**第一件事**是看插件行的 `fiberPhase`。

### 2. [致命] `tools.register` 缺 `output` 直接炸掉整个 bundle
**症状**：同上，`not found`。
**根因**：`ToolDefinition` 必须有 `output: { schema, render }`，缺了 `register` 就 throw。
**修法**：注册工具时补齐 `output`。这是第 1 条的常见触发源。

### 3. Client 只能 `require('react')`，Host 只能用 `node:` 内置
**症状**：加载即报错，或打包后运行时缺模块。
**根因**：客户端 bundle 的模块加载器只注入 `react`；Host 半区不走 npm 解析。
**修法**：Client 侧不引入任何第三方库（Markdown 解析器因此手写了 `lib/markdown.js`）；Host 侧只用 `node:fs` 这类前缀导入。

### 4. Client `sessions` 服务没有 `list`，`workspaces` 也没有
**症状**：`ctx.get('workspaces').list()` 返回 undefined，页面永远空。
**根因**：这两个客户端服务的 API 面比想象小。`sessions` 只有 `binding(id)`；`workspaces` 只有 create/rename/delete/archiveSession/unarchiveSession/insertSessionBefore。
**修法**：要列表就从 Host 侧自己暴露（本项目的 `longterm.workspaces`），或改用设置页标准 props（如 `useWorkspaces`）。**先查 `cordis_inspect` 再写调用**，不要猜方法名。

### 5. `runtime.sessionId` 从未被赋值
**症状**："本工作区"标签永远显示"还没有记忆"。
**根因**：客户端 `runtime` 对象里声明了 `sessionId`，但只读不写；`sessions.binding(undefined)` 返回空，路径解析成 `undefined`，于是回落到全局库。
**修法**：在 `openSession()` 里赋值并清掉缓存的 cwd。**凡是"某个字段看起来该有值却总是空"，先 grep 它的赋值点，确认真的有人写它。**

---

## 二、会话日志与压缩（最容易误判的一类）

### 6. [数据] 会话日志是 append-only，"删除"是 fork 前缀 + 退休原会话
**症状**：想直接改写/截断日志，发现任何 splice 都会破坏一致性。
**根因**：日志是唯一真相源，只追加。
**修法**：所有"截断"都实现成 `buildForkSeed(events, boundary)` → 复制**闭区间**前缀 → 追加 `session/end-seed` → `openTurnClosers({kind:'forked'})` → 退休原会话。`fork(atSeq)` 的边界是**包含**的。

### 7. [致命] 压缩产生的合成节点被当成真实用户消息
**症状**：压缩之后删除某轮，切点落在摘要节点上而不是真实回复；回滚/删除行为错乱。
**根因**：压缩追加一条 `compaction/summary`，再追加一条合成 `user/message`，其 `source.kind === 'compact-checkpoint'`，并带 `surfaceOp: { op:'replace', startSeq, endSeq }`。`previousMessageSeq` 只按事件类型过滤，把这条当成了正常对话消息。
**修法**：加 `isConversationMessage(event)`：`assistant/message` 为真；`user/message` 仅当 `source.kind === undefined || 'user'` 为真。两个边界函数都改用它。
**验证**：`tools/selftest-compaction-boundaries.mjs`，切点从 `[10,3,10]` 修正为 `[7,3,7]`。

### 8. 压缩发生在**轮次内部**，不只在边界
**症状**：以为只有轮末才压缩，实际长任务中途就压了。
**根因**：`_registerAutomaticCompaction()` 挂的是 `ctx.on("agent/pre-step", …)` → 每个模型步之前都检查 `compactIfNeeded(agent, "pressure", signal)`；失败只 log 一行 `step compaction failed: …; continuing the turn`，**不中断**。另有 `agent/request-error` 兜底处理 `CONTEXT_WINDOW_EXCEEDED_CODE`。
**含义**：回滚/删除必须在压缩后仍然可用——因为日志是追加式的，它们照样切在真实事件上。

### 9. 阈值算错，误以为"该压缩却没压"
**症状**：710K 上下文没触发压缩，怀疑配置没生效。
**根因**：`thresholdTokens = floor(min(W × thresholdRatio, pressureBudgetTokens))`。W=1,000,000、ratio=0.8 → ≈800K。710K **本来就不该压**，行为正确。
**修法**：先算阈值再判断。要更早压就调 `thresholdRatio`。另外 `measurement.totalTokens < thresholdTokens` 时会在 `toolResultPruner.pruneSession()` 之后再测一次，所以"测完没超"也会跳过。

### 10. 压缩 122 次不等于缓存崩了
**症状**：看到大量 `compaction/start` 就归因于压缩导致缓存命中率下降。
**根因**：真正的元凶是 provider 切换（见第 25 条）。压缩是追加式、前缀不变，对缓存友好。
**修法**：**用数据归因，不要靠直觉**。`tools/cache-by-provider.mjs` 按 provider 分段统计，一眼看出 99.6% vs 0%。

---

## 三、快照与回滚

### 11. [数据] 在轮次**开始**拍快照 → 回滚把文件删光
**症状**：点回滚，工作区文件全没了。
**根因**：轮次开始时的快照是"还没干活"的状态，回滚到它就等于撤销本轮所有产出，而用户期望是"回到这条回复时的状态"。
**修法**：快照在 **`turn/end`** 拍，语义是"第 N 轮之后的工作区"；第 0 轮拍一次 baseline。

### 12. [数据] 同尺寸重写被 `(size, mtimeMs)` 指纹漏掉
**症状**：文件内容改了但大小一样，回滚后内容没恢复。
**根因**：快速连续写入时 mtime 精度不足，`(size, mtime)` 没变化就判定"没改"。
**修法**：加 racy-clean 窗口 `racyBefore = Date.now() - 2000`，2 秒内写过的文件一律重新哈希。

### 13. `fork(atSeq)` 是**闭区间**
**症状**：切点差一条，多删/少删一轮。
**根因**：`events.slice(0, boundary + 1)`。
**修法**：传边界时要带上 `+1` 的语义，别再多减一。

### 14. 删除消息要切在"它 prompt 之前"
**症状**：删一轮，结果只删了回复、用户提问还在。
**根因**：一轮 = 提问 + 若干回复。要整轮删就得切到该轮提问的**前一条**。
**修法**：`previousMessageSeq` 定位到 prompt 之前，而不是回复之前。

### 14b. [致命] fork 出来的新会话没有继承快照
**症状**：删除某段对话（或回滚）后，原会话归档、新分支打开，但**新分支的快照面板是空的**，无法再回滚到之前的任何一轮。
**根因**：删除和回滚共用同一个原语——fork 事件前缀 + 退休原会话，所以子会话**继承了对话**。但快照是按 `sessionId` 存目录的：
```
<root>/sessions/<sessionId>/{index.json, manifests/, blobs/}
```
子会话 id 是新的，它没有任何 `index.json`、没有 manifest、没有 blob，也没有任何代码去复制。于是"对话延续了、历史断了"。
**修法**：`CheckpointStore.inherit({from, to, throughSeq, keep})`，在 `truncateConversation` 与 `rollback` 里都调用：
- 只搬 `seq <= throughSeq` 的快照（晚于切点的快照描述的是子会话从未继承的未来状态）；
- blob 用 **硬链接**复用，不复制字节。blob 是内容寻址且不可变的，链接零成本；复制会让每份快照的字节数乘以 fork 次数。链接失败（跨卷）时回退为复制；
- 继承来的快照打 `inheritedFrom` 标记，**排除在子会话自己的 prune 之外**——它们是父会话 blob 的链接，删掉就丢了 fork 存在的意义；
- 继承数量同样受 `keep` 预算约束，否则每次删除都让存储无限膨胀。
**教训**：**fork 一个会话时，凡是以 sessionId 为键的附属数据都要显式继承。** 对话日志被框架搬走了，但插件自己的数据不会被自动搬——快照、长期记忆、undo 包全都属于这一类。我这次补了快照和记忆，但当时写 `clone()` 给记忆时并没想到快照也需要。

---

## 四、导出与渲染

### 15. [数据] 导出漏 Markdown 渲染
**症状**：导出的 HTML 里 `**bold**`、表格、代码块都是纯文本。
**根因**：直接转义输出，没有 Markdown 解析层。
**修法**：写依赖无关的 `lib/markdown.js`（Client 不能引第三方库），`renderBlockDoc` 先解析成块文档再渲染。

### 16. [数据] 导出丢图片
**症状**：图片显示为空或破图。
**根因**：附件是本地文件引用，导出文件离开工作区就断链。
**修法**：`#withImages` 把附件内联成 `data:` URL（受 `imageBudget: 12` / `imageMaxBytes: 3MB` 约束）。

### 17. [数据] 导出泄漏 harness 内部管道
**症状**：导出内容里出现 `Time sampled while preparing turn…`、技能目录、subagent 结算等噪音。
**根因**：只按 `role` 过滤，把所有 `user` 角色都当成了用户输入。
**修法**：白名单 `source.kind === 'user'` 才算 prompt；其余 `runtime-context` / `time-context` / `skill-catalog` / `agent-message` / `subagent-settled` 一律剔除。

### 18. 预览文本被图片占位符吃掉
**症状**：轮次预览显示 `［2 张`（被截断）。
**根因**：`previewText` 的通用占位符正则只吃掉了结尾的 `图片］`。
**修法**：在通用规则**之前**加专门规则处理 `［N 张图片］`、`［文件：…］`、`[image: …]`。验证 `"［3 张图片］ 请描述"` → `"请描述"`。

### 19. 菜单项显示成裸 key
**症状**：右键菜单出现 `menu.share` 这样的原始键名。
**根因**：`t()` 缺对应词条。
**修法**：补 `DICTS`（`client.js` 里的 en/zh 字典，**不是** locale JSON），再跑 `tools/check-locale.mjs`。

### 19b. [致命] 删除成功却提示"已回滚到此步骤"
**症状**：点垃圾桶删除某一轮，弹窗标题正确（"确定要删除这一轮吗？"），但**成功提示**写的是"已回滚到此步骤"。用户据此认定"删除功能被换成了回滚"。
**根因**：提示文案的选择依据错了。
```js
// 错：deleteMessage 恒返回 deletedSession:false，于是删除永远走 else 分支
notify(result?.deletedSession ? t('dialog.deleteDone') : t('message.rewindDone'))
```
`deleteMessage` 只裁剪对话、不动文件，所以它**永远**返回 `deletedSession: false`；`rollback` 也不返回这个字段。该字段根本区分不了两个操作，用它选文案必然把删除报成回滚。
**修法**：提示按**用户点的按钮**（`state.mode`）选文案，而不是按服务端返回值猜。两个操作的稳定契约是：`rollback` 返回 `undoId`（动过文件、可撤销），`deleteMessage` 无 `undoId`（`filesUntouched: true`）。
**教训**：提示语错误比功能错误更伤人——功能是对的，但用户看到的是"你以为的那个操作没发生"。**凡是"操作A提示成操作B"，先查文案的选择依据，不要先怪用户点错按钮。** 我这次连续两次误判为用户误点，浪费了两轮对话，这是比 bug 更该记的教训。

### 20. locale 检查器误报
**症状**：`check-locale.mjs` 报一堆"缺失"，实际都有。
**根因**：三个问题叠加——(a) `new URL(import.meta.url).pathname` 产生 `%20` 编码路径，用 `fileURLToPath` 修；(b) 词条真正的家在 `client.js` 的 `DICTS`，locale JSON 是另一个命名空间；(c) `t(a ? 'x' : 'y')` 这种三元只匹配到一个字面量，要扫 `t(...)` 内**所有**引号字面量，并要求 key 含点、还要收集模板前缀。

---

## 五、长期记忆

### 21. [致命] `memoryModel` 没配 → 隐式提取静默不执行
**症状**：跨会话记忆一直不增长。
**根因**：`extractAfterTurn` 开头有 `if (!model?.provider || !model?.model) return` 守卫，配置为空就**直接返回**，连日志都没有。
**修法**：配置 `memoryModels`（有序降级链）。**凡是"没反应"，先找 early return。**

### 22. [致命] 只配一个模型 → 该模型限流就整轮跳过
**症状**：隐式提取时有时无。
**根因**：实测 Zhipu `glm-4.7-flash` 返回 **429 Too Many Requests**，Agnes `agnes-3.0-flash` 正常。
**修法**：`memoryModels` 降级链，逐个尝试直到有返回；空结果或抛错就换下一个。缺 `provider`/`model` 的条目丢弃，重复项去重。

### 23. [致命] `maintain()` 没有任何自动调用者
**症状**：自动聚类/摘要"从来没发生过"，只有一条全局记忆。
**根因**：`maintain` 只挂在 API 的 `longterm.maintain`（手动按钮），**没有定时器**。
**修法**：`ctx.effect` + `setInterval(tick, maintainEveryMs)`（默认 30 分钟），`timer.unref?.()`，从 `session/event` 的 `turn/end` 跟踪 `lastCwd`；disposer 里清定时器 + 退订。

### 23b. [致命] 定时器装了却看不见，也证明不了它跑过
**症状**：用户截图「自动化任务」页是空的，质疑"你说你做了，但我看不到"。
**根因**：两层混淆。(1) 那个页面属于 `dsh-schedule`，是**会话提醒**系统（按 cron/每日/每周把提醒消息投递回会话），与插件内部的 `setInterval` 无关，永远不会显示它；(2) 定时器周期 30 分钟，装完立刻检查必然"什么都没发生"，而"没变化"与"根本没跑"在界面上无法区分。
**修法**：每次成功的 pass 写 `memory/maintenance.json`（`lastMaintainedAt` / `lastMaintainedCwd` / `lastReport` / `lastFingerprint`），设置页显示"上次维护 + 上次结果"，从未跑过时显示"尚未维护过"。另提供 `tools/maintain-now.mjs` 当场验证，不必等 30 分钟。
**教训**：后台行为如果用户无法当场验证，就等于不存在。**可见性**是功能的一部分，不是附加项。

### 23c. 定时器空跑：空闲时不该按周期重新评分
**症状**：用户问"我一直不用 DSH，它每 30 分钟跑一次不浪费吗？"
**根因**：`maintain()` 本身不花钱（纯本地计算，不调模型），但无条件运行是设计上的浪费，且会掩盖问题。
**修法**：**内容指纹**驱动的脏标记。每次 pass 前比较 global + workspace 的指纹，相同则直接返回。
**关键陷阱**：不要用时间戳做脏标记。pass 会写 `updatedAt`/`lastAccessAt`，时间戳必然比产生它的那次 pass 更新，导致每轮都判定"有变化"，空跑保护形同虚设。指纹只覆盖 `id + text`，所以重新评分/聚类**不会把自己变成新输入**——否则 pass 写入它刚刚指纹过的存储，信号永远为脏，定时器变成死循环。

### 23d. [数据] 规则 id 用"分组大小"生成 → 重复堆积
**症状**：活动库 + 冷归档里 10 条规则条目只有 2 种文本，每轮 pass 都新增一条又被归档。
**根因**：`id: rule_${shortId(tag + group.length)}`。分组大小一变（增删一条记忆）就生成**新 id**；判重按 `ruleTag` 又因为旧条目已归档而失效，于是同一结论反复堆积。
**修法**：id 改用**被汇总记忆的 id 集合**：`shortId(tag + sortedIds.join(','))`，判重同时检查 `id` 与 `ruleTag`。配回归测试：连续 3 次 pass 后规则数必须恒为 1。

### 23e. 记忆条目文本被截断成 `…`
**症状**：库里出现一条 `text: "…"` 的 fact，`score` 偏低但仍在活跃集。
**根因**：写入端传入的文本已经是 `…`（调用方把预览截断后的字符串当成完整内容写入）。
**修法**：`remember` 应拒绝过短/纯占位符文本；已损坏的条目直接删除，它的 `digest` 无意义。排查时按 `text` 长度排序最快。

### 24. 聚类"不工作"其实是不满足条件
**症状**：修好定时器后仍然 `clusters: 0`。
**根因**：聚类要求**相似**条目且 `clusterMinSize: 2`、`clusterSimilarity: 0.5`；规则要求 `ruleMinSize: 3`。只有一条记忆时什么都不会发生。
**修法**：这是设计而非 bug。验证用**相似**文本：三条"提交前必须运行 selftest…" → `clusters: 1, compressed: 3`。

### 25. [致命] 工作区 key 是单向哈希 → 页面无法显示/切换工作区
**症状**："本工作区"页既不知道当前是哪个工作区，也没法选。
**根因**：`workspaceKey(cwd) = sha256(normalized.toLowerCase()).slice(0,16)`，不可逆。
**修法**：写入时额外记录可读路径到 `workspaces.json`（`{version:1, workspaces:{[key]:{cwd, updatedAt}}}`），暴露 `engine.workspaces()` 与 `longterm.workspaces` action，页面用下拉框选择。

### 26. 大小写/斜杠/尾斜杠必须归一化
**含义**：`D:\…\DSH Optimize` 与 `d:/…/dsh optimize/` 必须是**同一个** key，否则同一项目分裂成两个记忆库。归一化：转小写 + 统一分隔符 + 去尾斜杠。

### 27. 工作区记忆不得写进全局库
**含义**：两个库是不同文件（`global.json` / `workspaces/<key>.json`）。`selftest-memory-scope.mjs` 里有一条断言专门验证"工作区写入从不泄漏到全局"。

---

## 六、缓存与 provider（本次新增，代价最大）

### 28. [致命] 缓存命中率下降与"压缩/模型/工作区"都无关，是 provider 切换
**症状**：命中率从 99% 掉到 76%（甚至 0%），怀疑压缩导致。
**根因**：**缓存是 endpoint 本地的**。DeepSeek 官方自动缓存，Trae 代理链路不缓存。同一模型名（`deepseek-v4.1-flash`）经两个 provider 是两个互不可见的缓存域。
**实测数据**（本会话 1132 次请求）：

| Provider | 步数 | 命中率 |
|---|---|---|
| `deepseek-account` | 695 | 99.6% |
| `trae` | 441 | **0%（441 步全零）** |

**修法**：`tools/cache-by-provider.mjs` 按 provider 归因；长会话把默认模型指向会缓存的 provider。

### 29. Trae 上游**不返回**缓存字段，不是连接器丢了数据
**症状**：怀疑 `dsh-connect-trae` 实现有 bug。
**根因**：连接器映射是完备的——它会读 `prompt_tokens_details.cached_tokens`、`prompt_cache_hit_tokens`、`cached_tokens`（`lib/index.js:4881`），以及 `cache_read_input_tokens`（`:5593`）。是**上游没发这些字段**。原始记录对比：

```js
// DeepSeek：168 新 token，17024 命中
{"inputTokens":168,"cacheReadTokens":17024,"outputTokens":266,"totalTokens":17458}
// Trae：441975 个 token，cacheReadTokens 字段根本不存在
{"inputTokens":441975,"outputTokens":533,"totalTokens":442508}
```

**修法**：不要改插件。这是 provider 能力差异。

### 30. token 记账语义：`inputTokens` 是**未命中**部分
**含义**：`totalTokens = inputTokens + cacheReadTokens + outputTokens`（DeepSeek 620/620 步吻合）。所以 `inputTokens` 不是总输入，算命中率要用 `cached / (cached + uncached)`，别拿 `inputTokens` 当分母。

### 31. 代价量化：Trae 占 39% 步数，贡献 98.8% 全价输入
**数据**：DeepSeek 未命中 1,038,828 token / 命中 276,042,368；Trae 未命中 **86,855,681** / 命中 0。同样工作量约 **84 倍**输入计费。
**含义**：在 Trae 上跑长会话，每轮都全价重发整个上下文，会话越长越亏（不是线性增长，是每步全额）。真要省，得配合更激进压缩把上下文压小。

### 32. 请求头里没有 `cache_control` 字段
**含义**：本项目所有请求的 `request/header` 都不含 `cache_control` / `prompt_cache`。缓存完全是服务端隐式行为，客户端无法"开启"。所以不要指望通过配置打开 Trae 的缓存。

---

## 七、工具链与平台

### 33. `git push` 间歇性被 SNI 阻断，`api.github.com` 仍可达
**症状**：`Failed to connect to github.com:443 after 21119 ms`。
**修法**：`tools/push-github.mjs` 走 Git Data API（blobs → tree → commit → ref PATCH），并**先校验远端树恰好等于本地父提交树**，不一致就拒绝，避免误覆盖。比较时只看 **tree/blob SHA**，不要比 commit id（API 建出的 commit SHA 和本地不同）。

### 34. `core.quotepath` 给路径加引号 → tree 不一致
**症状**：上传后 tree SHA 与本地不符，路径变成 `"docs`。
**根因**：`git ls-tree` 默认给非 ASCII / 某些路径加双引号。
**修法**：`git -c core.quotepath=false ls-tree -r -z --full-tree HEAD`，按 `\0` 分割。

### 35. PowerShell 把 `^{tree}` 当脚本块
**症状**：`git rev-parse HEAD^{tree}` 报语法错误。
**修法**：用 `git show -s --format='%T'`。

### 36. [数据] PowerShell 往返会破坏 `client.js` 里的中文字符串
**症状**：写回后中文变乱码。
**修法**：**永远不要**用 PowerShell 读改写含中文的源文件。用 `edit` 工具或 Node `.mjs` 脚本。出事了就 `git checkout` 恢复，只重写被改的部分。

### 37. pnpm 跨盘相对符号链接失效
**症状**：`link:` 本地包在另一个盘时解析不到。
**修法**：用绝对 junction：`cmd /c mklink /J`。

### 38. 会话日志是 zstd 压缩的
**含义**：`~/.dsh/sessions/<workspace>/<session>/session.v4.jsonl.zstd`。Node 用 `zlib.zstdDecompressSync` 解压。日志里真正携带 usage 的是 `assistant/message` 的 `data.usage`（不是 `step/end`，那个只有 turn/step）。

---

## 八、工作方式（元教训）

### 39. 先查 API 再写调用，不要猜方法名
`workspaces.list()` 和 `sessions.list()` 都是猜出来的、都不存在，白改一轮。用 `cordis_inspect_list` / `cordis_inspect_query` 确认。

### 40. "没反应"优先查 early return 和有没有调用者
第 21、23 条都是这个模式：功能"不工作"不是逻辑错，而是**根本没被调用**或**在守卫处提前返回**。

### 41. 用数据归因，不要用直觉归因
第 10、28 条：直觉都指向压缩，数据指向 provider。写个脚本统计 1132 条记录，比读 5000 行源码更快得出正确结论。

### 42. 修 bug 必须配一个会失败的测试
压缩边界那个 bug 是 `selftest-compaction-boundaries.mjs` 先失败（`cut must land before the synthetic checkpoint, got 10`）才被确认的。没有断言就只是"看起来改好了"。

### 43. 压缩阶段会互相喂：规则被归档后又被重建

maintain() 的两个压缩阶段有反馈回路。阶段 3 按 tag 生成 rule，阶段 2 把这个 rule 和兄弟聚成 summary 并归档进冷库；下一轮阶段 3 问「这个 tag 有 rule 吗」，只查活动库，看不到自己刚归档的那条，于是又建一条新的。实测六轮：规则数 2 → 6 → 10 → 14 → 18 → 22，每轮稳定 +2。

库里最终 6 条 summary 只有 1 种文本、7 份同一段话。修法是判断已存在时把冷库也算上（`[...store.entries, ...cold.entries]`）。教训：**幂等性要跨阶段验证**，单看阶段 2 是幂等的，回路在阶段之间。

### 44. 用自己调参的那几条查询当测试，等于没有测试

probe-recall.mjs 的 6 条查询正是修覆盖率排序时用来调参的那 6 条，跑出 MRR 1.000 看着完美。另写 7 条没参与调参的日常口语查询（checkpoint/快照、排错序/检索排序），真实结果是 recall@5 = 0.714、MRR = 0.339。

两个 MISS 都是纯同义词失配——稀疏检索的已知盲区，正是《深入理解 AI Agent》第 3 章说的「稀疏检索精确匹配但读不懂同义词」。教训：**指标要建在留出集上**，否则数字越漂亮越危险。

### 45. PowerShell 会把 node -e 里的反斜杠和引号吃掉

用 `node -e` 传 Windows 路径时反斜杠被吞，路径解析到别的工作区，读出来的数据是错的；中文引号也会被改写导致语法错。查数据库、算哈希、写文件这类命令一律写成 .mjs 文件再跑，不要内联。

### 46. RRF 只看排名，零匹配的文档也能分到分

混合检索用倒数排名融合（RRF）避免两路分数不可比的问题，代价是它完全丢掉原始得分——于是**一个什么都没匹配到的文档，只要进了候选列表，就按名次分到融合分**。

实测：库里只有 2 条记忆时，查询「Trae 积分怎么用」，真正命中的那条 bm25=1.523、cov=0.279，另一条 bm25=0、cov=0 完全无关，融合后**无关的那条 rank 0.970 排第一，命中的那条 0.932 排第二**。原因就是 2 个候选、2 路排名，无关项稳定拿第 2 名，两路各贡献一份，凑起来比只有一路第 1 名的命中项还多。

修法：融合前把得分为 0 的候选从排名里剔除，只有真正匹配的文档参与竞争。修完同一用例变成 0.932 vs 0.232。

教训：**排名融合假设"能进候选就说明有相关性"**，当候选池很小或召回阶段不做阈值过滤时，这个假设不成立。

### 47. 单路检索无法自我否决

修覆盖率排序时把 Jaccard 换成查询归一化覆盖率，指标从 2/6 涨到 6/6——但那条路仍然只有一个信号。一个只共享单字、不共享任何 bigram 的改写查询，覆盖率恒为 0，记忆就永远捞不回来，无论多相关。

《深入理解 AI Agent》第 3 章给的方案是混合检索：跑两路**盲区不同**的检索，按名次融合而不是按分数相加。书里用稠密+稀疏，我们没有 embedding 模型（recall 必须离线），所以改成 bigram（精确但怕改写）+ unigram（松散但容错）两路。

效果：终测集 recall@5 0.800 → 1.000，MRR 0.466 → 0.733；留出集 MRR 0.339 → 0.600。**三套查询全上升**，不是对某一套过拟合。

局限要写清楚：两路都是词法的，跨语言同义（checkpoint ↔ 快照）仍然零匹配，混合检索不能凭空造出匹配。

### 48. 把「回滚 fork 的会话」当成 subagent 过滤掉了

现象：快照面板里只有另一个会话（「查询插件开发记录」）的快照，当前会话一张都没有，尽管磁盘上当前会话有 10 张。

根因在 `listSessions()` 的一行过滤：

```js
if (item.origin === 'subagent' || typeof item.parentSessionId === 'string') continue
```

这行的本意是隐藏 subagent 子会话。但**每一次回滚、删除消息、删除片段都会 fork 出新会话并退休原会话**——用户实际在用的那个会话本身就带 `parentSession`，它是同一段对话的延续，不是 subagent。于是当前会话被从列表里剔掉，面板回退到 `rows.find(row => row.checkpoints > 0)`，只能显示恰好有快照的另一个会话。

证据：当前会话 header 是 `{"id":"session-2e16c8cf…","parentSession":"session-bd5470c4…","isSeeded":true,"delegationDepth":0,"agentPreset":"cordis"}` —— `delegationDepth: 0`，它是 fork 出来的普通会话。

修法：只按 `origin === 'subagent'` 过滤。`parentSessionId` 只描述血缘，`origin` 才描述身份；`SessionSummary` 声明了 `origin` 却没有 `delegationDepth`，所以只能用 `origin`。

教训：**「有父会话」不等于「是子代理」**。在 fork 是核心操作的系统里，血缘字段几乎会出现在每个活跃对象上，用它做身份判断一定会误伤。

### 49. 回退逻辑依赖列表顺序

面板在拿不到当前会话时的回退是 `rows.find(row => row.checkpoints > 0)` —— 取**第一个**有快照的行。只要那一行缺失或者顺序变了，就会显示错的对象。

修法：显式按 `updatedAt` 倒序取最近活动且有快照的会话。顺序变成显式条件，而不是上游排序的副作用。

教训：凡是「第一个满足条件的」都要问：这个顺序是保证，还是巧合？

---

## 测试清单（全绿才算完成）

```
node tools/selftest.mjs                       # 快照存储（18 checks）
node tools/selftest-rollback.mjs              # 回滚 / 删除 / 分享
node tools/selftest-memory.mjs                # 记忆引擎
node tools/selftest-memory-scope.mjs          # 降级链 + 工作区隔离（9 checks）
node tools/selftest-workspace-registry.mjs    # 工作区注册表 + 维护
node tools/selftest-compaction-boundaries.mjs # 压缩后的切点
node tools/selftest-resolve-cwd.mjs           # 工作区 cwd 解析（8 checks）
node tools/selftest-maintenance.mjs           # 脏标记 + 规则去重（9 checks）
node tools/selftest-cluster-idempotence.mjs   # 反复维护不累积规则/摘要（4 checks）
node tools/selftest-retrieval.mjs            # BM25 / 覆盖率 / RRF 原语（13 checks）
node tools/selftest-list-sessions.mjs        # fork 会话仍在列表、subagent 仍隐藏（3 checks）
node tools/check-locale.mjs                   # 字典完整性
```

诊断脚本（不参与 CI，按需运行）：

```
node tools/cache-report.mjs          # 单会话缓存命中率趋势
node tools/cache-by-provider.mjs     # 按 provider 归因缓存缺失
node tools/maintain-now.mjs          # 立刻跑一次记忆维护，不用等 30 分钟
node tools/push-github.mjs           # git push 被阻断时的 API 推送
node tools/probe-recall.mjs          # 检索指标 recall@k / MRR / nDCG（调参用的那 6 条）
node tools/probe-recall-heldout.mjs  # 留出集检索指标（7 条）
node tools/probe-recall-final.mjs    # 终测集检索指标（改代码前就写好的 10 条）
```

