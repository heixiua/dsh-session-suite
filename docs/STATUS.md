# 项目状态与未完成清单

> 更新：2026-11-06 22:25 · 版本 `@heixui/dsh-session-suite@0.5.1`
> 用途：不用翻聊天记录，这里就是当前状态。每次发版后更新。

---

## 一、已完成（0.5.1）

| 模块 | 状态 | 说明 |
|---|---|---|
| 会话快照 | ✅ | 每轮自动拍、可恢复、可锁定、可删除 |
| 快照继承 | ✅ | fork 后硬链接继承父会话快照，`inheritedFrom` 排除在预算外 |
| 快照孤儿清理 | ✅ | 扫描已删会话的快照目录，两步确认删除；定时器只报告 |
| 回滚 / 撤销 | ✅ | fork 前缀 + 退休原会话，有 undo 包 |
| 删除消息 / 删除片段 | ✅ | 按轮次切点裁剪，文件零改动 |
| 会话导出 | ✅ | md / txt / json / html，图片内联 data URL |
| 归档会话管理 | ✅ | 列出、恢复；修了参数形状 bug |
| 长期记忆引擎 | ✅ | 四因子评分、时间衰减、聚类、冷归档 |
| 混合检索 | ✅ | 三路词法（bigram BM25 + 单字 IDF + jieba 词表）+ RRF |
| dense 重排 | ✅ 可选 | 权重实测校准 1.0（MRR 0.535→0.760）；默认关闭 |
| 记忆维护幂等 | ✅ | 六轮验证不再重复生成 |
| 常驻卡片 | ✅ | 按主题分组，与「本轮相关」分区标注 |
| 情景记忆 | ✅ | `kind:'episode'`，带时间/情境/结果，衰减加倍 |
| 隐私分级 | ✅ | public/internal/secret，secret 永不注入、永不导出 |
| 记忆可视化 | ✅ | 类型/分数/主题三图，彩色区分，标签完整 |
| 隐式提取模型来源 | ✅ | 从 Host 的 `llm` 服务枚举真实模型；默认关闭 |
| 上下文感知检索 | ✅ **默认关闭** | 见下方说明 |
| 侧边栏入口 | ✅ | `sidebar.panellist` + `main` 面板 |
| 面板统计 | ✅ | 四个数字各带口径 + 分工作区明细 |
| dsh.so 上架 | ✅ 已提交 | GitHub topic `dsh-plugin` 已加 |

---

## 二、未完成

### P0 — 隐式提取队列（唯一卡住的功能）

**状态**：五轮修复，仍未产出。**诊断已定位到关键线索。**

**当前诊断显示**：`本次运行没有记录到提取痕迹`

**这证明**：`engine.lastExtraction` 是 `null`，即 `publishExtractionTrace` 从未被调用。

**五轮排查记录**：

| 轮 | 假设 | 修法 | 结果 |
|---|---|---|---|
| 1 | `config.memoryModels` 为空 | 从 Host `llm` 服务枚举 | 模型下拉有了，队列仍空 |
| 2 | 默认回退偷跑 token | 改显式选择 | 授权问题解决，队列仍空 |
| 3 | 计数器被 reset 清空 | 计数器跨 reset 保留 | 仍空 |
| 4 | 诊断块被条件挡住 | 改成无条件渲染 | 显示「无痕迹」 |
| 5 | 不知道哪步失败 | **加注册账本**（本轮） | **待验证** |

**0.5.1 新增**：`installStatus()` 返回每个 `safe()` 步骤的成功/失败。
界面会显示 `N/M 个钩子已装` 和失败步骤的具体错误。

**下一步**：重启后看这行数字。
- **4/4** → 所有钩子都装了，问题在事件触发或 trace 发布
- **3/4 或更少** → 直接看到哪个步骤失败和错误信息

**关键矛盾（必须记住）**：快照监听器用**同一个** `ctx.on('session/event')` 且工作正常（33 张快照）。所以事件能到。问题在 memory-host 内部。

---

### P1 — 记忆可视化增强

**现状**：三张图（类型、分数、主题）已完成。

**可增加**：
- 时间线（近期新增趋势）
- 库健康度（重复率、归档率）
- 分数分布直方图（更细的分桶）

**优先级**：低。当前三张图已能回答主要问题。

---

### P2 — 跨工作区会话总表

**状态**：用户要求留到后面。

**技术可行**：读 `~/.dsh/sessions/<转义工作区>/<sessionId>/session.v4.jsonl.zstd`。

**雷点**：
1. **隐私**：默认只显示摘要（标题+时间+轮次），正文要点开才读
2. **subagent 会话**：按 `origin === 'subagent'` 过滤
3. **归档会话**：默认不显示
4. **数据量**：上百会话需分页或缓存

---

### 明确不做

| 项 | 理由 |
|---|---|
| 多模态提取 | 成本高；提取的信息仍会经历压缩衰减，留不住 |
| GraphRAG / RAPTOR | 库只有 50 条个人事实，一层 tag 分组已够 |
| 智能体化 RAG | 固定注入已够用，是另一种产品 |
| 文档分块 | 记忆不是文档，单条上限 300 字符 |
| 跨用户知识库 | 个人助手，不共享 |
| 面板内会话记忆 | dsh 自带轨迹且不可改，手写笔记是弱副本 |

---

## 三、上下文感知检索为什么默认关闭

**这是本轮最重要的设计判断。**

### 做了什么

把前几轮用户消息拼进检索 query，让「那它为什么慢？」能匹配到相关记忆。

### 为什么默认关闭

**关键洞察**：模型每轮收到的 prompt **已包含完整对话历史**，它自己知道「它」指什么。

所以拼接上文：
- ✅ 对**检索记忆**有用（记忆库条目需要正确的 query 来匹配）
- ❌ 对**模型理解问题**没帮助（它本来就有上文）

**收益真实但小**，且会给自包含问题加上不必要的上下文。

### 什么时候该开启

**当 prompt 故意保持很短时**（例如 Agent 从精简简报工作而非长对话），此时历史**不在** prompt 里，拼接才有价值。

这正是「AI 小说系统」的场景：每次请求不带超长上下文。

```yaml
contextQueryChars: 160   # 0 = 关闭（默认）
contextQueryTurns: 3
```

---

## 四、DSH 自带能力对比（避免重复造轮子）

查了 331 个内置包：

| 内置包 | 做什么 | 与我们的关系 |
|---|---|---|
| `dsh-experimental-session-search` | 给 Agent **工具**去搜往期会话，**默认关闭** | 不同：它靠 Agent 主动调用，我们每轮自动注入 |
| `dsh-session-query` | 会话查询服务（读事件） | 不注入 prompt |
| `dsh-session-stats` | 会话统计投影 | 不注入 prompt |
| `dsh-harness-dev-context` | 注入 DSH 自身路径 | 与记忆无关 |

**结论**：没有一个内置包做「长期记忆检索并注入 prompt」。我们的定位没有重复。

**但**：`dsh-experimental-session-search` 与「跨工作区会话总表」有重叠，做 P2 前要先看它。

---

## 五、已知限制

1. **纯词法检索有盲区**：跨语言同义（checkpoint ↔ 快照）零匹配。dense 可缓解，需自装模型。
2. **压缩是追加式的**：回滚是 fork 新会话，不改写历史。
3. **编辑并重发是追加**，不替换原问题。
4. **隐式提取每轮一次模型调用**：即使便宜模型也是持续成本。
5. **记忆单条上限 300 字符**。
6. **面板无工作区概念**：显示全部工作区汇总。

---

## 六、验证命令

```powershell
# 全量回归（50 项）
Get-ChildItem tools\selftest*.mjs | ForEach-Object { node "tools/$($_.Name)" }
node tools/check-locale.mjs
node tools/audit-explicit-captures.mjs
node tools/ablate-word-route.mjs
node tools/benchmark/run.mjs --save after-xxx   # 检索基准（59 调参 + 8 同义词 + 5 垃圾）
node tools/benchmark/run.mjs --compare results/baseline-dense.json results/after-xxx.json
# 注：benchmark/queries.json 与 results/ 只留本地（里面引用了真实长期记忆原文），
# 换机器/新克隆需按自己的库重写查询集，跑不了是正常的。

# 专项
node tools/selftest-budget-dedup.mjs       # 工具输出预算 + 注入去重（8 项）
node tools/selftest-context-query.mjs      # 上下文检索（9 项）
node tools/selftest-orphan-sweep.mjs       # 孤儿清理（6 项）
node tools/selftest-sidebar-panel.mjs      # 侧边栏面板（12 项）
node tools/selftest-extraction-fallback.mjs # 提取模型来源（8 项）
node tools/selftest-memory-dedupe.mjs      # 维护幂等
node tools/selftest-resident-cards.mjs     # 常驻卡片
node tools/selftest-episode-memory.mjs     # 情景记忆
node tools/selftest-memory-privacy.mjs     # 隐私分级
node tools/probe-dense-rerank.mjs          # dense 重排实测（需模型）
node tools/cache-by-provider.mjs           # 缓存命中归因
```

---

## 七、发布流程

**规则**：改完 → 测试全绿 → commit → npm publish → 验证 dist-tags → push-github.mjs

**不再手动 Copy 到 profile**（除非本地预览需要）。

**发版后必须验证**：
```powershell
npm view '@heixui/dsh-session-suite' dist-tags
# npm publish 报成功 ≠ 已上线，版本可能卡在暂存区（实测 0.9.0 暂存了约 1 分钟）
```

**2FA 政策（2026-11 起 npm 强制）**：普通登录态 publish 会被 403 拒绝，要求
2FA 动态码或带 bypass-2FA 的 granular token。本机无 authenticator App，采用
npmjs.com → Tokens → Granular Access Token（仅本包 + Read and write + Bypass
2FA），写入 `~/.npmrc` 的 `_authToken`。注意：长期记忆分类器会把提到这类
凭据的条目自动标成 secret 而永久不可召回，所以这条流程只写在这里，不写记忆。

---

## 八、环境

```
项目      D:\AI sandbox\dsh-sandbox\DSH Optimize
DSH profile D:\AI agent cache\dsh\profiles\desktop
DSH 数据  C:\Users\Administrator\.dsh\
档案仓库  D:\AI sandbox\dsh-sandbox\Radiate Budding
Obsidian  待装（D:\AI app\Obsidian）
```

**铁律**：PowerShell 破坏内联脚本引号 → 一律写 `.mjs`；CSS 注释不能有反引号；`decorateCheckpoint` 是白名单。

---

## 九、1.0.1 修复记录（2026-11-15）

**现象**：批量删除子智能体会话后 DSH Host 直接退出（exit 1）。崩溃日志
`crash-2026-11-14T15-18-58-656Z-host.log` 里同时有两条独立的问题：

1. `retainRatio (0.12) must be less than the resolved thresholdRatio (0.12)`
   → `compaction-basic` 加载失败 → `command-compact: pending`。这是 **profile
   配置错误**，已由 profile 侧把 `retainRatio` 改成 0.10 解决，与本仓库无关。
2. `dsh: fatal uncaught exception: Unknown frame descriptor` /
   `ZSTD_error_prefix_unknown` → 本次代码修复的对象。

**修复**：`lib/cleanup.js` 的 `readSessionHeader()` 给 input 与 zstd stream
都挂 error 监听、记录首个错误、关闭 readline 释放迭代器，`finally` 幂等
销毁两个流；坏帧返回 `null`（兑现「unreadable log 视为无 header」契约）。
版本 1.0.1。

**验收命令**：

```powershell
node --check lib/cleanup.js                    # exit 0
node tools/selftest-hidden-sessions.mjs       # 15 checks PASS
node tools/mutation-zstd-guard.mjs            # d271187 崩、工作树安静
```

Mutation 脚本把固定 ref `d271187` 的旧 `cleanup.js` 落到 `lib/` 同目录
（相对 import 才解析得到），跑同一组坏帧用例，断言旧实现会出现未捕获
异常；跑完自动删除临时模块。固定 ref 而非 `HEAD`，保证 commit 之后仍可复现。

**诊断修正（重要）**：一开始按「坏 zstd 帧」去构造 mutation，两版 Node
都复现不出 uncaught。实测结论：

| 坏帧形态 | 结果 |
|---|---|
| magic 在偏移 0 损坏 | stream error 被 readline 转发进 `for await` 的 catch，旧实现也接得住 |
| 尾部损坏 / 截尾 / 第二帧坏 | 读到 header 后源流即被销毁，损坏数据根本没被解压，无任何 error |
| **源流自身 EISDIR/ENOENT/EACCES** | `input.pipe(zstd)` 不转发 source error，旧实现无监听 → **uncaught** |

所以致命路径是**源流侧**，不是 zstd 解压侧。这也解释了为什么补丁里
「给 input 也挂 error 监听」比只挂解压器更关键。

**诚实边界**：异常栈只到 `ZstdDecompress.zlibOnError`，没有指向
`cleanup.js` 的帧；「是 `readSessionHeader` 的流」仍是按时间线（1.0.0 新增
该函数 + 删除 subagent 会话）做的强推断。mutation 证明这条路径可以致命，
但 15:18:58 那一次是否必然走它，仍未 100% 坐实；日志里报的是
`ZSTD_error_prefix_unknown`（解压侧），而本次稳定复现的是 `EISDIR`（源流侧），
两者同属「删除/重写竞态下流提前失效」这一族，但不是同一个错误码。

**部署注意**：profile 里是精确版本 `"@heixui/dsh-session-suite": "1.0.0"`，
升级需 `pnpm add @heixui/dsh-session-suite@1.0.1`；`pnpm install` 或插件
升级都会覆盖 `node_modules` 里的本地补丁，所以固化到源码是必要的。
`pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude` 需同步追加 `1.0.1`，
否则新版本可能被发布时效策略拦下。
