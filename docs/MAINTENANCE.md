# 维护手册

> 项目：`@heixui/dsh-session-suite`（DSH 会话套件）
> 版本：0.8.1 · 更新：2026-11-07

---

## 一、日常维护流程

### 改代码 → 验证 → 部署

```powershell
cd 'D:\AI sandbox\dsh-sandbox\DSH Optimize'

# 1. 改完代码，跑全量回归
Get-ChildItem tools\selftest*.mjs | ForEach-Object { node "tools/$($_.Name)" }
node tools/check-locale.mjs
node tools/audit-explicit-captures.mjs
node tools/ablate-word-route.mjs

# 2. 部署到 profile（开发期）
$dst='D:\AI agent cache\dsh\profiles\desktop\node_modules\@heixui\dsh-session-suite'
Copy-Item client.js,index.js,cordis.patch.yml "$dst\" -Force
Copy-Item lib\*.js "$dst\lib\" -Force

# 3. Client 半：刷新页面即生效
#    Host 半：需重启（HMR 已配，见下）
```

### 发版流程（**必须先本地验收**）

```powershell
# 1. 用户确认功能可用
# 2. 改版本号
node -e "const fs=require('fs');const j=JSON.parse(fs.readFileSync('package.json','utf8'));j.version='X.Y.Z';fs.writeFileSync('package.json',JSON.stringify(j,null,2)+'\n')"

# 3. commit
git add -A
git -c user.name='heixiua' -c user.email='heixiua@users.noreply.github.com' commit -m "feat(X.Y.Z): ..."

# 4. 发布 npm（token 在 D:\AI agent cache\dsh\.env 的 NPM_KEY）
$envFile='D:\AI agent cache\dsh\.env'
$line=Get-Content $envFile -Encoding UTF8 | Where-Object { $_ -match '^\s*NPM_KEY\s*=' } | Select-Object -First 1
$token=($line -split '=',2)[1].Trim().Trim('"').Trim("'")
$npmrc=Join-Path $env:TEMP 'pub'
Set-Content -Path $npmrc -Value "registry=https://registry.npmjs.org/`n//registry.npmjs.org/:_authToken=$token" -Encoding ASCII
& npm.cmd publish --userconfig $npmrc
Remove-Item $npmrc -Force

# 5. 验证真的上线了（publish 报成功 ≠ 已上线）
npm view '@heixui/dsh-session-suite' dist-tags

# 6. 推 GitHub
node tools/push-github.mjs
```

**铁律**：发版是给别人用的。**必须用户验收通过才发**，不要推中间版本。

---

## 二、热加载（HMR）

已在 profile 的 `cordis.patch.yml` 配置：

```yaml
- id: hmr
  disabled: false
  config:
    root:
      - "node_modules/@heixui/dsh-session-suite"
    debounce: 300
```

| 改什么 | 怎么生效 |
|---|---|
| `client.js` | **刷新页面** |
| `index.js` / `lib/*.js` | **保存后自动重载**（HMR） |

**坑**：`root` 路径必须指向**自己的包**。曾经配成 `root: ["."]` + `ignored: ["**/node_modules/**"]`，把插件自己排除了，改了不生效。

---

## 三、改完没生效？按顺序查三件事

```
1. 部署文件 mtime 是否晚于 Host 进程启动时间？
   （Host 半不热重载，晚了就是旧代码在跑）

2. profile/package.json 声明的版本 == node_modules 里的实际版本？
   （混合部署是最隐蔽的坑）

3. HMR 的 root/ignored 有没有把自己的包排除？
```

**三者都对，才怀疑代码本身。**

---

## 四、绝对不能犯的错（会崩 Host 或让包不可用）

### 1. 定时器必须 inject `timer`

```js
// 错：每 tick 抛 cannot get property "timer" without inject，拖崩 Host
export const inject = ['connection']
ctx.interval(tick, 500)

// 对
export const inject = ['connection', 'timer']
ctx.effect(() => {
  const tick = async () => {
    try { /* ... */ } catch (e) { log(e) }   // tick 体必须包 try/catch
  }
  return ctx.interval(tick, 500)
})
```

**三个条件缺一不可**：inject `timer`、tick 体包 try/catch、dispose 清定时器。

### 2. 源码不能 import `../tools/`

```json
// package.json 的 files 白名单
"files": ["index.js", "client.js", "lib/*.js", ...]
// tools/ 不在里面 → npm 装的包会因模块缺失整包加载失败
```

**探针、测试脚本一律独立，绝不 import 进插件源码。**

### 3. 调 Host 服务前必须 `cordis_inspect` 核对

已踩过的坑：

| 服务/方法 | 真实情况 |
|---|---|
| `sessionController.inspect` | **不存在**，只有 `events(request, signal)` |
| `events` 的 signal | **必传**，否则 `throwIfAborted` 崩 |
| `events` 的 cursor | **是日志末尾，不是页边界** |
| `events` 翻页 | 用**本页最旧 seq** 作 `beforeSeq` |
| `events` 页大小 | 默认仅 **50**，必须传 `maxMessages` |

**`?.` 可选链会让「方法不存在」静默变成「空数据」，比报错更难查。**

### 4. `apply()` 内别让异常逃出去

```js
// 错：整个插件行标 fiberPhase:"failed"，所有 action 404
// 对：先注册路由，可选初始化全包 try/catch
```

---

## 五、测试体系

**46 项回归**，全在 `tools/`：

| 类别 | 内容 |
|---|---|
| 会话功能 | 快照、回滚、删除、继承、分享 |
| 记忆功能 | 检索、去重、隐私、衰减、聚类幂等 |
| 契约 | `selftest-host-contract.mjs` —— **锁住所有 Host API 调用形状** |
| 检索质量 | `probe-recall.mjs`（**必须在留出集上跑**） |

### 契约测试是关键

`selftest-host-contract.mjs` 8 项断言，**变异验证 8/8 全部捕获**。**Host 升级后先跑它**，能提前发现 API 变更。

### 检索质量怎么测

```powershell
node tools/probe-recall.mjs
```

**必须用未参与调参的查询**。曾经用调参集跑出 MRR 1.000（自欺），换留出集真实是 0.339。

**标准指标**：`recall@k` / `MRR` / `nDCG@k`，**不要用「top-1 对不对」**。

---

## 六、数据位置

```
记忆库   C:\Users\Administrator\.dsh\storages\dsh-session-suite\
  ├── memory\
  │   ├── settings.json           # 用户配置（implicitModel 等）
  │   ├── workspaces\<key>.json   # 各工作区记忆
  │   └── global.json             # 全局记忆
  ├── maintenance.json            # 维护状态
  └── sessions\<sessionId>\       # 快照
      ├── index.json
      ├── manifests\
      └── blobs\                 # 内容寻址，硬链接复用
```

**备份**：直接复制整个 `dsh-session-suite` 目录。

---

## 七、已知限制（诚实版）

| 限制 | 说明 |
|---|---|
| 纯词法检索 | 跨语言同义（checkpoint ↔ 快照）零匹配。dense 重排可缓解，需自装模型 |
| 记忆单条 ≤300 字符 | 超长必须拆条 |
| 压缩是追加式 | 回滚是 fork 新会话，不改写历史 |
| 隐式提取靠模型主动调工具 | 模型不调就没记忆，没有兜底管线 |
| 记忆默认工作区隔离 | 跨工作区不共享，除非显式存 global |

---

## 八、明确不做

| 项 | 理由 |
|---|---|
| 每轮后台调模型抽取记忆 | 7 轮未成，且崩过 Host。改由模型调 `remember` 工具 |
| 记忆可视化增强 | 三张图已够用，再多是无效工作 |
| 跨工作区会话总表 | 会话少时价值低，等 50+ 再做 |
| 策略参数暴露到 UI | 给了也不会用，默认值我们自己定 |
| 多模态提取 / GraphRAG / 文档分块 | 成本高收益低，记忆不是文档 |

---

## 九、关键设计决策

| 决策 | 理由 |
|---|---|
| 记忆默认**开** | 这是本插件核心功能，不是可选配件 |
| 与 fish-memory **不能同时开注入** | 都用 `systemPrompt.context({order:900})`，会注入两份记忆 |
| `interpolate: false` | 记忆含 `{{...}}` 会抛 unknown prompt variable，整间会话每轮失败 |
| recall 缓存键含 query | `text()` 单次请求被调 5.9 遍，但 query 变了必须重算 |
| 轮次列表**降序** | 用户打开对话框先看最近的 |
| 每页 10 条 + 页码跳转 | 滚 146 行找第 3 轮不可接受 |
