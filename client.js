/**
 * dsh-session-suite — Client half.
 *
 * Adds, on top of the shipped Web UI:
 *
 *   sidebar.workspaces.session.menu.item   share rows + a destructive delete row
 *   conversation.chat.assistant-actions    rewind / delete-message actions
 *   conversation.input.dock                the inline "rewind here?" confirm bar
 *   shell.overlay                          the delete-session dialog and toasts
 *   settings.section                       the snapshot / memory manager page
 *
 * Only `react` is required: Harness Client packages are not importable from a
 * plugin, so the controls below are hand-written against the host's theme
 * tokens and interaction patterns.
 */

window.__ModuleLoader__.load({
  id: 'dsh-session-suite',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } = React

    const NS = 'session-suite'
    const ROUTE = 'api/session-suite'
    const API_TIMEOUT_MS = 20000

    // ---------------------------------------------------------------- locale

    const DICTS = {
      en: {
        'menu.delete': 'Delete session',
        'menu.shareMarkdown': 'Share as Markdown',
        'menu.shareText': 'Copy conversation as text',
        'menu.shareJson': 'Share as JSON',
        'menu.snapshots': 'Session snapshots',
        'menu.share': 'Share session',
        'menu.segment': 'Delete part of the conversation',
        'share.title': 'Share this conversation',
        'share.hint': 'Choose the turns to include.',
        'share.all': 'Select all',
        'share.none': 'Clear',
        'share.selected': '{count} of {total} turns selected',
        'share.image': 'Image',
        'share.html': 'Web page',
        'share.markdown': 'Markdown',
        'share.json': 'JSON',
        'share.copy': 'Copy text',
        'share.metaTurns': '{turns} turns · {messages} messages',
        'share.exportedAt': 'exported {time}',
        'share.imageFooter': 'DeepSeek Harness · dsh-session-suite',
        'share.rendering': 'Rendering…',
        'share.needSelection': 'Select at least one turn',
        'share.done': 'Saved',
        'share.copied': 'Copied to the clipboard',
        'share.linkNote': 'A public link would need a server hosting the conversation. The web page file is portable: anyone can open it, and it prints to PDF.',
        'share.curate': 'Final answers only',
        'share.curateHint': 'Keeps your prompt and the closing reply of each turn, and drops the narration between tool calls.',
        'share.failed': 'Could not export',
        'segment.title': 'Delete part of the conversation',
        'segment.hint': 'Everything from the first selected turn onwards leaves the conversation. Workspace files are never touched; memory recorded in that range is removed.',
        'segment.warning': 'Turns after your selection are removed too: a session log can only be cut, not spliced.',
        'segment.confirm': 'Delete',
        'segment.done': 'Conversation trimmed',
        'segment.failed': 'Could not delete that part',
        'segment.needSelection': 'Select at least one turn',
        'segment.whole': 'This removes every turn in the session; the session and its files stay.',
        'menu.shareCopied': 'Conversation copied to the clipboard',
        'menu.shareFailed': 'Could not export this session',
        'menu.shareEmpty': 'This session has no messages to share yet',
        'message.rewind': 'Rewind to this step',
        'message.rewindTitle': 'Rewind to this step?',
        'message.rewindBody':
          'Restores the workspace files and session memory saved for this step, forks the conversation up to this message, and archives the current session. An undo snapshot is kept for 10 minutes.',
        'message.rewindConfirm': 'Rewind',
        'message.rewinding': 'Rewinding…',
        'message.rewindDone': 'Rewound to this step',
        'message.rewindFailed': 'Could not rewind this session',
        'message.resend': 'Resend this turn',
        'message.resendTitle': 'Resend this turn?',
        'message.resendBody':
          'The question will be asked again in a new branch of this conversation, so the model answers from scratch instead of building on the reply you are rejecting. The current conversation stays as a branch, and workspace files are not touched.',
        'message.resendConfirm': 'Resend',
        'message.resending': 'Resending…',
        'message.resendDone': 'Resent in a new branch',
        'message.resendStaged': 'Prompt staged for editing',
        'message.resendFailed': 'Could not resend this turn',
        'message.edit': 'Edit and resend',
        'message.editTitle': 'Edit and resend',
        'message.editBody':
          'Change what you asked; it is sent as a new turn in this same conversation. Memories recorded after that turn are cleared, and workspace files are not touched. Note: the DSH log is append-only, so the original question and its reply stay in the history above rather than being deleted.',
        'message.editConfirm': 'Resend edited',
        'message.undo': 'Undo this rewind',
        'message.undoDone': 'Rewind undone',
        'message.delete': 'Delete this turn',
        'message.deleteTitle': 'Delete this turn?',
        'message.deleteBody':
          'The prompt, the reply, and the steps in between all leave the conversation. Only the log and session memory are trimmed — workspace files stay exactly as they are.',
        'message.deleteConfirm': 'Delete',
        'message.deleteDone': 'Deleted this turn',
        'message.deleteFailed': 'Could not delete this message',
        'message.deleteOnly': 'This is the only message in the session. Deleting it also deletes the session.',
        'dialog.cancel': 'Cancel',
        'dialog.delete': 'Delete',
        'dialog.deleteTitle': 'Delete session',
        'dialog.deleteBody':
          'The session and everything inside it will be removed from local storage, including its conversation log, snapshots, and memory. This cannot be undone.',
        'dialog.deleting': 'Deleting…',
        'dialog.deleteDone': 'Session deleted',
        'dialog.deleteStale': 'Deleted — press Ctrl+R if the row is still listed',
        'dialog.deleteFailed': 'Could not delete the session',
        'dialog.deleteSubagents': 'This will also delete {n} subagent session(s) started by it.',
        'dialog.deleteWouldRefuse': 'Something here is still running. Stop it first — nothing has been deleted.',
        'dialog.sessionRunning': 'This session is running. Stop it before deleting.',
        'settings.title': 'Session snapshots',
        'settings.description': 'Workspace checkpoints captured for a session, with disk usage, locking, and restore controls.',
        'settings.empty': 'No snapshots yet. A checkpoint is captured at the start of each turn.',
        'settings.capture': 'Capture now',
        'settings.capturing': 'Capturing…',
        'settings.restore': 'Restore files',
        'settings.restoreConfirm': 'Restore the files recorded in this snapshot? The conversation is not changed.',
        'settings.restoreDone': 'Workspace restored',
        'settings.restoreFailed': 'Could not restore this snapshot',
        'settings.remove': 'Delete snapshot',
        'settings.lock': 'Lock',
        'settings.unlock': 'Unlock',
        'settings.locked': 'Locked',
        'settings.budget': 'Keeps the newest {keep} automatic snapshots',
        'settings.usage': 'Snapshots use {size}',
        'settings.files': '{count} files',
        'settings.turn': 'Turn {turn}',
        'settings.temporary': 'Temporary',
        'settings.undoBundles': 'Undo bundles',
        'settings.undoBundle': 'Rollback at turn {turn}',
        'settings.undoRestore': 'Undo rollback',
        'settings.undoHint': 'Available for 10 minutes after a rollback.',
        'settings.memory': 'Session memory',
        'settings.memoryEmpty': 'Nothing remembered in this session yet.',
        'settings.memoryAdd': 'Add memory',
        'settings.memoryPlaceholder': 'A durable fact, rule, or preference',
        'settings.memorySave': 'Save',
        'settings.memoryRemove': 'Remove',
        'settings.loading': 'Loading snapshots…',
        'settings.session': 'Session',
        'settings.noSessions': 'No sessions are available yet.',
        'toast.captured': 'Snapshot captured',
        'toast.removed': 'Snapshot deleted',
        'toast.locked': 'Snapshot locked',
        'toast.unlocked': 'Snapshot unlocked',
        'toast.memoryAdded': 'Memory saved',
        'toast.memoryRemoved': 'Memory removed',
        'toast.failed': 'Something went wrong',
        'settings.details': 'Details',
        'memory.title': 'Long-term memory',
        'memory.description': 'Durable facts and conventions shared across sessions, kept in two stores: this workspace, and global.',
        'memory.tab.all': 'All',
        'memory.tab.workspace': 'This workspace',
        'memory.tab.global': 'Global',
        'memory.tab.archived': 'Cold archive',
        'memory.global': 'Global',
        'memory.workspace': 'Workspace',
        'memory.workspacePicker': 'Workspace',
        'memory.workspaceNone': 'No workspace detected',
        'memory.rule': 'Rule',
        'memory.summary': 'Summary',
        'memory.frozen': 'Frozen',
        'memory.archived': 'Archived',
        'memory.score': 'score {score}',
        'memory.access': '{count} recalls',
        'memory.empty': 'Nothing remembered yet. Say remember: … in brackets, or add one below.',
        'memory.explainTitle': 'What would this question recall?',
        'memory.explainHint':
          'Type a question to see which memories it pulls in, how many the evidence justifies, and why each of the rest was left out. Nothing is recorded — this is a dry run.',
        'memory.explainPlaceholder': 'a question, e.g. why did the cache hit rate drop',
        'memory.explainRun': 'Test',
        'memory.explainInjected': 'Injecting {n} of a possible {limit}',
        'memory.explainNone': 'Nothing matched, so nothing would be injected. That is the intended answer, not a failure.',
        'memory.explainOmitted': '{n} left out',
        'memory.whyNoMatch': 'no match',
        'memory.whyCapacity': 'over budget',
        'memory.filterAllTags': 'All tags',
        'memory.filterAnyTime': 'Any time',
        'memory.filterToday': 'Last 24h',
        'memory.filterWeek': 'Last 7 days',
        'memory.filterMonth': 'Last 30 days',
        'memory.filterClear': 'Clear filters',
        'memory.filterCount': '{n} in library',
        'memory.placeholder': 'A durable fact, rule, or preference',
        'memory.save': 'Save',
        'memory.added': 'Memory saved',
        'memory.removed': 'Memory deleted',
        'memory.freeze': 'Freeze',
        'memory.unfreeze': 'Unfreeze',
        'memory.remove': 'Delete',
        'memory.pendingTitle': 'Suggested memories',
        'memory.pendingHint': 'Extracted from the last turns. Nothing is stored until you accept it.',
        'memory.accept': 'Keep',
        'memory.reject': 'Discard',
        'memory.accepted': 'Kept',
        'memory.rejected': 'Discarded',
        'memory.maintain': 'Re-score and compress now',
        'memory.maintained': 'Memory rescored',
        'memory.maintainedAt': 'Last maintained',
        'memory.maintainedNever': 'Not maintained yet — runs automatically once memories change',
        'memory.maintainedScored': 'scored',
        'memory.maintainedCompressed': 'compressed',
        'memory.maintainedRules': 'rules',
        'memory.implicit': 'Suggest memories automatically',
        'memory.clearCold': 'Clear cold archive',
        'memory.coldCleared': 'Cold archive cleared',
      },
      zh: {
        'menu.delete': '删除任务',
        'menu.shareMarkdown': '分享为 Markdown',
        'menu.shareText': '复制对话文本',
        'menu.shareJson': '分享为 JSON',
        'menu.snapshots': '会话快照',
        'menu.share': '分享会话',
        'menu.segment': '删除对话片段',
        'share.title': '分享这段对话',
        'share.hint': '选择要包含的对话轮次。',
        'share.all': '全选',
        'share.none': '清空',
        'share.selected': '已选 {count} / {total} 轮',
        'share.image': '生成图片',
        'share.html': '网页文件',
        'share.markdown': 'Markdown',
        'share.json': 'JSON',
        'share.copy': '复制文本',
        'share.metaTurns': '{turns} 轮 · {messages} 条消息',
        'share.exportedAt': '导出于 {time}',
        'share.imageFooter': 'DeepSeek Harness · dsh-session-suite',
        'share.rendering': '正在生成…',
        'share.needSelection': '请至少选择一轮对话',
        'share.done': '已保存',
        'share.copied': '已复制到剪贴板',
        'share.linkNote': '在线链接需要一台服务器来托管内容；这里生成的是可离线打开的网页文件，发给谁都能打开，也能直接打印成 PDF。',
        'share.curate': '只导出最终回答',
        'share.curateHint': '每轮只保留你的提问和最终答复，丢掉工具调用之间的过程性说明。',
        'share.failed': '导出失败',
        'segment.title': '删除对话片段',
        'segment.hint': '从选中的第一轮开始，之后的内容都会从会话里移除。工作区文件不会改动，这一段里记录的记忆会一并清理。',
        'segment.warning': '选中轮次之后的内容也会一起移除：会话日志只能从中间截断，无法挖空再拼接。',
        'segment.confirm': '删除',
        'segment.done': '对话已裁剪',
        'segment.failed': '删除失败',
        'segment.needSelection': '请至少选择一轮对话',
        'segment.whole': '这会清空会话里全部对话，但会话本身和工作区文件都保留。',
        'menu.shareCopied': '对话已复制到剪贴板',
        'menu.shareFailed': '会话导出失败',
        'menu.shareEmpty': '这个会话还没有可分享的消息',
        'message.rewind': '回滚到此步骤',
        'message.rewindTitle': '确定要回滚到此步骤并重新开始吗？',
        'message.rewindBody':
          '会把工作区文件和会话记忆恢复到这一步，并把对话分叉到这条消息，同时归档当前会话。撤销快照保留 10 分钟。',
        'message.rewindConfirm': '确认回滚',
        'message.rewinding': '正在回滚…',
        'message.rewindDone': '已回滚到此步骤',
        'message.rewindFailed': '回滚失败',
        'message.resend': '重发这一轮',
        'message.resendTitle': '确定要重发这一轮吗？',
        'message.resendBody':
          '会在当前对话的一个新分支里重新提问，让模型从头回答，而不是在你已否定的回答上继续。当前对话会保留为分支，工作区文件不会有任何改动。',
        'message.resendConfirm': '重发',
        'message.resending': '正在重发…',
        'message.resendDone': '已在新分支重发',
        'message.resendStaged': '已填入输入框，可先修改再发送',
        'message.resendFailed': '重发失败',
        'message.edit': '编辑并重发',
        'message.editTitle': '编辑并重发',
        'message.editBody':
          '修改你原本的提问，改完后会作为新的一轮直接发在当前会话里。那一轮之后记录的会话记忆会被清掉，工作区文件不会有任何改动。注意：DSH 的对话记录是只追加的，所以原来的提问和回答仍会留在上面的历史里，不会被删除。',
        'message.editConfirm': '重发修改后的提问',
        'message.undo': '撤销本次回滚',
        'message.undoDone': '已撤销回滚',
        'message.delete': '删除这一轮',
        'message.deleteTitle': '确定要删除这一轮吗？',
        'message.deleteBody': '这一轮的提问、回答，以及中间的过程说明都会从会话中移除。只清理对话记录与会话记忆，工作区文件不会有任何改动。',
        'message.deleteConfirm': '删除',
        'message.deleteDone': '已删除这一轮',
        'message.deleteFailed': '删除消息失败',
        'message.deleteOnly': '这是当前会话中唯一的消息，删除后会同时删除该会话。',
        'dialog.cancel': '取消',
        'dialog.delete': '删除',
        'dialog.deleteTitle': '删除任务',
        'dialog.deleteBody': '删除后，这个会话及其所有内容将从本地移除，包括聊天记录、快照和会话记忆，且无法恢复。',
        'dialog.deleting': '正在删除…',
        'dialog.deleteDone': '会话已删除',
        'dialog.deleteStale': '已删除；列表若还在，按 Ctrl+R 刷新即可',
        'dialog.deleteFailed': '删除会话失败',
        'dialog.deleteSubagents': '它启动的 {n} 个子代理会话也会一并删除。',
        'dialog.deleteWouldRefuse': '这里有会话仍在运行，请先停止；目前没有删除任何内容。',
        'dialog.sessionRunning': '这个会话正在运行，请先停止再删除。',
        'settings.title': '会话快照',
        'settings.description': '查看会话的工作区检查点、占用空间，并锁定、删除或恢复它们。',
        'settings.empty': '还没有快照。每一轮对话开始时都会自动记录一次。',
        'settings.capture': '立即创建快照',
        'settings.capturing': '正在创建…',
        'settings.restore': '恢复文件',
        'settings.restoreConfirm': '恢复这份快照记录的文件？对话内容不会改变。',
        'settings.restoreDone': '工作区已恢复',
        'settings.restoreFailed': '恢复快照失败',
        'settings.remove': '删除快照',
        'settings.lock': '锁定',
        'settings.unlock': '解锁',
        'settings.locked': '已锁定',
        'settings.budget': '每个会话保留最近 {keep} 个自动快照',
        'settings.usage': '快照占用 {size}',
        'settings.files': '{count} 个文件',
        'settings.turn': '第 {turn} 轮',
        'settings.temporary': '临时',
        'settings.undoBundles': '撤销包',
        'settings.undoBundle': '第 {turn} 轮的回滚',
        'settings.undoRestore': '撤销回滚',
        'settings.undoHint': '回滚后 10 分钟内可撤销。',
        'settings.memory': '会话记忆',
        'settings.memoryEmpty': '这个会话还没有记录记忆。',
        'settings.memoryAdd': '新增记忆',
        'settings.memoryPlaceholder': '写入一条长期有效的事实、规则或偏好',
        'settings.memorySave': '保存',
        'settings.memoryRemove': '删除',
        'settings.loading': '正在读取快照…',
        'settings.session': '会话',
        'settings.noSessions': '还没有可用的会话。',
        'toast.captured': '已创建快照',
        'toast.removed': '已删除快照',
        'toast.locked': '已锁定快照',
        'toast.unlocked': '已解锁快照',
        'toast.memoryAdded': '记忆已保存',
        'toast.memoryRemoved': '记忆已删除',
        'toast.failed': '操作失败',
        'settings.details': '详情',
        'memory.title': '长期记忆',
        'memory.description': '跨会话保留的稳定事实与约定，分两个库：本工作区私有，以及全局。',
        'memory.tab.all': '全部',
        'memory.tab.workspace': '本工作区',
        'memory.tab.global': '全局',
        'memory.tab.archived': '冷归档',
        'memory.global': '全局',
        'memory.workspace': '本工作区',
        'memory.workspacePicker': '工作区',
        'memory.workspaceNone': '未检测到工作区',
        'memory.rule': '规则',
        'memory.summary': '摘要',
        'memory.frozen': '已冻结',
        'memory.archived': '已归档',
        'memory.score': '评分 {score}',
        'memory.access': '召回 {count} 次',
        'memory.empty': '还没有记忆。可以说【记住：…】，或在下面手动添加。',
        'memory.explainTitle': '这句话会召回什么？',
        'memory.explainHint':
          '输入一个问题，看它会召回哪几条记忆、证据够支持几条、其余的各自因为什么被排除。不会记录任何东西，这是一次试算。',
        'memory.explainPlaceholder': '一个问题，例如：缓存命中率为什么掉了',
        'memory.explainRun': '试算',
        'memory.explainInjected': '注入 {n} 条（上限 {limit}）',
        'memory.explainNone': '没有任何匹配，因此不会注入任何记忆。这是预期结果，不是故障。',
        'memory.explainOmitted': '排除了 {n} 条',
        'memory.whyNoMatch': '未命中',
        'memory.whyCapacity': '超出预算',
        'memory.filterAllTags': '全部标签',
        'memory.filterAnyTime': '不限时间',
        'memory.filterToday': '最近 24 小时',
        'memory.filterWeek': '最近 7 天',
        'memory.filterMonth': '最近 30 天',
        'memory.filterClear': '清除筛选',
        'memory.filterCount': '共 {n} 条',
        'memory.placeholder': '写入一条长期有效的事实、规则或偏好',
        'memory.save': '保存',
        'memory.added': '记忆已保存',
        'memory.removed': '记忆已删除',
        'memory.freeze': '冻结',
        'memory.unfreeze': '解冻',
        'memory.remove': '删除',
        'memory.pendingTitle': '待确认的记忆',
        'memory.pendingHint': '从最近几轮里识别出来的，确认前不会入库。',
        'memory.accept': '保留',
        'memory.reject': '丢弃',
        'memory.accepted': '已保留',
        'memory.rejected': '已丢弃',
        'memory.maintain': '重新评分并压缩',
        'memory.maintained': '记忆已重新评分',
        'memory.maintainedAt': '上次维护',
        'memory.maintainedNever': '尚未维护过 — 记忆有变化时会自动运行',
        'memory.maintainedScored': '已评分',
        'memory.maintainedCompressed': '已压缩',
        'memory.maintainedRules': '条规则',
        'memory.implicit': '自动识别并建议记忆',
        'memory.clearCold': '清空冷归档',
        'memory.coldCleared': '冷归档已清空',
      },
    }

    // ----------------------------------------------------------------- store

    /** Minimal external store: one snapshot, many subscribers. */
    function createStore(initial) {
      let value = initial
      const listeners = new Set()
      return {
        get: () => value,
        set(next) {
          value = next
          for (const listener of listeners) listener()
        },
        patch(partial) {
          value = { ...(value ?? {}), ...partial }
          for (const listener of listeners) listener()
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      }
    }

    const pending = createStore(null)
    const dialog = createStore(null)
    const toast = createStore(null)
    const revision = createStore(0)

    /**
     * Host-facing capabilities captured from the plugin context in `apply`, so
     * deep components can reach them without prop drilling.
     */
    const runtime = {
      openSession: undefined,
      archiveSession: undefined,
      cwd: undefined,
      sessionId: undefined,
      resolveCwd: undefined,
    }

    function useStore(store) {
      return useSyncExternalStore(store.subscribe, store.get, store.get)
    }

    function bump() {
      revision.set(revision.get() + 1)
    }

    let toastTimer
    function notify(message, tone) {
      toast.set({ id: Date.now(), message, tone: tone ?? 'default' })
      clearTimeout(toastTimer)
      toastTimer = setTimeout(() => toast.set(null), 3200)
    }

    // ------------------------------------------------------------------- api

    async function call(payload, init) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), init?.timeoutMs ?? API_TIMEOUT_MS)
      try {
        const response = await fetch(ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        })
        const text = await response.text()
        let parsed
        try {
          parsed = JSON.parse(text)
        } catch {
          throw new Error(text.slice(0, 300) || `HTTP ${response.status}`)
        }
        if (!parsed.ok) {
          const error = new Error(parsed.error || `HTTP ${response.status}`)
          error.code = parsed.code
          throw error
        }
        return parsed.data
      } finally {
        clearTimeout(timer)
      }
    }

    /** Save a Blob through the browser's download manager. */
    function saveBlob(blob, fileName) {
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = fileName
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      setTimeout(() => URL.revokeObjectURL(url), 4000)
    }

    // ------------------------------------------------------------------ icons

    function icon(children, size) {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: size ?? 16,
          height: size ?? 16,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          className: 'dss-icon',
        },
        ...children,
      )
    }

    const Icons = {
      rewind: () => icon([h('path', { key: 'a', d: 'M3.2 8a4.8 4.8 0 1 0 1.5-3.5' }), h('path', { key: 'b', d: 'M2.6 2.4v3h3' })]),
      // A pencil, not a circular arrow: this edits the user's question, it does
      // not repeat or restore anything. The circle was confusing in the action
      // row, where rewind already uses a circular arrow.
      edit: () =>
        icon([
          h('path', { key: 'a', d: 'M3 13.2 11.7 4.5l1.8 1.8L4.8 15H3z' }),
          h('path', { key: 'b', d: 'M10.4 5.8l1.8 1.8 1.3-1.3a.9.9 0 0 0 0-1.3l-.5-.5a.9.9 0 0 0-1.3 0z' }),
        ]),
      trash: () =>
        icon([
          h('path', { key: 'a', d: 'M2.6 4.3h10.8' }),
          h('path', { key: 'b', d: 'M6.3 4.3V2.9h3.4v1.4' }),
          h('path', { key: 'c', d: 'M4.2 4.3l.6 8.2a1 1 0 0 0 1 .9h4.4a1 1 0 0 0 1-.9l.6-8.2' }),
        ]),
      download: () =>
        icon([h('path', { key: 'a', d: 'M8 2.4v7.2' }), h('path', { key: 'b', d: 'M5 6.8 8 9.8l3-3' }), h('path', { key: 'c', d: 'M3 12.6h10' })]),
      clipboard: () =>
        icon([
          h('rect', { key: 'a', x: 3.4, y: 3.2, width: 9.2, height: 10.4, rx: 1.6 }),
          h('path', { key: 'b', d: 'M6 2.4h4v1.8H6z' }),
        ]),
      code: () => icon([h('path', { key: 'a', d: 'M5.6 4.6 2.6 8l3 3.4' }), h('path', { key: 'b', d: 'M10.4 4.6 13.4 8l-3 3.4' })]),
      cut: () =>
        icon([
          h('circle', { key: 'a', cx: 4.4, cy: 11.6, r: 1.9 }),
          h('circle', { key: 'b', cx: 11.6, cy: 11.6, r: 1.9 }),
          h('path', { key: 'c', d: 'M5.8 10.2 11.2 2.6' }),
          h('path', { key: 'd', d: 'M10.2 10.2 4.8 2.6' }),
        ]),
      lock: () => icon([h('rect', { key: 'a', x: 3.4, y: 7, width: 9.2, height: 6.4, rx: 1.4 }), h('path', { key: 'b', d: 'M5.6 7V5.4a2.4 2.4 0 0 1 4.8 0V7' })]),
      unlock: () => icon([h('rect', { key: 'a', x: 3.4, y: 7, width: 9.2, height: 6.4, rx: 1.4 }), h('path', { key: 'b', d: 'M5.6 7V5.4a2.4 2.4 0 0 1 4.6-.8' })]),
      restore: () => icon([h('path', { key: 'a', d: 'M3 8a5 5 0 1 1 1.6 3.7' }), h('path', { key: 'b', d: 'M2.6 2.8v3h3' })]),
      close: () => icon([h('path', { key: 'a', d: 'M4 4l8 8' }), h('path', { key: 'b', d: 'M12 4l-8 8' })]),
      info: () =>
        icon([
          h('circle', { key: 'a', cx: 8, cy: 8, r: 5.6 }),
          h('path', { key: 'b', d: 'M8 7.2v4' }),
          h('path', { key: 'c', d: 'M8 5.1v.1' }),
        ]),
      warning: () =>
        icon([
          h('circle', { key: 'a', cx: 8, cy: 8, r: 5.6 }),
          h('path', { key: 'b', d: 'M8 4.9v3.7' }),
          h('path', { key: 'c', d: 'M8 10.9v.1' }),
        ]),
      plus: () => icon([h('path', { key: 'a', d: 'M8 3.4v9.2' }), h('path', { key: 'b', d: 'M3.4 8h9.2' })]),
      arrowRight: () => icon([h('path', { key: 'a', d: 'M3.4 8h9.2' }), h('path', { key: 'b', d: 'M9 4.4 12.6 8 9 11.6' })]),
    }

    // ----------------------------------------------------------------- styles

    const CSS = `
.dss-icon { display: block; flex: none; }
.dss-menu-item-wrap { display: block; }
.dss-menu-item {
  display: flex; align-items: center; gap: 6px; width: 100%;
  min-height: 34px; padding: 6px 8px; border: 0;
  border-radius: var(--dsw-radius-md, 8px); background: transparent;
  font-size: 13px; line-height: 20px; text-align: left; cursor: pointer;
  color: var(--dsw-alias-label-primary, #1f1f1f);
}
.dss-menu-item:hover, .dss-menu-item:focus-visible {
  background: color-mix(in srgb, var(--dsw-alias-label-primary, #000) 8%, transparent);
  outline: none;
}
.dss-menu-item:disabled { opacity: .4; cursor: not-allowed; }
.dss-menu-item.dss-danger { color: var(--dsw-alias-state-error-primary, #d93025); }
.dss-menu-item.dss-danger:hover {
  background: var(--dsw-alias-interactive-bg-hover-danger, color-mix(in srgb, var(--dsw-alias-state-error-primary, #d93025) 12%, transparent));
}
.dss-menu-separator {
  height: .5px; margin: 4px 2px;
  background: var(--dsw-alias-border-l2, rgba(0,0,0,.1));
}
.dss-menu-icon { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; flex: none; }
.dss-menu-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.dss-action {
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; padding: 0; border: 0; border-radius: var(--dsw-radius-sm, 6px);
  background: transparent; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, #6b6b6b));
  cursor: pointer; transition: background .15s ease, color .15s ease;
}
.dss-action:hover {
  background: var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, var(--dsw-alias-label-primary, #000) 8%, transparent));
  color: var(--dsw-alias-label-secondary, #6b6b6b);
}
.dss-action.dss-danger:hover {
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #d93025) 14%, transparent);
  color: var(--dsw-alias-state-error-primary, #d93025);
}
.dss-action:disabled { opacity: .4; cursor: progress; }

.dss-banner {
  display: flex; gap: 10px; align-items: flex-start;
  margin: 0 0 8px; padding: 12px 14px; border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1, #f4f4f4);
  border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.06));
  color: var(--dsw-alias-label-primary, #1f1f1f);
  font-size: 13px; line-height: 20px;
}
.dss-banner-icon { color: var(--dsw-alias-brand-primary, #2f6feb); margin-top: 1px; }
.dss-banner-main { flex: 1 1 auto; min-width: 0; display: flex; gap: 10px; }
.dss-banner-text { display: flex; flex-direction: column; gap: 2px; }
.dss-banner-title { font-weight: 600; }
.dss-banner-body { color: var(--dsw-alias-label-secondary, #6b6b6b); }
.dss-banner-actions { display: flex; gap: 8px; align-items: center; flex: none; }

.dss-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  height: 30px; padding: 0 14px; border-radius: 8px; font-size: 13px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12));
  background: var(--dsw-alias-bg-layer-1, #fff);
  color: var(--dsw-alias-label-primary, #1f1f1f); cursor: pointer;
  transition: background .15s ease, border-color .15s ease;
}
.dss-btn:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary, #000) 6%, var(--dsw-alias-bg-layer-1, #fff)); }
.dss-btn:disabled { opacity: .55; cursor: progress; }
.dss-btn.dss-primary {
  background: var(--dsw-alias-label-primary, #1f1f1f);
  border-color: var(--dsw-alias-label-primary, #1f1f1f);
  color: var(--dsw-alias-bg-base, #fff);
}
.dss-btn.dss-primary:hover { opacity: .9; }
.dss-btn.dss-critical {
  background: var(--dsw-alias-state-error-primary, #d93025);
  border-color: var(--dsw-alias-state-error-primary, #d93025);
  color: #fff;
}
.dss-btn.dss-critical:hover { opacity: .9; }
.dss-btn.dss-ghost { border-color: transparent; background: transparent; }
.dss-btn.dss-ghost:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary, #000) 6%, transparent); }
.dss-btn.dss-small { height: 26px; padding: 0 10px; font-size: 12px; border-radius: 7px; }

.dss-scrim {
  position: fixed; inset: 0; z-index: 60; display: flex;
  align-items: center; justify-content: center; padding: 24px;
  background: rgba(15, 18, 24, .32); pointer-events: auto;
}
.dss-dialog {
  width: min(440px, 100%); border-radius: 12px; padding: 18px 18px 16px;
  background: var(--dsw-alias-bg-overlay, #fff);
  border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08));
  box-shadow: 0 18px 48px rgba(15, 18, 24, .22);
  color: var(--dsw-alias-label-primary, #1f1f1f);
  pointer-events: auto;
}
.dss-dialog-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.dss-dialog-icon { display: inline-flex; flex: none; color: var(--dsw-alias-state-error-primary, #d93025); }
.dss-dialog-title { flex: 1 1 auto; font-size: 15px; font-weight: 600; }
.dss-dialog-title.dss-critical { color: var(--dsw-alias-state-error-primary, #d93025); }
.dss-dialog-body { font-size: 13px; line-height: 21px; color: var(--dsw-alias-label-secondary, #6b6b6b); }
.dss-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
.dss-dialog-error { margin-top: 10px; font-size: 12px; color: var(--dsw-alias-state-error-primary, #d93025); }
.dss-dialog.dss-wide { width: min(720px, 100%); }
.dss-dialog-scroll { max-height: min(62vh, 560px); overflow-y: auto; margin-top: 12px; padding-right: 4px; }
.dss-dialog-actions.dss-wrap { flex-wrap: wrap; }

.dss-picker-scroll { margin-top: 10px; }
.dss-picker { display: flex; flex-direction: column; gap: 2px; }
.dss-pick {
  display: flex; align-items: flex-start; gap: 10px; padding: 8px 10px;
  border-radius: 8px; cursor: pointer; user-select: none;
}
.dss-pick:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary, #000) 5%, transparent); }
.dss-pick input { margin-top: 3px; accent-color: var(--dsw-alias-brand-primary, #2563eb); }
.dss-pick-main { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.dss-pick-title {
  font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-primary, #1f1f1f);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dss-pick-sub {
  font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary, #6b6b6b);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dss-note { margin-top: 10px; font-size: 12.5px; color: var(--dsw-alias-state-success-primary, #1a7f37); }
.dss-curate {
  display: flex; align-items: flex-start; gap: 10px; margin-top: 12px;
  padding: 10px 12px; border-radius: 8px; cursor: pointer;
  border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08));
  background: var(--dsw-alias-bg-layer-1, #fff);
}
.dss-curate input { margin-top: 3px; accent-color: var(--dsw-alias-brand-primary, #2563eb); }
.dss-curate-text { display: flex; flex-direction: column; gap: 2px; }
.dss-curate-title { font-size: 13px; color: var(--dsw-alias-label-primary, #1f1f1f); }
.dss-curate-hint { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary, #6b6b6b); }
.dss-curate-inline { margin-top: 0; padding: 6px 10px; border-color: transparent; background: transparent; }

.dss-tabs { display: flex; gap: 4px; flex-wrap: wrap; }
.dss-tab {
  height: 28px; padding: 0 12px; border-radius: 999px; font-size: 12.5px; cursor: pointer;
  border: 1px solid transparent; background: transparent;
  color: var(--dsw-alias-label-secondary, #6b6b6b);
}
.dss-tab:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary, #000) 6%, transparent); }
.dss-tab.dss-tab-on {
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #2563eb) 12%, transparent);
  color: var(--dsw-alias-brand-primary, #2563eb); font-weight: 600;
}
.dss-mem-pending {
  display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border-radius: 10px;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-brand-primary, #2563eb) 30%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #2563eb) 6%, transparent);
}
.dss-mem-pending-hint { font-size: 12px; color: var(--dsw-alias-label-secondary, #6b6b6b); }
.dss-warn {
  margin-top: 10px; padding: 8px 10px; border-radius: 8px; font-size: 12.5px; line-height: 19px;
  color: var(--dsw-alias-state-warn-primary, #9a6700);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #9a6700) 12%, transparent);
}
.dss-hint { margin-top: 12px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary, #6b6b6b); }

.dss-toast {
  position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%);
  z-index: 70; padding: 9px 14px; border-radius: 999px; pointer-events: none;
  font-size: 13px; color: var(--dsw-alias-bg-base, #fff);
  background: var(--dsw-alias-label-primary, #1f1f1f);
  box-shadow: 0 8px 24px rgba(15, 18, 24, .24);
}
.dss-toast.dss-error { background: var(--dsw-alias-state-error-primary, #d93025); }

.dss-section { display: flex; flex-direction: column; gap: 12px; max-width: 720px; }
.dss-section.dss-embedded { max-width: none; gap: 10px; }
.dss-section h2 { margin: 0; font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary, #1f1f1f); }
.dss-section-head { display: flex; flex-direction: column; gap: 4px; }
.dss-section-title { font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary, #1f1f1f); }
.dss-section-desc { font-size: 12.5px; line-height: 19px; color: var(--dsw-alias-label-secondary, #6b6b6b); }
.dss-card {
  border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08));
  border-radius: 10px; background: var(--dsw-alias-bg-layer-1, #fff);
}
.dss-row {
  display: flex; align-items: center; gap: 10px; padding: 10px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.06));
}
.dss-row:last-child { border-bottom: 0; }
.dss-row-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.dss-row-title { font-size: 13px; color: var(--dsw-alias-label-primary, #1f1f1f); display: flex; align-items: center; gap: 6px; }
.dss-row-meta { font-size: 12px; color: var(--dsw-alias-label-secondary, #6b6b6b); display: flex; gap: 10px; flex-wrap: wrap; }
.dss-badge {
  display: inline-flex; align-items: center; height: 18px; padding: 0 6px;
  border-radius: 999px; font-size: 11px; line-height: 18px;
  background: color-mix(in srgb, var(--dsw-alias-label-primary, #000) 7%, transparent);
  color: var(--dsw-alias-label-secondary, #6b6b6b);
}
.dss-badge.dss-locked { background: color-mix(in srgb, var(--dsw-alias-brand-primary, #2f6feb) 14%, transparent); color: var(--dsw-alias-brand-primary, #2f6feb); }
.dss-badge.dss-temp { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary, #b07b00) 16%, transparent); color: var(--dsw-alias-state-warn-primary, #b07b00); }
.dss-empty { padding: 18px 12px; font-size: 13px; color: var(--dsw-alias-label-secondary, #6b6b6b); }
.dss-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dss-select {
  height: 30px; border-radius: 8px; padding: 0 8px; font-size: 13px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12));
  background: var(--dsw-alias-bg-layer-1, #fff);
  color: var(--dsw-alias-label-primary, #1f1f1f); max-width: 100%;
}
.dss-ws-picker { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 2px 0 6px; }
.dss-ws-label { font-size: 12px; color: var(--dsw-alias-label-secondary, #6b6b6b); }
.dss-ws-picker .dss-select { flex: 0 1 260px; min-width: 0; }
.dss-maint {
  display: flex; flex-wrap: wrap; gap: 4px 14px; align-items: baseline;
  padding-top: 8px; font-size: 11px; line-height: 1.5;
  color: var(--dsw-alias-label-tertiary, #8a8a8a);
}
.dss-maint-when { flex: 0 0 auto; }
.dss-maint-report { flex: 0 0 auto; font-variant-numeric: tabular-nums; }
.dss-input {
  flex: 1 1 auto; min-width: 0; height: 30px; padding: 0 9px; font-size: 13px;
  border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12));
  background: var(--dsw-alias-bg-base, #fff); color: var(--dsw-alias-label-primary, #1f1f1f);
}
.dss-group-title { font-size: 12px; font-weight: 600; letter-spacing: .02em; text-transform: uppercase; color: var(--dsw-alias-label-secondary, #6b6b6b); }
.dss-memory-text { font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-primary, #1f1f1f); word-break: break-word; }
.dss-row-actions { display: flex; align-items: center; gap: 4px; flex: none; }
.dss-spin { width: 14px; height: 14px; border-radius: 50%; border: 2px solid currentColor; border-top-color: transparent; animation: dss-spin .8s linear infinite; }
@keyframes dss-spin { to { transform: rotate(360deg); } }
`

    function installStyles() {
      const element = document.createElement('style')
      element.setAttribute('data-dsh-session-suite', '')
      element.textContent = CSS
      document.head.appendChild(element)
      return () => element.remove()
    }

    // ------------------------------------------------------------- primitives

    function MenuRow({ label, iconNode, danger, separator, disabled, onSelect }) {
      const className = ['dss-menu-item', danger ? 'dss-danger' : ''].filter(Boolean).join(' ')
      const button = h(
        'button',
        { type: 'button', role: 'menuitem', className, disabled, title: label, onClick: onSelect },
        iconNode ? h('span', { className: 'dss-menu-icon' }, iconNode) : null,
        h('span', { className: 'dss-menu-label' }, label),
      )
      return h(
        'div',
        { className: 'dss-menu-item-wrap' },
        separator ? h('div', { className: 'dss-menu-separator', role: 'separator' }) : null,
        button,
      )
    }

    function DialogFrame({ title, critical, wide, onClose, children }) {
      const ref = useRef(null)
      useEffect(() => {
        const onKey = event => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            onClose()
          }
        }
        document.addEventListener('keydown', onKey, true)
        ref.current?.focus()
        return () => document.removeEventListener('keydown', onKey, true)
      }, [onClose])
      return h(
        'div',
        {
          className: 'dss-scrim',
          onMouseDown: event => {
            if (event.target === event.currentTarget) onClose()
          },
        },
        h(
          'div',
          {
            className: 'dss-dialog' + (wide ? ' dss-wide' : ''),
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': title,
            tabIndex: -1,
            ref,
          },
          h(
            'div',
            { className: 'dss-dialog-head' },
            critical
              ? h('span', { className: 'dss-dialog-icon', 'aria-hidden': true }, h(Icons.warning, null))
              : null,
            h('div', { className: 'dss-dialog-title' }, title),
            h('button', { type: 'button', className: 'dss-action', onClick: onClose, 'aria-label': 'Close' }, h(Icons.close, null)),
          ),
          children,
        ),
      )
    }

    // --------------------------------------------------------------- overlay

    function SelectSessionDialog({ state, onClose }) {
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [preview, setPreview] = useState(null)
      const t = state.t ?? (key => key)

      // Deleting a session also deletes the subagent sessions it started, so the
      // dialog says how many before the user commits rather than after. A failed
      // preview never blocks the dialog: the confirm button still works and the
      // Host reports the real reason on submit.
      useEffect(() => {
        if (state.mode !== 'delete-session' || !state.sessionId) return undefined
        let alive = true
        call({ action: 'previewDelete', sessionId: state.sessionId })
          .then(data => {
            if (alive) setPreview(data)
          })
          .catch(() => {})
        return () => {
          alive = false
        }
      }, [state.mode, state.sessionId])

      const confirm = async () => {
        setBusy(true)
        setError(null)
        try {
          if (state.mode === 'delete-session') {
            // Close the open view first: the Host then finds the session idle
            // and the sidebar drops it without leaving a dead panel behind.
            try {
              await runtime.archiveSession?.(state.sessionId)
            } catch {
              // The Host route below reports the precise reason (e.g. still running).
            }
            const removed = await call({ action: 'deleteSession', sessionId: state.sessionId })
            // Repeat the archive: the Host now knows the session is gone, so this
            // pass always takes the durable path and drops the sidebar row.
            try {
              await runtime.archiveSession?.(state.sessionId)
            } catch {
              // Already archived is the common, fine outcome.
            }
            notify(removed?.stillListed ? t('dialog.deleteStale') : t('dialog.deleteDone'))
          } else if (state.onConfirm) {
            await state.onConfirm()
            if (state.doneMessage) notify(state.doneMessage)
          }
          onClose()
          bump()
        } catch (failure) {
          const message = failure?.code === 'session-running' ? t('dialog.sessionRunning') : failure?.message ?? t('toast.failed')
          setError(message)
        } finally {
          setBusy(false)
        }
      }

      const linked = preview && Array.isArray(preview.subagents) ? preview.subagents.length : 0
      const terminating = preview?.willRefuse === true
      const body = state.mode === 'delete-session'
        ? h(
            'div',
            { className: 'dss-dialog-body' },
            t('dialog.deleteBody'),
            state.onlyMessage ? h('div', { style: { marginTop: 8 } }, t('message.deleteOnly')) : null,
            linked > 0
              ? h(
                  'div',
                  { style: { marginTop: 8, fontWeight: 600 } },
                  t('dialog.deleteSubagents', { n: linked }),
                )
              : null,
            terminating
              ? h('div', { style: { marginTop: 8 } }, t('dialog.deleteWouldRefuse'))
              : null,
          )
        : h('div', { className: 'dss-dialog-body' }, state.body)

      return h(
        DialogFrame,
        { title: state.mode === 'delete-session' ? t('dialog.deleteTitle') : state.title, critical: true, onClose: busy ? () => {} : onClose },
        body,
        error ? h('div', { className: 'dss-dialog-error' }, error) : null,
        h(
          'div',
          { className: 'dss-dialog-actions' },
          h('button', { type: 'button', className: 'dss-btn', onClick: onClose, disabled: busy }, t('dialog.cancel')),
          h(
            'button',
            { type: 'button', className: 'dss-btn dss-critical', onClick: confirm, disabled: busy },
            busy ? h('span', { className: 'dss-spin' }) : null,
            busy ? t('dialog.deleting') : (state.confirmLabel ?? t('dialog.delete')),
          ),
        ),
      )
    }

    // ------------------------------------------------------ turn selection

    /** Load the turn outline a share or segment dialog works on. */
    function useOutline(sessionId) {
      const [state, setState] = useState({ loading: true, outline: null, error: null })
      useEffect(() => {
        let alive = true
        call({ action: 'outline', sessionId })
          .then(outline => alive && setState({ loading: false, outline, error: null }))
          .catch(error => alive && setState({ loading: false, outline: null, error: error.message }))
        return () => {
          alive = false
        }
      }, [sessionId])
      return state
    }

    /** Every turn starts selected: sharing or deleting everything is the default. */
    function useTurnSelection(outline) {
      const [selected, setSelected] = useState(() => new Set())
      useEffect(() => {
        setSelected(new Set((outline?.turns ?? []).map(row => row.turn)))
      }, [outline])
      const toggle = useCallback(turn => {
        setSelected(current => {
          const next = new Set(current)
          if (next.has(turn)) next.delete(turn)
          else next.add(turn)
          return next
        })
      }, [])
      const all = useCallback(() => setSelected(new Set((outline?.turns ?? []).map(row => row.turn))), [outline])
      const none = useCallback(() => setSelected(new Set()), [])
      return { selected, toggle, all, none }
    }

    function rangesOf(outline, selected) {
      return (outline?.turns ?? [])
        .filter(row => selected.has(row.turn))
        .map(row => ({ startSeq: row.startSeq, endSeq: row.endSeq }))
    }

    function TurnPicker({ outline, selected, onToggle, t }) {
      const turns = outline?.turns ?? []
      if (turns.length === 0) return h('div', { className: 'dss-empty' }, t('settings.empty'))
      return h(
        'div',
        { className: 'dss-picker' },
        ...turns.map(row => {
          const checked = selected.has(row.turn)
          return h(
            'label',
            { key: row.turn, className: 'dss-pick' + (checked ? ' dss-pick-on' : '') },
            h('input', { type: 'checkbox', checked, onChange: () => onToggle(row.turn) }),
            h(
              'span',
              { className: 'dss-pick-main' },
              h('span', { className: 'dss-pick-title' }, `${t('settings.turn', { turn: row.turn })} · ${row.preview || '—'}`),
              row.answerPreview ? h('span', { className: 'dss-pick-sub' }, row.answerPreview) : null,
            ),
          )
        }),
      )
    }

    function SelectionToolbar({ t, outline, selected, onAll, onNone }) {
      const total = outline?.turns?.length ?? 0
      return h(
        'div',
        { className: 'dss-toolbar' },
        h('span', { className: 'dss-group-title' }, t('share.selected', { count: selected.size, total })),
        h('button', { type: 'button', className: 'dss-btn dss-small dss-ghost', onClick: onAll }, t('share.all')),
        h('button', { type: 'button', className: 'dss-btn dss-small dss-ghost', onClick: onNone }, t('share.none')),
      )
    }

    /**
     * Draw the selected conversation into a PNG with the 2D canvas API.
     *
     * The Host already parsed the Markdown (export format `blocks`), so this is
     * purely layout: inline runs become wrapped lines, blocks become one card per
     * reply, and the user's prompts sit in blue bubbles on the right.
     */
    async function renderConversationImage({ title, meta, footer, messages }) {
      const WIDTH = 880
      const PAGE_PAD = 40
      const CARD_PAD = 22
      const SCALE = 2
      const SANS = '-apple-system, "Segoe UI", "Microsoft YaHei", Roboto, sans-serif'
      const MONO = 'ui-monospace, SFMono-Regular, Consolas, monospace'
      const font = (size, weight) => `${weight ? `${weight} ` : ''}${size}px ${SANS}`
      const mono = size => `${size}px ${MONO}`
      const palette = {
        page: '#f4f5f7',
        card: '#ffffff',
        fg: '#1b1d21',
        muted: '#8a8f98',
        user: '#2563eb',
        userFg: '#ffffff',
        quote: '#f5f7fa',
        accent: '#2563eb',
        code: '#f6f7f9',
        codeFg: '#3a3f46',
        chipFg: '#3a3f46',
        line: '#eceef1',
      }

      const measure = document.createElement('canvas').getContext('2d')
      const cardWidth = WIDTH - PAGE_PAD * 2
      const contentWidth = cardWidth - CARD_PAD * 2
      const bubbleMax = Math.round(cardWidth * 0.8)

      /** Decode a data URL into an image the canvas can draw. */
      const loadImage = source =>
        new Promise(resolve => {
          if (!source) {
            resolve(null)
            return
          }
          const image = new Image()
          image.onload = () => resolve(image)
          image.onerror = () => resolve(null)
          image.src = source
        })

      // Screenshots arrive inline (the Host already resolved the attachments), so
      // they are decoded before layout to know their aspect ratio.
      const prepared = []
      for (const message of messages) {
        const images = []
        for (const image of message.images ?? []) {
          const element = await loadImage(image.dataUrl)
          if (element) images.push({ ...image, element })
        }
        prepared.push({ ...message, images })
      }

      const roundRect = (ctx, x, y, w, h, r) => {
        ctx.beginPath()
        if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, r)
        else {
          const radius = Math.min(r, w / 2, h / 2)
          ctx.moveTo(x + radius, y)
          ctx.arcTo(x + w, y, x + w, y + h, radius)
          ctx.arcTo(x + w, y + h, x, y + h, radius)
          ctx.arcTo(x, y + h, x, y, radius)
          ctx.arcTo(x, y, x + w, y, radius)
          ctx.closePath()
        }
      }

      /** Wrap inline runs into lines of styled segments. */
      const wrapRuns = (runs, maxWidth, baseFont, baseFill) => {
        const lines = []
        let segments = []
        let width = 0
        const append = segment => {
          const last = segments[segments.length - 1]
          if (last && last.font === segment.font && last.fill === segment.fill) last.text += segment.text
          else segments.push({ ...segment })
        }
        for (const run of runs ?? []) {
          const style = baseFont
            ? { font: baseFont, fill: baseFill ?? palette.fg }
            : run.code
              ? { font: mono(13), fill: palette.chipFg }
              : { font: font(15, run.bold ? '600' : undefined), fill: palette.fg }
          measure.font = style.font
          for (const char of String(run.text ?? '')) {
            const advance = measure.measureText(char).width
            if (width + advance > maxWidth && segments.length > 0) {
              lines.push({ segments, width })
              segments = []
              width = 0
            }
            append({ text: char, font: style.font, fill: style.fill })
            width += advance
          }
        }
        lines.push({ segments, width })
        return lines
      }

      /** Wrap one plain string with a fixed style. */
      const wrapPlain = (text, textFont, fill, maxWidth) => {
        const lines = []
        let segments = []
        let width = 0
        measure.font = textFont
        for (const char of String(text)) {
          const advance = measure.measureText(char).width
          if (width + advance > maxWidth && segments.length > 0) {
            lines.push({ segments, width })
            segments = []
            width = 0
          }
          const last = segments[segments.length - 1]
          if (last) last.text += char
          else segments.push({ text: char, font: textFont, fill })
          width += advance
        }
        lines.push({ segments, width })
        return lines
      }

      const groupSections = () => {
        const sections = []
        for (const message of prepared) {
          if (message.role === 'user') {
            sections.push({ role: 'user', blocks: message.blocks ?? [], images: message.images ?? [] })
            continue
          }
          const last = sections[sections.length - 1]
          if (last && last.role === 'assistant' && last.turn === message.turn) last.blocks.push(...(message.blocks ?? []))
          else sections.push({ role: 'assistant', turn: message.turn, blocks: [...(message.blocks ?? [])] })
        }
        return sections
      }

      /** Lay out one assistant card's Markdown blocks. */
      const layoutBlocks = blocks => {
        const ops = []
        let y = 0
        for (const block of blocks) {
          if (block.type === 'heading') {
            const size = block.level <= 2 ? 19 : block.level === 3 ? 17 : 15
            const lines = wrapRuns(block.runs, contentWidth, font(size, '600'), palette.fg)
            if (y > 0) y += 12
            for (const line of lines) {
              ops.push({ kind: 'line', x: 0, y: y + Math.round(size * 0.85) + 4, segments: line.segments })
              y += Math.round(size * 1.55)
            }
            y += 4
            continue
          }
          if (block.type === 'paragraph') {
            for (const line of wrapRuns(block.runs, contentWidth, font(15), palette.fg)) {
              ops.push({ kind: 'line', x: 0, y: y + 17, segments: line.segments })
              y += 24
            }
            y += 9
            continue
          }
          if (block.type === 'list') {
            for (const [index, item] of (block.items ?? []).entries()) {
              const indent = Math.min(3, item.indent ?? 0) * 18
              const lines = wrapRuns(item.runs, contentWidth - indent - 22, font(15), palette.fg)
              for (const [lineIndex, line] of lines.entries()) {
                if (lineIndex === 0) {
                  ops.push({
                    kind: 'text',
                    x: indent,
                    y: y + 17,
                    text: block.ordered ? `${(block.start ?? 1) + index}.` : '•',
                    font: font(15),
                    fill: palette.muted,
                  })
                }
                ops.push({ kind: 'line', x: indent + 22, y: y + 17, segments: line.segments })
                y += 24
              }
            }
            y += 9
            continue
          }
          if (block.type === 'quote') {
            const lines = []
            for (const runs of block.lines ?? []) lines.push(...wrapRuns(runs, contentWidth - 34, font(15), palette.fg))
            const height = lines.length * 24 + 16
            ops.push({ kind: 'quote', y, height })
            lines.forEach((line, index) => {
              ops.push({ kind: 'line', x: 16, y: y + 8 + index * 24 + 17, segments: line.segments })
            })
            y += height + 10
            continue
          }
          if (block.type === 'code') {
            const lines = String(block.text ?? '')
              .split('\n')
              .flatMap(raw => wrapPlain(raw === '' ? ' ' : raw, mono(13), palette.codeFg, contentWidth - 26))
            const height = lines.length * 21 + 18
            ops.push({ kind: 'code', y, height })
            lines.forEach((line, index) => {
              ops.push({ kind: 'line', x: 13, y: y + 9 + index * 21 + 15, segments: line.segments })
            })
            y += height + 10
            continue
          }
          if (block.type === 'table') {
            const columnCount = Math.max(1, block.headers?.length ?? 0, ...(block.rows ?? []).map(row => row.length))
            const plainOf = runs => (runs ?? []).map(run => run.text ?? '').join('')
            const natural = new Array(columnCount).fill(52)
            const bump = (runs, column, bold) => {
              measure.font = font(13, bold ? '600' : undefined)
              natural[column] = Math.max(natural[column], measure.measureText(plainOf(runs)).width + 20)
            }
            ;(block.headers ?? []).forEach((runs, column) => bump(runs, column, true))
            for (const row of block.rows ?? []) row.forEach((runs, column) => bump(runs, column, false))
            const naturalTotal = natural.reduce((sum, value) => sum + value, 0)
            const factor = naturalTotal > contentWidth ? contentWidth / naturalTotal : 1
            const widths = natural.map(value => Math.round(value * factor))
            const rows = [
              { header: true, cells: block.headers ?? [] },
              ...(block.rows ?? []).map(row => ({ header: false, cells: row })),
            ]
            const laid = rows.map(row => ({
              header: row.header,
              cells: row.cells.map((runs, column) =>
                wrapRuns(runs, Math.max(24, widths[column] - 16), font(13, row.header ? '600' : undefined), palette.fg),
              ),
            }))
            const rowHeights = laid.map(row => Math.max(...row.cells.map(lines => lines.length)) * 21 + 14)
            const height = rowHeights.reduce((sum, value) => sum + value, 0)
            ops.push({ kind: 'table', y, height, widths, rows: laid, rowHeights })
            y += height + 10
            continue
          }
          if (block.type === 'hr') {
            ops.push({ kind: 'hr', y })
            y += 16
          }
        }
        return { ops, height: Math.max(0, y - 9) }
      }

      const sections = groupSections().map(section => {
        if (section.role === 'user') {
          const lines = []
          for (const block of section.blocks) {
            if (block.type === 'code') {
              lines.push(...wrapPlain(block.text ?? '', mono(13), palette.userFg, bubbleMax - 30))
              continue
            }
            if (block.type === 'list') {
              for (const item of block.items ?? []) {
                const prefix = block.ordered ? '· ' : '· '
                lines.push(...wrapRuns([{ text: prefix }, ...(item.runs ?? [])], bubbleMax - 30, font(15), palette.userFg))
              }
              continue
            }
            lines.push(...wrapRuns(block.runs ?? [], bubbleMax - 30, font(15), palette.userFg))
          }
          const width = Math.min(bubbleMax, Math.max(80, ...lines.map(line => line.width)) + 30)
          const height = lines.length * 24 + 20
          // Screenshots sit above the prompt, right-aligned like the bubble. They
          // take the full content width — a screenshot is usually the point of the
          // message, and a narrow slot is what made them look downscaled. Aspect
          // ratio is preserved; a tall one is capped by height instead.
          const images = []
          for (const image of section.images ?? []) {
            if (!image.element) continue
            const ratio = image.element.height / image.element.width || 1
            let width = Math.min(contentWidth, image.element.width)
            let height = width * ratio
            const maxHeight = 900
            if (height > maxHeight) {
              height = maxHeight
              width = Math.round(height / ratio)
            }
            images.push({ element: image.element, width: Math.round(width), height: Math.round(height) })
          }
          return { kind: 'user', lines, width, height, images }
        }
        const layout = layoutBlocks(section.blocks)
        return { kind: 'assistant', turn: section.turn, ops: layout.ops, height: layout.height + CARD_PAD * 2 }
      })

      for (const section of sections) {
        if (section.kind === 'user' && section.images.length > 0) {
          section.imagesHeight = section.images.reduce((sum, image) => sum + image.height + 10, 0)
          section.height += section.imagesHeight
        }
      }

      const headerHeight = 118
      const footerHeight = 52
      const gap = 18
      const bodyHeight = sections.reduce((sum, section) => sum + section.height + gap, 0)
      const height = headerHeight + bodyHeight + footerHeight

      const canvas = document.createElement('canvas')
      canvas.width = WIDTH * SCALE
      canvas.height = Math.ceil(height * SCALE)
      const ctx = canvas.getContext('2d')
      ctx.scale(SCALE, SCALE)
      ctx.textBaseline = 'alphabetic'

      ctx.fillStyle = palette.page
      ctx.fillRect(0, 0, WIDTH, height)

      ctx.fillStyle = palette.fg
      const titleLines = wrapPlain(title || 'Session', font(26, '600'), palette.fg, cardWidth).slice(0, 2)
      let headerY = PAGE_PAD + 24
      for (const line of titleLines) {
        ctx.font = font(26, '600')
        ctx.fillText(line.segments.map(segment => segment.text).join(''), PAGE_PAD, headerY)
        headerY += 34
      }
      ctx.fillStyle = palette.muted
      ctx.font = font(12)
      ctx.fillText(meta, PAGE_PAD, headerY + 4)

      let y = headerHeight
      for (const section of sections) {
        if (section.kind === 'user') {
          let cursorY = y
          for (const image of section.images ?? []) {
            const imageX = WIDTH - PAGE_PAD - image.width
            ctx.save()
            roundRect(ctx, imageX, cursorY, image.width, image.height, 12)
            ctx.clip()
            ctx.drawImage(image.element, imageX, cursorY, image.width, image.height)
            ctx.restore()
            ctx.strokeStyle = palette.line
            roundRect(ctx, imageX, cursorY, image.width, image.height, 12)
            ctx.stroke()
            cursorY += image.height + 10
          }
          const bubbleTop = y + (section.imagesHeight ?? 0)
          const bubbleHeight = section.height - (section.imagesHeight ?? 0)
          const x = WIDTH - PAGE_PAD - section.width
          ctx.fillStyle = palette.user
          roundRect(ctx, x, bubbleTop, section.width, bubbleHeight, 14)
          ctx.fill()
          section.lines.forEach((line, index) => {
            let cursor = x + 15
            const baseline = bubbleTop + 10 + index * 24 + 17
            for (const segment of line.segments) {
              ctx.font = segment.font
              ctx.fillStyle = segment.fill
              ctx.fillText(segment.text, cursor, baseline)
              measure.font = segment.font
              cursor += measure.measureText(segment.text).width
            }
          })
        } else {
          ctx.save()
          ctx.shadowColor = 'rgba(16, 18, 20, 0.06)'
          ctx.shadowBlur = 10
          ctx.shadowOffsetY = 2
          ctx.fillStyle = palette.card
          roundRect(ctx, PAGE_PAD, y, cardWidth, section.height, 14)
          ctx.fill()
          ctx.restore()

          const originX = PAGE_PAD + CARD_PAD
          const originY = y + CARD_PAD
          for (const op of section.ops) {
            if (op.kind === 'quote') {
              ctx.fillStyle = palette.quote
              roundRect(ctx, originX, originY + op.y, contentWidth, op.height, 10)
              ctx.fill()
              ctx.fillStyle = palette.accent
              ctx.fillRect(originX, originY + op.y, 3, op.height)
            } else if (op.kind === 'code') {
              ctx.fillStyle = palette.code
              roundRect(ctx, originX, originY + op.y, contentWidth, op.height, 10)
              ctx.fill()
            } else if (op.kind === 'table') {
              const tableWidth = op.widths.reduce((sum, value) => sum + value, 0)
              let rowTop = originY + op.y
              op.rows.forEach((row, rowIndex) => {
                const rowHeight = op.rowHeights[rowIndex]
                if (row.header) {
                  ctx.fillStyle = palette.quote
                  ctx.fillRect(originX, rowTop, tableWidth, rowHeight)
                }
                let cellX = originX
                row.cells.forEach((lines, column) => {
                  lines.forEach((line, lineIndex) => {
                    let cursor = cellX + 8
                    const baseline = rowTop + 7 + lineIndex * 21 + 15
                    for (const segment of line.segments) {
                      ctx.font = segment.font
                      ctx.fillStyle = segment.fill
                      ctx.fillText(segment.text, cursor, baseline)
                      measure.font = segment.font
                      cursor += measure.measureText(segment.text).width
                    }
                  })
                  cellX += op.widths[column]
                })
                ctx.strokeStyle = palette.line
                ctx.beginPath()
                ctx.moveTo(originX, rowTop + rowHeight)
                ctx.lineTo(originX + tableWidth, rowTop + rowHeight)
                ctx.stroke()
                rowTop += rowHeight
              })
            } else if (op.kind === 'hr') {
              ctx.strokeStyle = palette.line
              ctx.beginPath()
              ctx.moveTo(originX, originY + op.y)
              ctx.lineTo(originX + contentWidth, originY + op.y)
              ctx.stroke()
            } else if (op.kind === 'text') {
              ctx.font = op.font
              ctx.fillStyle = op.fill
              ctx.fillText(op.text, originX + op.x, originY + op.y)
            } else {
              let cursor = originX + op.x
              for (const segment of op.segments) {
                ctx.font = segment.font
                ctx.fillStyle = segment.fill
                ctx.fillText(segment.text, cursor, originY + op.y)
                measure.font = segment.font
                cursor += measure.measureText(segment.text).width
              }
            }
          }
        }
        y += section.height + gap
      }

      ctx.fillStyle = palette.muted
      ctx.font = font(12)
      ctx.textAlign = 'center'
      ctx.fillText(footer, WIDTH / 2, height - 22)
      ctx.textAlign = 'left'

      return await new Promise((resolve, reject) => {
        canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('canvas could not produce a PNG'))), 'image/png')
      })
    }

    function ShareDialog({ state, onClose }) {
      const t = state.t ?? (key => key)
      const { loading, outline, error } = useOutline(state.sessionId)
      const { selected, toggle, all, none } = useTurnSelection(outline)
      const [busy, setBusy] = useState(null)
      const [note, setNote] = useState(null)
      const [finalOnly, setFinalOnly] = useState(true)

      const ranges = rangesOf(outline, selected)
      const ready = ranges.length > 0
      const mode = finalOnly ? 'final' : 'all'

      const run = async (kind, operation) => {
        if (!ready) {
          setNote(t('share.needSelection'))
          return
        }
        setBusy(kind)
        setNote(null)
        try {
          await operation()
        } catch (failure) {
          setNote(failure?.message ?? t('share.failed'))
        } finally {
          setBusy(null)
        }
      }

      const exportFile = format =>
        run(format, async () => {
          const result = await call({ action: 'export', sessionId: state.sessionId, format, ranges, mode })
          saveBlob(new Blob([result.body], { type: result.contentType }), result.fileName)
          setNote(t('share.done'))
        })

      const copyText = () =>
        run('txt', async () => {
          const result = await call({ action: 'export', sessionId: state.sessionId, format: 'txt', ranges, mode })
          await navigator.clipboard.writeText(result.body)
          setNote(t('share.copied'))
        })

      const exportImage = () =>
        run('image', async () => {
          const result = await call({ action: 'export', sessionId: state.sessionId, format: 'blocks', ranges, mode })
          const payload = JSON.parse(result.body)
          const turns = new Set(payload.messages.map(message => message.turn).filter(turn => typeof turn === 'number')).size
          const exported = new Date().toISOString().slice(0, 16).replace('T', ' ')
          const blob = await renderConversationImage({
            title: payload.title || outline?.title || 'Session',
            meta: `${t('share.metaTurns', { turns, messages: payload.messages.length })} · ${t('share.exportedAt', { time: exported })}`,
            footer: t('share.imageFooter'),
            messages: payload.messages,
          })
          saveBlob(blob, `${(payload.title || 'session').replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 40)}.png`)
          setNote(t('share.done'))
        })

      return h(
        DialogFrame,
        { title: t('share.title'), wide: true, onClose: busy ? () => {} : onClose },
        h('div', { className: 'dss-dialog-body' }, t('share.hint')),
        loading
          ? h('div', { className: 'dss-empty' }, t('settings.loading'))
          : error
            ? h('div', { className: 'dss-dialog-error' }, error)
            : h(
                React.Fragment,
                null,
                h(SelectionToolbar, { t, outline, selected, onAll: all, onNone: none }),
                h('div', { className: 'dss-dialog-scroll dss-picker-scroll' }, h(TurnPicker, { outline, selected, onToggle: toggle, t })),
                h(
                  'label',
                  { className: 'dss-curate' },
                  h('input', {
                    type: 'checkbox',
                    checked: finalOnly,
                    onChange: event => setFinalOnly(event.target.checked),
                  }),
                  h(
                    'span',
                    { className: 'dss-curate-text' },
                    h('span', { className: 'dss-curate-title' }, t('share.curate')),
                    h('span', { className: 'dss-curate-hint' }, t('share.curateHint')),
                  ),
                ),
                note ? h('div', { className: 'dss-note' }, note) : null,
                h(
                  'div',
                  { className: 'dss-dialog-actions dss-wrap' },
                  h(
                    'button',
                    { type: 'button', className: 'dss-btn dss-primary', disabled: !ready || busy !== null, onClick: exportImage },
                    busy === 'image' ? h('span', { className: 'dss-spin' }) : null,
                    t('share.image'),
                  ),
                  h(
                    'button',
                    { type: 'button', className: 'dss-btn', disabled: !ready || busy !== null, onClick: () => exportFile('html') },
                    t('share.html'),
                  ),
                  h(
                    'button',
                    { type: 'button', className: 'dss-btn', disabled: !ready || busy !== null, onClick: () => exportFile('md') },
                    t('share.markdown'),
                  ),
                  h(
                    'button',
                    { type: 'button', className: 'dss-btn', disabled: !ready || busy !== null, onClick: () => exportFile('json') },
                    t('share.json'),
                  ),
                  h(
                    'button',
                    { type: 'button', className: 'dss-btn dss-ghost', disabled: !ready || busy !== null, onClick: copyText },
                    t('share.copy'),
                  ),
                ),
                h('div', { className: 'dss-hint' }, t('share.linkNote')),
              ),
      )
    }

    function SegmentDialog({ state, onClose }) {
      const t = state.t ?? (key => key)
      const { loading, outline, error } = useOutline(state.sessionId)
      const { selected, toggle, all, none } = useTurnSelection(outline)
      const [busy, setBusy] = useState(false)
      const [problem, setProblem] = useState(null)

      const turns = outline?.turns ?? []
      const picked = turns.filter(row => selected.has(row.turn))
      const first = picked[0]
      const lastTurn = turns.length > 0 ? turns[turns.length - 1].turn : undefined
      const partial = picked.length > 0 && picked.length < turns.length

      const confirm = async () => {
        if (!first) {
          setProblem(t('segment.needSelection'))
          return
        }
        setBusy(true)
        setProblem(null)
        try {
          const result = await call({ action: 'deleteSegment', sessionId: state.sessionId, startSeq: first.startSeq })
          if (result?.childId) runtime.openSession?.(result.childId)
          notify(t('segment.done'))
          onClose()
          bump()
        } catch (failure) {
          setProblem(failure?.message ?? t('segment.failed'))
        } finally {
          setBusy(false)
        }
      }

      return h(
        DialogFrame,
        { title: t('segment.title'), critical: true, wide: true, onClose: busy ? () => {} : onClose },
        h('div', { className: 'dss-dialog-body' }, t('segment.hint')),
        loading
          ? h('div', { className: 'dss-empty' }, t('settings.loading'))
          : error
            ? h('div', { className: 'dss-dialog-error' }, error)
            : h(
                React.Fragment,
                null,
                h(SelectionToolbar, { t, outline, selected, onAll: all, onNone: none }),
                h('div', { className: 'dss-dialog-scroll dss-picker-scroll' }, h(TurnPicker, { outline, selected, onToggle: toggle, t })),
                partial ? h('div', { className: 'dss-warn' }, t('segment.warning')) : null,
                picked.length === turns.length && turns.length > 0 ? h('div', { className: 'dss-warn' }, t('segment.whole')) : null,
                problem ? h('div', { className: 'dss-dialog-error' }, problem) : null,
                h(
                  'div',
                  { className: 'dss-dialog-actions' },
                  h('button', { type: 'button', className: 'dss-btn', onClick: onClose, disabled: busy }, t('dialog.cancel')),
                  h(
                    'button',
                    { type: 'button', className: 'dss-btn dss-critical', onClick: confirm, disabled: busy || !first },
                    busy ? h('span', { className: 'dss-spin' }) : null,
                    busy ? t('dialog.deleting') : t('segment.confirm'),
                  ),
                ),
              ),
      )
    }

    /**
     * The snapshot manager as a dialog, so the same panel is reachable straight
     * from a session's menu without opening Settings first.
     */
    function SnapshotDialog({ state, onClose }) {
      const t = state.t ?? (key => key)
      return h(
        DialogFrame,
        { title: t('settings.title'), wide: true, onClose },
        h('div', { className: 'dss-dialog-body' }, t('settings.description')),
        h(
          'div',
          { className: 'dss-dialog-scroll' },
          h(SnapshotSection, { t, embedded: true, initialSessionId: state.sessionId }),
        ),
      )
    }

    function SuiteOverlay() {
      const state = useStore(dialog)
      const message = useStore(toast)
      return h(
        React.Fragment,
        null,
        state
          ? state.mode === 'snapshots'
            ? h(SnapshotDialog, { key: state.key ?? 'snapshots', state, onClose: () => dialog.set(null) })
            : state.mode === 'share'
              ? h(ShareDialog, { key: state.key ?? 'share', state, onClose: () => dialog.set(null) })
              : state.mode === 'segment'
                ? h(SegmentDialog, { key: state.key ?? 'segment', state, onClose: () => dialog.set(null) })
                : state.mode === 'edit-resend'
                  ? h(EditResendDialog, { key: state.key ?? 'edit-resend', state, onClose: () => dialog.set(null) })
                : h(SelectSessionDialog, { key: state.key ?? 'dialog', state, onClose: () => dialog.set(null) })
          : null,
        message
          ? h(
              'div',
              { key: message.id, className: 'dss-toast' + (message.tone === 'error' ? ' dss-error' : ''), role: 'status' },
              message.message,
            )
          : null,
      )
    }

    // ---------------------------------------------------------- session menu

    function useSessionMenuRows(props, t) {
      const { sessionId, useMenuOpenState } = props
      const [, setMenuOpen] = useMenuOpenState()
      return { sessionId, setMenuOpen, t }
    }

    function ShareRow(props) {
      const { setMenuOpen, sessionId, t } = useSessionMenuRows(props, props.t)
      return h(MenuRow, {
        label: t('menu.share'),
        iconNode: h(Icons.download, null),
        separator: true,
        onSelect: () => {
          setMenuOpen(false)
          dialog.set({ key: `${sessionId}:share`, mode: 'share', sessionId, t })
        },
      })
    }

    function SnapshotsRow(props) {
      const { setMenuOpen, sessionId, t } = useSessionMenuRows(props, props.t)
      return h(MenuRow, {
        label: t('menu.snapshots'),
        iconNode: h(Icons.rewind, null),
        separator: true,
        onSelect: () => {
          setMenuOpen(false)
          dialog.set({ key: `${sessionId}:snapshots`, mode: 'snapshots', sessionId, t })
        },
      })
    }

    function SegmentRow(props) {
      const { setMenuOpen, sessionId, t } = useSessionMenuRows(props, props.t)
      return h(MenuRow, {
        label: t('menu.segment'),
        iconNode: h(Icons.cut, null),
        danger: true,
        separator: true,
        onSelect: () => {
          setMenuOpen(false)
          dialog.set({ key: `${sessionId}:segment`, mode: 'segment', sessionId, t })
        },
      })
    }

    function DeleteSessionRow(props) {
      const { setMenuOpen, sessionId, t } = useSessionMenuRows(props, props.t)
      return h(MenuRow, {
        label: t('menu.delete'),
        iconNode: h(Icons.trash, null),
        danger: true,
        separator: true,
        onSelect: () => {
          setMenuOpen(false)
          dialog.set({ key: `${sessionId}:delete`, mode: 'delete-session', sessionId, displayTitle: props.displayTitle, t })
        },
      })
    }

    // ------------------------------------------------------- message actions

    function RewindAction(props) {
      const { messageId, sessionId } = props
      const t = props.t
      const start = useCallback(
        mode => {
          pending.set({ key: `${sessionId}:${messageId}:${mode}`, mode, sessionId, messageId, t })
        },
        [messageId, sessionId, t],
      )
      return h(
        React.Fragment,
        null,
        h(
          'button',
          {
            type: 'button',
            className: 'dss-action',
            title: t('message.rewind'),
            'aria-label': t('message.rewind'),
            onClick: () => start('rewind'),
          },
          h(Icons.rewind, null),
        ),
        // Edit-and-resend sits in the same action row as rewind and delete. A
        // separate turnTail row put it on its own line; the user asked for it
        // alongside the other per-message icons.
        h(
          'button',
          {
            type: 'button',
            className: 'dss-action',
            title: t('message.edit'),
            'aria-label': t('message.edit'),
            onClick: () => {
              dialog.set({
                key: `${sessionId}:edit:${messageId}`,
                mode: 'edit-resend',
                sessionId,
                messageId,
                t,
              })
            },
          },
          h(Icons.edit, null),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'dss-action dss-danger',
            title: t('message.delete'),
            'aria-label': t('message.delete'),
            onClick: () => start('delete'),
          },
          h(Icons.trash, null),
        ),
      )
    }

    // ------------------------------------------------------- user message edit

    /**
     * Edit-and-resend, opened from the per-message action row.
     *
     * The pencil sits beside rewind and delete in `RewindAction`, which is
     * registered on `conversation.chat.assistant-actions` — the same row the
     * user already sees on each answer. We deliberately do NOT replace the
     * `user` key of `conversation.chat.node`: that slot is occupied by the
     * shipped bubble renderer (replaceRisk: shadows-shipped-ui), so a plugin bug
     * there would break every user message in the transcript.
     *
     * The dialog edits the text, then the Host trims the memories that turn
     * recorded and sends the edited text in the same session. Workspace files
     * are never touched: this is a conversation operation, and restoring files
     * would discard work done since.
     * this is a conversation operation, and rolling files back would discard work
     * done since.
     */
    function EditResendDialog({ state, onClose }) {
      const t = state.t ?? (key => key)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [text, setText] = useState(state.originalPrompt ?? '')

      useEffect(() => {
        if (!state.sessionId) return undefined
        let alive = true
        // Pure read: opening the dialog must not fork a session. The old
        // `mode: 'stage'` call did fork, so merely looking at the dialog created
        // a branch and could fail before the user had changed anything.
        call({
          action: 'resendTurn.preview',
          sessionId: state.sessionId,
          ...(state.messageId ? { messageId: state.messageId } : {}),
          ...(typeof state.turn === 'number' ? { turn: state.turn } : {}),
        })
          .then(data => {
            if (!alive) return
            if (typeof data?.prompt === 'string' && data.prompt) setText(data.prompt)
          })
          .catch(failure => alive && setError(failure?.message ?? t('message.resendFailed')))
        return () => {
          alive = false
        }
      }, [state.sessionId, state.messageId, state.turn])

      const confirm = async () => {
        setBusy(true)
        setError(null)
        try {
          const result = await call({
            action: 'resendTurn',
            sessionId: state.sessionId,
            messageId: state.messageId,
            mode: 'retry',
            text,
          })
          // Resend stays in the current session; there is no child to open.
          notify(t('message.resendDone'))
          onClose()
          bump()
        } catch (failure) {
          setError(failure?.message ?? t('message.resendFailed'))
        } finally {
          setBusy(false)
        }
      }

      return h(
        DialogFrame,
        { title: t('message.editTitle'), wide: true, onClose: busy ? () => {} : onClose },
        h('div', { className: 'dss-dialog-body' }, t('message.editBody')),
        h('textarea', {
          className: 'dss-input',
          style: { minHeight: 120, width: '100%', marginTop: 10 },
          value: text,
          onChange: event => setText(event.target.value),
        }),
        error ? h('div', { className: 'dss-dialog-error' }, error) : null,
        h(
          'div',
          { className: 'dss-dialog-actions' },
          h('button', { type: 'button', className: 'dss-btn dss-small', onClick: onClose, disabled: busy }, t('dialog.cancel')),
          h(
            'button',
            {
              type: 'button',
              className: 'dss-btn dss-small dss-primary',
              onClick: confirm,
              disabled: busy || !String(text).trim(),
            },
            busy ? h('span', { className: 'dss-spin' }) : null,
            busy ? t('message.resending') : t('message.editConfirm'),
          ),
        ),
      )
    }

    // -------------------------------------------------------- rewind banner

    function RewindBanner(props) {
      const state = useStore(pending)
      const session = props.session
      const sessionId = session?.sessionId ?? session?.id
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const t = props.t

      if (!state || !sessionId || state.sessionId !== sessionId) return null

      const close = () => {
        if (busy) return
        setError(null)
        pending.set(null)
      }

      const confirm = async () => {
        setBusy(true)
        setError(null)
        try {
          if (state.mode === 'resend') {
            // The action slot hands us a message id; the Host resolves which
            // turn it belongs to, forks before that turn's prompt, and re-admits
            // the prompt in the fork.
            const result = await call({
              action: 'resendTurn',
              sessionId,
              messageId: state.messageId,
            })
            if (result?.childId && props.openSession) props.openSession(result.childId)
            notify(result?.sent ? t('message.resendDone') : t('message.resendStaged'))
            pending.set(null)
            bump()
            return
          }
          const result = await call({
            action: state.mode === 'delete' ? 'deleteMessage' : 'rollback',
            sessionId,
            messageId: state.messageId,
          })
          if (result?.childId && props.openSession) {
            props.openSession(result.childId)
          }
          // Report what the user actually asked for. Keying this off
          // `deletedSession` was wrong: deleteMessage always returns false
          // (it only trims the conversation), so every delete announced
          // "rewound to this step" and read as the wrong operation.
          const done = state.mode === 'delete'
            ? t('message.deleteDone')
            : t('message.rewindDone')
          notify(done)
          pending.set(null)
          bump()
        } catch (failure) {
          setError(failure?.message ?? t('message.rewindFailed'))
        } finally {
          setBusy(false)
        }
      }

      const isDelete = state.mode === 'delete'
      const isResend = state.mode === 'resend'
      const titleKey = isDelete ? 'message.deleteTitle' : isResend ? 'message.resendTitle' : 'message.rewindTitle'
      const bodyKey = isDelete ? 'message.deleteBody' : isResend ? 'message.resendBody' : 'message.rewindBody'
      return h(
        'div',
        { className: 'dss-banner', role: 'group' },
        h(
          'div',
          { className: 'dss-banner-main' },
          h('span', { className: 'dss-banner-icon' }, h(Icons.info, null)),
          h(
            'div',
            { className: 'dss-banner-text' },
            h('span', { className: 'dss-banner-title' }, t(titleKey)),
            h('span', { className: 'dss-banner-body' }, t(bodyKey)),
            error ? h('span', { style: { color: 'var(--dsw-alias-state-error-primary)' } }, error) : null,
          ),
        ),
        h(
          'div',
          { className: 'dss-banner-actions' },
          h('button', { type: 'button', className: 'dss-btn dss-small', onClick: close, disabled: busy }, t('dialog.cancel')),
          h(
            'button',
            { type: 'button', className: 'dss-btn dss-small dss-primary', onClick: confirm, disabled: busy },
            busy ? h('span', { className: 'dss-spin' }) : null,
            busy
              ? t(isResend ? 'message.resending' : 'message.rewinding')
              : t(isDelete ? 'message.deleteConfirm' : isResend ? 'message.resendConfirm' : 'message.rewindConfirm'),
          ),
        ),
      )
    }

    // ------------------------------------------------------- settings section

    function SnapshotSection(props) {
      const t = props.t
      const rev = useStore(revision)
      const [sessions, setSessions] = useState(null)
      const [selected, setSelected] = useState(props.initialSessionId ?? null)
      const [detail, setDetail] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(null)
      const [memoryDraft, setMemoryDraft] = useState('')

      useEffect(() => {
        let alive = true
        call({ action: 'list' })
          .then(rows => {
            if (!alive) return
            setSessions(rows)
            setSelected(current => {
              if (current && rows.some(row => row.sessionId === current)) return current
              if (props.initialSessionId && rows.some(row => row.sessionId === props.initialSessionId)) {
                return props.initialSessionId
              }
              // No session was named (the settings page opens this section with
              // no conversation context), so pick the one the user is most
              // likely looking for: the most recently active session that has
              // snapshots, not merely the first row that has any. The previous
              // fallback depended on list order and, once a session was missing
              // from the list entirely, showed an unrelated conversation.
              const ranked = [...rows].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
              const withSnapshots = ranked.find(row => row.checkpoints > 0)
              return (withSnapshots ?? ranked[0])?.sessionId ?? null
            })
          })
          .catch(failure => alive && setError(failure.message))
        return () => {
          alive = false
        }
      }, [rev, props.initialSessionId])

      useEffect(() => {
        if (!selected) {
          setDetail(null)
          return undefined
        }
        let alive = true
        setDetail(null)
        call({ action: 'detail', sessionId: selected })
          .then(value => alive && setDetail(value))
          .catch(failure => alive && setError(failure.message))
        return () => {
          alive = false
        }
      }, [selected, rev])

      const run = useCallback(
        async (key, operation, doneMessage) => {
          setBusy(key)
          setError(null)
          try {
            await operation()
            if (doneMessage) notify(doneMessage)
            bump()
          } catch (failure) {
            setError(failure.message)
            notify(failure.message, 'error')
          } finally {
            setBusy(null)
          }
        },
        [],
      )

      const sectionClass = props.embedded ? 'dss-section dss-embedded' : 'dss-section'
      const head = props.embedded ? null : h(
        'div',
        { className: 'dss-section-head' },
        h('h2', null, t('settings.title')),
        h('div', { className: 'dss-section-desc' }, t('settings.description')),
      )

      if (error && !detail) {
        return h('div', { className: sectionClass }, head, h('div', { className: 'dss-dialog-error' }, error))
      }
      if (!sessions) return h('div', { className: sectionClass }, head, h('div', { className: 'dss-empty' }, t('settings.loading')))
      if (sessions.length === 0) return h('div', { className: sectionClass }, head, h('div', { className: 'dss-empty' }, t('settings.noSessions')))

      const picker = h(
        'div',
        { className: 'dss-toolbar' },
        h('span', { className: 'dss-group-title' }, t('settings.session')),
        h(
          'select',
          {
            className: 'dss-select',
            value: selected ?? '',
            onChange: event => setSelected(event.target.value),
          },
          ...sessions.map(row =>
            h('option', { key: row.sessionId, value: row.sessionId }, `${row.title || row.sessionId} · ${row.checkpoints} · ${row.checkpointLabel}`),
          ),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'dss-btn dss-small',
            disabled: !selected || busy === 'capture',
            onClick: () => run('capture', () => call({ action: 'capture', sessionId: selected }), t('toast.captured')),
          },
          busy === 'capture' ? h('span', { className: 'dss-spin' }) : h(Icons.plus, { size: 14 }),
          t(busy === 'capture' ? 'settings.capturing' : 'settings.capture'),
        ),
      )

      const stats = detail?.stats
      const statsLine = stats
        ? h(
            'div',
            { className: 'dss-row-meta' },
            h('span', null, t('settings.usage', { size: stats.label })),
            h('span', null, t('settings.budget', { keep: stats.budget })),
            detail.cwd ? h('span', { title: detail.cwd }, detail.cwd) : null,
          )
        : null

      const checkpoints = detail?.checkpoints ?? []
      const checkpointList =
        checkpoints.length === 0
          ? h('div', { className: 'dss-empty' }, t('settings.empty'))
          : h(
              'div',
              { className: 'dss-card' },
              ...checkpoints.map(cp =>
                h(
                  'div',
                  { className: 'dss-row', key: cp.id },
                  h(
                    'div',
                    { className: 'dss-row-main' },
                    h(
                      'div',
                      { className: 'dss-row-title' },
                      h('span', null, cp.label || cp.id),
                      cp.locked ? h('span', { className: 'dss-badge dss-locked' }, t('settings.locked')) : null,
                      cp.temporary ? h('span', { className: 'dss-badge dss-temp' }, t('settings.temporary')) : null,
                    ),
                    h(
                      'div',
                      { className: 'dss-row-meta' },
                      typeof cp.turn === 'number' ? h('span', null, t('settings.turn', { turn: cp.turn })) : null,
                      h('span', null, t('settings.files', { count: cp.files })),
                      h('span', null, cp.size),
                      h('span', null, new Date(cp.createdAt).toLocaleString()),
                    ),
                  ),
                  h(
                    'div',
                    { className: 'dss-row-actions' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dss-btn dss-small dss-ghost',
                        title: cp.locked ? t('settings.unlock') : t('settings.lock'),
                        disabled: busy === `lock:${cp.id}`,
                        onClick: () =>
                          run(`lock:${cp.id}`, () => call({ action: 'setLocked', sessionId: selected, checkpointId: cp.id, locked: !cp.locked }), cp.locked ? t('toast.unlocked') : t('toast.locked')),
                      },
                      h(cp.locked ? Icons.unlock : Icons.lock, { size: 14 }),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dss-btn dss-small dss-ghost',
                        disabled: busy === `restore:${cp.id}`,
                        onClick: () => {
                          dialog.set({
                            key: `restore:${cp.id}`,
                            mode: 'restore',
                            t,
                            title: t('settings.restore'),
                            body: t('settings.restoreConfirm'),
                            confirmLabel: t('settings.restore'),
                            doneMessage: t('settings.restoreDone'),
                            onConfirm: () => call({ action: 'restore', sessionId: selected, checkpointId: cp.id }),
                          })
                        },
                      },
                      h(Icons.restore, { size: 14 }),
                      t('settings.restore'),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dss-btn dss-small dss-ghost',
                        title: t('settings.remove'),
                        disabled: cp.locked || busy === `remove:${cp.id}`,
                        onClick: () => run(`remove:${cp.id}`, () => call({ action: 'removeCheckpoint', sessionId: selected, checkpointId: cp.id }), t('toast.removed')),
                      },
                      h(Icons.trash, { size: 14 }),
                    ),
                  ),
                ),
              ),
            )

      const undos = detail?.undos ?? []
      const undoList = undos.length === 0
        ? null
        : h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
            h('div', { className: 'dss-group-title' }, t('settings.undoBundles')),
            h(
              'div',
              { className: 'dss-card' },
              ...undos.map(undo =>
                h(
                  'div',
                  { className: 'dss-row', key: undo.id },
                  h(
                    'div',
                    { className: 'dss-row-main' },
                    h('div', { className: 'dss-row-title' }, t('settings.undoBundle', { turn: undo.turn ?? '?' })),
                    h('div', { className: 'dss-row-meta' }, h('span', null, t('settings.undoHint'))),
                  ),
                  h(
                    'div',
                    { className: 'dss-row-actions' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dss-btn dss-small',
                        disabled: busy === `undo:${undo.id}`,
                        onClick: () => run(`undo:${undo.id}`, () => call({ action: 'undo', undoId: undo.id }), t('message.undoDone')),
                      },
                      t('settings.undoRestore'),
                    ),
                  ),
                ),
              ),
            ),
          )

      const memory = detail?.memory ?? []
      const memoryBlock = h(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        h('div', { className: 'dss-group-title' }, t('settings.memory')),
        h(
          'div',
          { className: 'dss-card' },
          memory.length === 0
            ? h('div', { className: 'dss-empty' }, t('settings.memoryEmpty'))
            : memory.map(entry =>
                h(
                  'div',
                  { className: 'dss-row', key: entry.id },
                  h('div', { className: 'dss-row-main' }, h('div', { className: 'dss-memory-text' }, entry.text), h('div', { className: 'dss-row-meta' }, h('span', null, new Date(entry.createdAt).toLocaleString()))),
                  h(
                    'div',
                    { className: 'dss-row-actions' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dss-btn dss-small dss-ghost',
                        title: t('settings.memoryRemove'),
                        onClick: () => run(`mem:${entry.id}`, () => call({ action: 'memory.remove', sessionId: selected, id: entry.id }), t('toast.memoryRemoved')),
                      },
                      h(Icons.trash, { size: 14 }),
                    ),
                  ),
                ),
              ),
        ),
        h(
          'div',
          { className: 'dss-toolbar' },
          h('input', {
            className: 'dss-input',
            value: memoryDraft,
            placeholder: t('settings.memoryPlaceholder'),
            onChange: event => setMemoryDraft(event.target.value),
          }),
          h(
            'button',
            {
              type: 'button',
              className: 'dss-btn dss-small',
              disabled: !memoryDraft.trim() || !selected,
              onClick: () =>
                run('memory:add', async () => {
                  await call({ action: 'memory.add', sessionId: selected, text: memoryDraft })
                  setMemoryDraft('')
                }, t('toast.memoryAdded')),
            },
            t('settings.memorySave'),
          ),
        ),
      )

      return h(
        'div',
        { className: sectionClass },
        head,
        picker,
        statsLine,
        checkpointList,
        undoList,
        memoryBlock,
      )
    }

    // ------------------------------------------------------- long-term memory

    function useWorkspacePath() {
      return runtime.resolveCwd?.() ?? runtime.cwd
    }

    /** Last path segment, for a compact workspace label. */
    function basename(value) {
      const text = String(value ?? '')
      const cut = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'))
      return cut >= 0 ? text.slice(cut + 1) || text : text
    }

    function MemorySection(props) {
      const t = props.t
      const rev = useStore(revision)
      const [tab, setTab] = useState('all')
      const [items, setItems] = useState(null)
      const [pending, setPending] = useState([])
      const [settings, setSettings] = useState(null)
      const [error, setError] = useState(null)
      const [draft, setDraft] = useState('')
      const [draftScope, setDraftScope] = useState('workspace')
      const [busy, setBusy] = useState(null)
      const [known, setKnown] = useState([])
      // Maintenance bookkeeping, so "did the timer ever run?" is a fact on
      // screen rather than something the user has to take on trust.
      const [maint, setMaint] = useState(null)
      // An explicit pick wins over the guessed path, so the tab never silently
      // shows another workspace's memories once the user chooses one.
      const [picked, setPicked] = useState(undefined)
      // "Which memories would this question pull in?" — answered on demand so
      // the answer is inspectable rather than something the user has to infer
      // from what the model happened to say.
      const [explain, setExplain] = useState(null)
      const [explainQuery, setExplainQuery] = useState('')
      const [explainBusy, setExplainBusy] = useState(false)
      // Filters: a library that grows past a screenful is not worth reading, so
      // the list has to be narrowable by tag and by recency.
      const [tagFilter, setTagFilter] = useState('')
      const [sinceFilter, setSinceFilter] = useState('')

      const detected = useWorkspacePath()
      const cwd = picked !== undefined ? picked : detected

      useEffect(() => {
        let alive = true
        call({ action: 'longterm.workspaces' })
          .then(list => alive && setKnown(Array.isArray(list) ? list : []))
          .catch(() => alive && setKnown([]))
        return () => {
          alive = false
        }
      }, [rev])

      useEffect(() => {
        let alive = true
        Promise.all([
          // Filters go to the engine, not applied client-side, so the export and
          // this page always agree on what "my error lessons from this week" means.
          call({
            action: 'longterm.list',
            cwd,
            ...(tagFilter ? { tag: tagFilter } : {}),
            ...(sinceFilter ? { sinceDays: Number(sinceFilter) } : {}),
          }),
          call({ action: 'longterm.pending', cwd }),
          call({ action: 'longterm.settings' }),
          call({ action: 'longterm.status' }).catch(() => null),
        ])
          .then(([list, waiting, config, status]) => {
            if (!alive) return
            setItems(list)
            setPending(waiting)
            setSettings(config)
            setMaint(status)
          })
          .catch(failure => alive && setError(failure.message))
        return () => {
          alive = false
        }
      }, [rev, cwd, tagFilter, sinceFilter])

      const run = useCallback(async (key, operation, message) => {
        setBusy(key)
        setError(null)
        try {
          await operation()
          if (message) notify(message)
          bump()
        } catch (failure) {
          setError(failure.message)
          notify(failure.message, 'error')
        } finally {
          setBusy(null)
        }
      }, [])

      const runExplain = useCallback(async () => {
        setExplainBusy(true)
        setError(null)
        try {
          setExplain(await call({ action: 'longterm.explain', cwd, query: explainQuery }))
        } catch (failure) {
          setError(failure.message)
        } finally {
          setExplainBusy(false)
        }
      }, [cwd, explainQuery])

      // Known tags, so the filter is a pick rather than a guess at the exact
      // spelling — the engine matches tags exactly, so a typo silently empties
      // the list and looks like a bug.
      //
      // This hook MUST stay above the early returns below. Those returns happen
      // while `items` is still null, and a hook declared after them is called a
      // different number of times between renders — React then tears the whole
      // section down and the settings page shows nothing at all.
      const knownTags = useMemo(() => {
        const out = new Set()
        for (const item of items ?? []) {
          for (const tag of item.tags ?? []) {
            if (typeof tag === 'string' && tag.trim()) out.add(tag.trim())
          }
        }
        return [...out].sort((a, b) => a.localeCompare(b))
      }, [items])

      const head = h(
        'div',
        { className: 'dss-section-head' },
        h('h2', null, t('memory.title')),
        h('div', { className: 'dss-section-desc' }, t('memory.description')),
      )

      if (error && !items) return h('div', { className: 'dss-section' }, head, h('div', { className: 'dss-dialog-error' }, error))
      if (!items) return h('div', { className: 'dss-section' }, head, h('div', { className: 'dss-empty' }, t('settings.loading')))

      const visible = items.filter(item => {
        if (tab === 'workspace') return item.scope === 'workspace'
        if (tab === 'global') return item.scope === 'global'
        if (tab === 'archived') return item.archived === true
        return true
      })

      const tabs = h(
        'div',
        { className: 'dss-tabs' },
        ...['all', 'workspace', 'global', 'archived'].map(key =>
          h(
            'button',
            {
              key,
              type: 'button',
              className: 'dss-tab' + (tab === key ? ' dss-tab-on' : ''),
              onClick: () => setTab(key),
            },
            t(`memory.tab.${key}`),
          ),
        ),
      )

      const filterBlock = h(
        'div',
        { className: 'dss-toolbar' },
        h(
          'select',
          {
            className: 'dss-select',
            value: tagFilter,
            onChange: event => setTagFilter(event.target.value),
          },
          h('option', { value: '' }, t('memory.filterAllTags')),
          ...knownTags.map(tag => h('option', { key: tag, value: tag }, tag)),
        ),
        h(
          'select',
          {
            className: 'dss-select',
            value: sinceFilter,
            onChange: event => setSinceFilter(event.target.value),
          },
          h('option', { value: '' }, t('memory.filterAnyTime')),
          h('option', { value: '1' }, t('memory.filterToday')),
          h('option', { value: '7' }, t('memory.filterWeek')),
          h('option', { value: '30' }, t('memory.filterMonth')),
        ),
        tagFilter || sinceFilter
          ? h(
              'button',
              {
                type: 'button',
                className: 'dss-action',
                onClick: () => {
                  setTagFilter('')
                  setSinceFilter('')
                },
              },
              t('memory.filterClear'),
            )
          : null,
        h('span', { className: 'dss-row-meta' }, t('memory.filterCount', { n: (items ?? []).length })),
      )

      const pendingBlock =
        pending.length === 0
          ? null
          : h(
              'div',
              { className: 'dss-mem-pending' },
              h('div', { className: 'dss-group-title' }, t('memory.pendingTitle')),
              h('div', { className: 'dss-mem-pending-hint' }, t('memory.pendingHint')),
              ...pending.map(item =>
                h(
                  'div',
                  { className: 'dss-row', key: item.id },
                  h(
                    'div',
                    { className: 'dss-row-main' },
                    h('div', { className: 'dss-memory-text' }, item.text),
                    h('div', { className: 'dss-row-meta' }, h('span', { className: 'dss-badge' }, item.scope === 'global' ? t('memory.global') : t('memory.workspace'))),
                  ),
                  h(
                    'div',
                    { className: 'dss-row-actions' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dss-btn dss-small dss-primary',
                        disabled: busy === `keep:${item.id}`,
                        onClick: () => run(`keep:${item.id}`, () => call({ action: 'longterm.settle', id: item.id, accept: true }), t('memory.accepted')),
                      },
                      t('memory.accept'),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dss-btn dss-small dss-ghost',
                        disabled: busy === `drop:${item.id}`,
                        onClick: () => run(`drop:${item.id}`, () => call({ action: 'longterm.settle', id: item.id, accept: false }), t('memory.rejected')),
                      },
                      t('memory.reject'),
                    ),
                  ),
                ),
              ),
            )

      const listBlock =
        visible.length === 0
          ? h('div', { className: 'dss-empty' }, t('memory.empty'))
          : h(
              'div',
              { className: 'dss-card' },
              ...visible.map(entry =>
                h(
                  'div',
                  { className: 'dss-row', key: entry.id },
                  h(
                    'div',
                    { className: 'dss-row-main' },
                    h('div', { className: 'dss-memory-text' }, entry.text),
                    h(
                      'div',
                      { className: 'dss-row-meta' },
                      h('span', { className: 'dss-badge' + (entry.scope === 'global' ? ' dss-locked' : '') }, entry.scope === 'global' ? t('memory.global') : t('memory.workspace')),
                      entry.kind === 'rule' ? h('span', { className: 'dss-badge dss-temp' }, t('memory.rule')) : null,
                      entry.summary ? h('span', { className: 'dss-badge' }, t('memory.summary')) : null,
                      entry.frozen ? h('span', { className: 'dss-badge dss-locked' }, t('memory.frozen')) : null,
                      entry.archived ? h('span', { className: 'dss-badge dss-temp' }, t('memory.archived')) : null,
                      typeof entry.score === 'number' && !entry.archived ? h('span', null, t('memory.score', { score: entry.score.toFixed(2) })) : null,
                      h('span', null, t('memory.access', { count: entry.accessCount ?? 0 })),
                    ),
                  ),
                  h(
                    'div',
                    { className: 'dss-row-actions' },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dss-btn dss-small dss-ghost',
                        title: entry.frozen ? t('memory.unfreeze') : t('memory.freeze'),
                        onClick: () =>
                          run(`freeze:${entry.id}`, () =>
                            call({ action: 'longterm.update', id: entry.id, cwd, scope: entry.scope, frozen: !entry.frozen }),
                          ),
                      },
                      h(entry.frozen ? Icons.unlock : Icons.lock, { size: 14 }),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dss-btn dss-small dss-ghost',
                        title: t('memory.remove'),
                        onClick: () => run(`rm:${entry.id}`, () => call({ action: 'longterm.remove', id: entry.id, cwd, scope: entry.scope }), t('memory.removed')),
                      },
                      h(Icons.trash, { size: 14 }),
                    ),
                  ),
                ),
              ),
            )

      const addBlock = h(
        'div',
        { className: 'dss-toolbar' },
        h(
          'select',
          { className: 'dss-select', value: draftScope, onChange: event => setDraftScope(event.target.value) },
          h('option', { value: 'workspace' }, t('memory.workspace')),
          h('option', { value: 'global' }, t('memory.global')),
        ),
        h('input', {
          className: 'dss-input',
          value: draft,
          placeholder: t('memory.placeholder'),
          onChange: event => setDraft(event.target.value),
        }),
        h(
          'button',
          {
            type: 'button',
            className: 'dss-btn dss-small',
            disabled: !draft.trim() || busy === 'add',
            onClick: () =>
              run(
                'add',
                async () => {
                  await call({ action: 'longterm.remember', text: draft, scope: draftScope, cwd })
                  setDraft('')
                },
                t('memory.added'),
              ),
          },
          t('memory.save'),
        ),
      )

      const footer = h(
        'div',
        { className: 'dss-toolbar' },
        h(
          'button',
          {
            type: 'button',
            className: 'dss-btn dss-small',
            disabled: busy === 'maintain',
            onClick: () => run('maintain', () => call({ action: 'longterm.maintain', cwd }), t('memory.maintained')),
          },
          t('memory.maintain'),
        ),
        h(
          'label',
          { className: 'dss-curate dss-curate-inline' },
          h('input', {
            type: 'checkbox',
            checked: settings?.implicit !== false,
            onChange: event =>
              run('implicit', () =>
                call({ action: 'longterm.settings', patch: { implicit: event.target.checked } }),
              ),
          }),
          h('span', { className: 'dss-curate-title' }, t('memory.implicit')),
        ),
        h(
          'button',
          {
            type: 'button',
            className: 'dss-btn dss-small dss-ghost',
            onClick: () => run('cold', () => call({ action: 'longterm.remove', cwd, scope: 'workspace' }), t('memory.coldCleared')),
          },
          t('memory.clearCold'),
        ),
      )

      const workspacePicker =
        known.length === 0
          ? null
          : h(
              'div',
              { className: 'dss-ws-picker' },
              h('label', { className: 'dss-ws-label' }, t('memory.workspacePicker')),
              h(
                'select',
                {
                  className: 'dss-select',
                  value: cwd ?? '',
                  onChange: event => setPicked(event.target.value || undefined),
                },
                ...(cwd ? [] : [h('option', { key: '__none', value: '' }, t('memory.workspaceNone'))]),
                ...known.map(item =>
                  h('option', { key: item.key, value: item.cwd }, `${basename(item.cwd)} (${item.entries})`),
                ),
              ),
            )

      // Maintenance is the one part of this feature that runs without the user
      // present, so its history is shown rather than assumed. "never run" is a
      // distinct, honest state — it is what an idle timer looks like.
      const lastRun = maint && typeof maint.lastMaintainedAt === 'number' ? maint.lastMaintainedAt : 0
      const lastReport = maint?.lastReport
      const maintLine = h(
        'div',
        { className: 'dss-maint' },
        h(
          'span',
          { className: 'dss-maint-when' },
          lastRun > 0
            ? `${t('memory.maintainedAt')} ${new Date(lastRun).toLocaleString()}`
            : t('memory.maintainedNever'),
        ),
        lastReport
          ? h(
              'span',
              { className: 'dss-maint-report' },
              `${t('memory.maintainedScored')} ${lastReport.scored} · ` +
                `${t('memory.maintainedCompressed')} ${lastReport.compressed} · ` +
                `${t('memory.maintainedRules')} ${lastReport.rules}`,
            )
          : null,
      )

      const reasonLabel = reason =>
        reason === 'no-match' ? t('memory.whyNoMatch') : t('memory.whyCapacity')

      const explainBlock = h(
        'div',
        { className: 'dss-card' },
        h('div', { className: 'dss-row-title' }, t('memory.explainTitle')),
        h('div', { className: 'dss-hint' }, t('memory.explainHint')),
        h(
          'div',
          { className: 'dss-row-actions' },
          h('input', {
            className: 'dss-input',
            value: explainQuery,
            placeholder: t('memory.explainPlaceholder'),
            onChange: event => setExplainQuery(event.target.value),
            onKeyDown: event => {
              if (event.key === 'Enter') runExplain()
            },
          }),
          h(
            'button',
            { className: 'dss-action', disabled: explainBusy || !cwd, onClick: runExplain },
            explainBusy ? t('settings.loading') : t('memory.explainRun'),
          ),
        ),
        explain
          ? h(
              'div',
              null,
              h(
                'div',
                { className: 'dss-row-meta' },
                t('memory.explainInjected', { n: explain.items.length, limit: explain.effectiveLimit }),
              ),
              explain.items.length === 0
                ? h('div', { className: 'dss-hint' }, t('memory.explainNone'))
                : null,
              ...explain.items.map(item =>
                h('div', { className: 'dss-memory-text', key: `in:${item.id}` }, item.text),
              ),
              explain.omitted.length > 0
                ? h(
                    'div',
                    { className: 'dss-row-meta', style: { marginTop: 10 } },
                    t('memory.explainOmitted', { n: explain.omitted.length }),
                  )
                : null,
              ...explain.omitted
                .slice(0, 12)
                .map(item =>
                  h(
                    'div',
                    { className: 'dss-row-meta', key: `out:${item.id}` },
                    h('span', { className: 'dss-badge dss-temp' }, reasonLabel(item.reason)),
                    h('span', null, ` ${String(item.text).slice(0, 60)}`),
                  ),
                ),
            )
          : null,
      )

      return h(
        'div',
        { className: 'dss-section' },
        head,
        pendingBlock,
        explainBlock,
        tabs,
        filterBlock,
        workspacePicker,
        listBlock,
        addBlock,
        footer,
        maintLine,
      )
    }

    // ------------------------------------------------------------------ apply

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, DICTS))
        ctx.effect(installStyles)

        /** Open another session in the main panel (used after a rewind forks one). */
        const openSession = sessionId => {
          // Remember which session the panel is showing so the memory page can
          // resolve that session's workspace directory.
          runtime.sessionId = sessionId
          runtime.cwd = undefined
          const uiWorkspace = ctx.get('uiWorkspace')
          if (uiWorkspace?.openSession) {
            uiWorkspace.openSession(sessionId)
            return
          }
          const layout = ctx.get('layout')
          layout?.selectPanel?.('conversation')
        }
        runtime.openSession = openSession
        // The memory page needs the workspace directory that the settings page is
        // actually looking at. Resolve it from the session this page was opened
        // for; when there is none, the page offers the Host's recorded workspace
        // list instead of guessing, so it never silently reads the global store.
        runtime.cwd = undefined
        const resolveRuntimeCwd = () => {
          if (runtime.cwd) return runtime.cwd
          if (runtime.sessionId) {
            try {
              const binding = ctx.get('sessions')?.binding?.(runtime.sessionId)
              if (binding?.cwd) runtime.cwd = binding.cwd
            } catch {
              // leave undefined; the picker offers the known workspaces instead
            }
          }
          return runtime.cwd
        }
        runtime.resolveCwd = resolveRuntimeCwd
        runtime.archiveSession = async sessionId => {
          const uiWorkspace = ctx.get('uiWorkspace')
          if (uiWorkspace?.archiveSession) return uiWorkspace.archiveSession(sessionId, { stopActivity: true })
          const workspaces = ctx.get('workspaces')
          if (workspaces?.archiveSession) return workspaces.archiveSession(sessionId, { stopActivity: true })
          return undefined
        }

        const withT = (component, extra) => props => h(component, { ...props, t: props.t ?? t, ...extra })

        const menuSlots = [
          ['sidebar.workspaces.session.menu.item', 'session-suite-share', 460, ShareRow],
          ['sidebar.workspaces.session.menu.item', 'session-suite-snapshots', 470, SnapshotsRow],
          ['sidebar.workspaces.session.menu.item', 'session-suite-segment', 880, SegmentRow],
          ['sidebar.workspaces.session.menu.item', 'session-suite-delete', 900, DeleteSessionRow],
        ]
        for (const [name, id, order, component] of menuSlots) {
          ctx.slots.inject(name, () =>
            ctx.slots.register({ name, id, order, locale: NS }, withT(component)),
          )
        }

        ctx.slots.inject('conversation.chat.assistant-actions', () =>
          ctx.slots.register(
            { name: 'conversation.chat.assistant-actions', id: 'session-suite-rewind', order: 20, locale: NS },
            withT(RewindAction),
          ),
        )

        ctx.slots.inject('conversation.input.dock', () =>
          ctx.slots.register(
            { name: 'conversation.input.dock', id: 'session-suite-rewind-banner', order: 30, locale: NS },
            withT(RewindBanner, { openSession }),
          ),
        )

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'session-suite-overlay', order: 40 }, SuiteOverlay),
        )

        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'session-snapshots',
              order: 500,
              locale: NS,
              label: () => t('settings.title'),
            },
            withT(SnapshotSection),
          ),
        )

        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'long-term-memory',
              order: 520,
              locale: NS,
              label: () => t('memory.title'),
            },
            withT(MemorySection),
          ),
        )
      },
    }
  },
})
