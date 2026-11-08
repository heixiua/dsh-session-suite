# 维护手册

> 项目：`@heixui/dsh-session-suite`（DSH 会话套件）
> 版本：0.8.6 · 更新：2026-11-08

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

# 2. 部署到 profile —— **唯一安全方式：退出 DSH → pnpm add → 启动**
#    见第十节。绝不 Copy-Item 进 node_modules。
cd 'D:\AI agent cache\dsh\profiles\desktop'
pnpm add '@heixui/dsh-session-suite@X.Y.Z'

# 3. Client 半：刷新页面即生效
#    Host 半：HMR 自动重载（见第二节）；异常行需 disable→enable 重挂
```

**绝不 `Copy-Item` 进 `node_modules`。** 手拷会破坏 pnpm 状态记录（`.modules.yaml` 记了但没文件），并曾连带毁掉 `dsh-llm-fallbacks`。

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

## 二、热加载（HMR）—— **已禁用，勿再开启**

> 2026-11-08 结论：曾为了开发便利配了 `root: ["node_modules/@heixui/dsh-session-suite"]`，
> 这是「每次装别人插件，我的插件必坏」的**真正根因**。已于 profile 里改成 `disabled: true`。

```yaml
- id: hmr
  disabled: true          # ← 必须保持 true
```

### 为什么它会导致安装失败（实测四次，曾被误判为文件锁）

HMR watcher 会**递归持有被监视目录及其所有子目录的句柄**。它是 profile 配置的一部分，
DSH **每次启动都会恢复这个 watch**，所以「重启后直接装插件」完全没用。

```
DSH 启动 → HMR 恢复对我们插件目录的递归监视
  → pnpm 安装任何插件都要重写整个 node_modules 树
  → 走到这个被 watch 的目录，无法 rename/delete → ERR_PNPM_EPERM
  → 安装中断不回滚
      我们插件：被搬空，只剩一个删不掉的 lib（Access denied / os error 145）
      新装插件：文件下载了，但 package.json / bundles / patch / lockfile / .modules.yaml 全没写
  → 重启：watch 自动恢复 → 100% 复现
```

判别要点（实地取证过）：
- 只有我们插件坏、其他插件目录都能改名 → 不是全局权限/沙箱
- `lib` 是空目录却仍 Access denied、同级新建 `lib2` 一切正常 → 不是磁盘 ACL 损坏
- `icacls` 读父目录 ACL 完全正常无 deny；`takeown` / `robocopy` / 技能脚本也全部被拒
- 全局唯一一条指向 `node_modules` 的 watcher root 就是我们自己

**代价**：`index.js` / `lib/*.js` 改动需要完全重启 DSH 才生效；`client.js` 本来就一直需要刷新页面。
**绝对不要再**把任何 HMR `root` 指向 `node_modules` 内的路径。

| 改什么 | 怎么生效 |
|---|---|
| `client.js` | **刷新页面** |
| `index.js` / `lib/*.js` | **完全重启 DSH**（HMR 已禁用） |

---

## 三、改完没生效？按顺序查三件事

```
1. 部署文件 mtime 是否晚于 Host 进程启动时间？
   （HMR 已禁用，Host 半必须完全重启才生效）

2. profile/package.json 声明的版本 == node_modules 里的实际版本？
   （混合部署是最隐蔽的坑）

3. 插件目录是否完整（文件数 > 0、package.json 与 lib/ 齐全）？
   若为 0 文件且只剩一个删不掉的 lib → 是 HMR 导致的安装中断，见第十节
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

---

## 十、安装冲突：为什么「装别人的插件，我的插件必坏」

**已复现四次（0.8.1 / 0.8.2 / 0.8.3 / 重启后重装）。2026-11-08 定位到真正根因，此前「运行中文件锁」的结论是错的。**

### 真正的根因：HMR watcher 指向 node_modules 内我们自己的包

profile 的 `cordis.patch.yml` 里曾为开发便利配了（全局唯一一条指向 node_modules 的 watcher）：

```yaml
- id: hmr
  disabled: false
  config:
    root:
      - "node_modules/@heixui/dsh-session-suite"
```

HMR watcher **递归持有被监视目录及所有子目录的句柄**，且它是 profile 配置的一部分 ——
**DSH 每次启动都会恢复这个 watch，所以「重启后直接安装」完全无效**，这是重启无法解决的关键。

### 完整因果链（实地取证，非推断）

```
0. DSH 启动 → HMR 恢复对我们插件目录的递归监视（每次启动都恢复）
1. 用户点「添加插件」
2. pnpm 下载新包、开始重写整个 node_modules 树（nodeLinker: hoisted）
3. 走到被 watch 的我们插件目录 → 无法 rename/delete → ERR_PNPM_EPERM
4. 安装中断，pnpm 不回滚：
   ├── 我们插件：被搬空，只剩一个删不掉的 lib（Access denied / os error 145）
   ├── 有时完整包残留为 dsh-session-suite_tmp_<pid>_<n>
   └── 新装插件：文件在磁盘，但 package.json / cordis.patch.yml /
                 pnpm-lock.yaml / .modules.yaml 全没写 → 从未注册，不是崩了
5. 重启 → watch 恢复 → 下次装插件 100% 复现
```

### 实地取证证据（这些现象共同排除了「文件锁 / ACL 损坏 / 沙箱」）

| 观察 | 排除了什么 |
|---|---|
| 只有我们插件坏，`dsh-browser`/`dsh-context`/`dsh-llm-fallbacks`/`@ninkch` 都能改名 | 不是全局权限或沙箱 |
| `icacls` 读父目录 ACL 完全正常、全是继承项、无 deny | 不是父级 ACL |
| `lib` 是空目录却 Access denied；同级新建 `lib2` 一切正常且能删 | 不是该目录的 ACL 损坏 |
| `takeown` / `robocopy /MIR` / `icacls /reset` / ACL 诊断脚本全部被拒 | 不是普通权限问题，是句柄被持有 |
| 重启四次仍复现 | 不是一次性进程占用，是持久化的 watch |
| 全局唯一指向 node_modules 的 watcher root 就是我们自己 | 锁定 HMR |

**修复**：profile 里 `hmr.disabled: true`（已于 2026-11-08 改），然后**完全退出 DSH** 让 watcher 释放句柄，删除坏目录，重装。详见第二节。

**判别要点**：`plugin_manager list_bundles` 里我们那行 `installed: true`、却**没有 `entryId`**，就是「声明在、运行时没挂上」的实锤。正常插件都有 `include:xxx` 形式的 entryId。

### 铁律

1. **绝不再把任何 HMR `root` 指向 `node_modules` 内的路径。**
2. 装/更新任何插件之前，完全退出 DSH（不是关窗口，是退出全部 6 个 `DeepSeek Harness.exe` 进程）。

```powershell
# 正确流程
# 0) 备份 cordis.patch.yml（安装过程曾把它写坏成 217 字节）
Copy-Item 'D:\AI agent cache\dsh\profiles\desktop\cordis.patch.yml' `
          "D:\AI agent cache\dsh\profiles\desktop\cordis.patch.yml.bak-$(Get-Date -f yyyyMMdd-HHmmss)"
# 1) 完全退出 DSH（全部进程）
# 2) 安装
cd 'D:\AI agent cache\dsh\profiles\desktop'
pnpm add '<pkg>@<version>'
# 3) 校验：目标目录文件数 > 0、package.json 存在、lib 有 16 个文件、locale 有 2 个
# 4) 校验 pnpm-workspace.yaml 的 allowBuilds 里没有 "set this to true or false" 占位符
# 5) 启动 DSH
```

### 已经坏了怎么修（不用重装、不用联网）

若发现 `dsh-session-suite_tmp_<pid>_<n>` 存在且文件完整：

```powershell
$base='D:\AI agent cache\dsh\profiles\desktop\node_modules\@heixui'
$plug=Join-Path $base 'dsh-session-suite'
$tmp =Join-Path $base 'dsh-session-suite_tmp_<pid>_<n>'

# 1. 先确认空壳确实没被锁、且真的是空的
(Get-ChildItem -LiteralPath $plug -Recurse -File -Force | Measure-Object).Count  # 必须是 0
Rename-Item -LiteralPath $plug -NewName 'dsh-session-suite_broken_shell'        # 能成功=没锁

# 2. 用 SHA256 校验残留包与 workspace 源码逐文件一致（27 个可分发文件）
#    并 node --check 全部 17 个 js 文件

# 3. 把完整残留目录改名为正式名（pnpm 的 .modules.yaml / lockfile 本来就指向这个路径）
Rename-Item -LiteralPath $tmp -NewName 'dsh-session-suite'

# 4. 触发重新挂载，无需重启
#    plugin_manager set_bundle @heixui/dsh-session-suite enabled=false
#    plugin_manager set_bundle @heixui/dsh-session-suite enabled=true
#    两次都应返回 application:"applied"

# 5. 功能验证：调 memory 工具 list，能返回全部记忆 = Host half 真的活了
```

**旧空壳不要立刻删**，留着可回滚。

### 装包后必查（全局教训）

`pnpm-workspace.yaml` 的 `allowBuilds` 不能留下 `"set this to true or false"` 占位符 —— 那会破坏用户**后续所有**插件的安装能力，且症状出现在别人装插件时，极难归因。

### 排查顺序（插件「没装 / 没显示 / 异常」）

```
1. profile/package.json 的 dependencies + dsh.profile.bundles 有没有声明？
   （computer-use 那次：20 个文件全在磁盘，但这四处全没写 → 根本没注册）
2. node_modules 里目录文件数是否 > 0？有没有 _tmp_ 残留？
3. bundle 清单里那行 installed/enabled 是否为 true、有没有 entryId？
4. 包的 cordis.patch.yml 的 name 能否解析？client.js loader id 是否一致？
5. 日志 %APPDATA%\@deepseek-ai\dsh-desktop\logs\
```
