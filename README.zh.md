# dsh-session-suite（会话套件）

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）提供会话检查点能力：把对话
**连同工作区文件和会话记忆一起**回滚到任意一条消息，永久删除会话，并把会话导出为 Markdown、纯文本或 JSON。

这是一个 DSH 插件包（Host + Web Client），对标 Trae 的会话操作体验，已在 desktop profile 上验证加载。

| 能力 | 位置 |
|---|---|
| 回滚到某条消息（对话 + 文件 + 记忆） | 每条最终助手消息的 ↺ 按钮，输入框上方的行内确认条 |
| 删除单条消息 | ↺ 旁边的 🗑 按钮；删除唯一一条消息时会删除整个会话 |
| 永久删除会话 | 侧边栏 `…` 菜单 → **删除任务**（二次确认弹窗） |
| 分享会话 | 侧边栏 `…` 菜单 → Markdown / 纯文本 / JSON |
| 快照管理 | 设置 → **会话快照**：占用空间、锁定、删除、恢复文件、撤销包、记忆账本 |

## 安装

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

## 测试

两个自测脚本都在临时目录里跑，不会碰真实的 DSH 数据。

```bash
node tools/selftest.mjs          # 快照 / 忽略规则 / 恢复 / 淘汰 / 记忆
node tools/selftest-rollback.mjs # 回滚 / 撤销 / 删除消息 / 分享 / 永久删除
```

## 已知边界

* 回滚不改写日志，而是「分叉到目标消息 + 归档原会话」。这是只追加日志支持的唯一形态，也正是撤销能够成立的原因。
* 快照覆盖的是文件，不覆盖外部副作用：数据库状态、运行中的进程、网络调用都不在其中。
* 跨会话记忆是本套件自己的账本（`memory/`），不是 DSH 内核能力；因为由套件拥有，所以能一起回滚。
* HTTP 路由受 DSH Connection 保护（Host/Origin 校验 + 浏览器会话），只有已鉴权的 Web GUI 能访问。

## 许可证

MIT。
