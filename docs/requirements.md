# Requirements

Distilled from the product discussion that produced this bundle (a Doubao thread reviewing a draft request for
DeepSeek), plus the Trae screenshots supplied as the interaction reference.

## Original request

> 开发 DSH 插件，对标 Trae 的会话能力：
>
> 1. 侧边栏会话菜单增加：删除会话（永久删除磁盘会话文件）
> 2. 会话分享：导出会话内容 / 分享链接
> 3. 核心：消息节点快照回滚。选中任意历史节点，**同时回滚三件东西：对话上下文、当时工作区所有文件状态、会话记忆**，不是只回滚对话文本
> 4. 回滚前自动生成备份快照，防止误操作
> 5. UI：每条消息节点增加回滚按钮，设置面板可以管理快照列表
> 6. 兼容 desktop profile，热重载、重启 DSH 都正常加载

The follow-up discussion added three things worth keeping in scope:

* **Memory is the differentiator** — a rewind that restores the conversation but leaves "future" memories in place
  is wrong; memory must participate in the rollback.
* **Snapshots must be cheap** — incremental diffs, not a full project copy; a hard budget per session; ignore
  caches, dependencies, logs, and lockfiles; temporary undo snapshots that do not consume the budget.
* **Management UI** — per-snapshot disk usage, manual delete, and locking so automatic pruning cannot remove a
  snapshot the user is relying on.

## Interaction reference (Trae)

Five screenshots defined the shape of the UI:

1. A message action row with a timestamp and compact icon buttons — the rewind entry point.
2. A destructive confirmation dialog ("删除消息 / 这是当前会话中唯一的消息，删除后会同时删除该会话").
3. A sidebar session menu with rename / pin / share / duplicate / reveal / delete, the last row in red.
4. A second destructive dialog: "删除后，这个会话及其所有内容将从本地或云端移除…且无法恢复".
5. An inline confirm bar: "确定要回滚到此步骤并重新开始吗？同时会删除当前会话" with 取消 / 确认.

This bundle keeps that vocabulary: red destructive rows, a confirmation dialog for deletion, and an inline bar for
rewind (the dialog stays for actions that cannot be mistaken for a normal message operation).

## What shipped, and what changed on the way

| Requirement | Delivered as |
|---|---|
| Delete session, permanently | `…` menu row + dialog; archives the session first (so the sidebar and archive gates agree), then removes the log directory, the projection cache, snapshots, and memory |
| Share session | Three menu rows: Markdown download, clipboard text, JSON download |
| Rewind conversation + files + memory | Fork at the message sequence, restore the per-turn snapshot, trim the memory ledger, retire the source session |
| Backup before rewinding | Pre-rollback undo bundle (files + memory ledger + link to the forked child), 10 minutes |
| Per-message entry point | ↺ and 🗑 buttons on final assistant messages |
| Snapshot management panel | Settings → Session snapshots: size, lock, delete, restore, undo bundles, memory |
| Desktop profile, hot reload, restart | One Host row + one Client entry; state lives in `DSH_HOME/storages`, not in memory |

Two requirements were interpreted rather than copied literally:

* **"Delete the current session on rewind"** — Trae deletes it; this bundle archives it and keeps the log until the
  undo window closes. The visible effect is the same (the session leaves the sidebar) but a bad rewind is
  recoverable.
* **"Share link"** — a hosted share link needs a server this plugin does not own, so the bundle exports portable
  files (and clipboard text) instead of minting URLs that would 404.
