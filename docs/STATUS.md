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
