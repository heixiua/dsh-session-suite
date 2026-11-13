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

/**
 * The module id must be the package name.
 *
 * `dsh-client-modules` builds each manifest entry's id from the package it
 * resolved, and the browser-side loader de-duplicates registrations by that same
 * id. When this file registered itself as `dsh-session-suite` while the package
 * resolved as `@heixui/dsh-session-suite`, those were two different ids for one
 * bundle: the combo script registered the factory once, the graph row imported
 * it again, and the second registration threw
 *
 *   client-modules: duplicate factory registration for "dsh-session-suite"
 *
 * which aborted the whole web boot (the app refused to start). The shipped
 * plugins that work all register under their package name — dsh-connect-trae
 * uses "dsh-connect-trae", whale-pet uses "<package>#<submodule>".
 */
window.__ModuleLoader__.load({
  id: '@heixui/dsh-session-suite',
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
        'share.recentLabel': 'Newest',
        'share.recentApply': 'Select',
        'share.searchPlaceholder': 'Search a turn number or text…',
        'share.searchHit': '{n} of {total} turns match',
        'share.pageFirst': 'First',
        'share.pagePrev': 'Prev',
        'share.pageNext': 'Next',
        'share.pageLast': 'Last',
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
        'message.resendDone': 'Resent as a new turn',
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
        'settings.title': 'Session snapshots',        'settings.description': 'Workspace checkpoints captured for a session, with disk usage, locking, and restore controls.',
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
        'settings.budgetInherited': '+ {n} inherited',
        'settings.inherited': 'Inherited',
        'settings.orphansSweep': 'Clean up orphan snapshots',
        'settings.orphansConfirm': 'Click again to delete',
        'settings.orphansNone': 'No orphan snapshot directories',
        'settings.orphansFound': '{n} orphan session(s), {size} reclaimable — click again to delete',
        'settings.orphansRemoved': 'Removed {n} orphan session(s), freed {size}',
        'settings.ghostsSweep': 'Clean up session residue',
        'settings.ghostsConfirm': 'Click again to clean',
        'settings.ghostsNone': 'No stale session cache or registry entries',
        'settings.ghostsFound': '{caches} stale caches, {ids} dead registry ids — click again to clean',
        'settings.ghostsRemoved': 'Removed {caches} stale caches and {ids} dead registry ids',
        'settings.budgetNote':
          'Only this session\'s own automatic snapshots count against the budget. Snapshots inherited from a parent session (created by a rewind or message delete) are kept separately and are why the list can be longer than {keep}.',
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
        'memory.episode': 'Episode',
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
        'memory.statsKind': 'What the library holds',
        'memory.statsHealth': 'Score distribution',
        'memory.statsTags': 'Topics',
        'memory.kind.fact': 'Facts',
        'memory.kind.rule': 'Rules',
        'memory.kind.summary': 'Summaries',
        'memory.kind.episode': 'Episodes',
        'memory.band.high': 'Strong ≥0.60',
        'memory.band.mid': 'Fading 0.45–0.60',
        'memory.band.low': 'Below line <0.45',        'memory.pendingHint': 'Extracted from the last turns. Nothing is stored until you accept it.',
        'memory.extractionIdle': 'Nothing is waiting. Last check: {reason}',
        'memory.extractionNotYet':
          'Nothing is waiting yet. Extraction runs at the end of each turn, and this Host has not completed one since it started — have a short exchange and come back.',
        'memory.extractionUnknown': 'no attempt recorded since this Host started',
        'panel.title': 'Session suite',
        'panel.description': 'Snapshots, long-term memory, and archived sessions. Each row opens its own page.',
        'panel.snapshots': 'Session snapshots',
        'panel.snapshotsHint': 'Workspace checkpoints taken when each turn finishes',
        'panel.memory': 'Long-term memory',
        'panel.memoryHint': 'Facts, rules, preferences, and past events kept across sessions',
        'panel.archived': 'Archived sessions',
        'panel.archivedHint': 'Sessions hidden from the sidebar; restore them here',
        'panel.sessionsCount': '{n} session(s) with snapshots',
        'panel.statSessions': 'Sessions',
        'panel.statSnapshots': 'Snapshots',
        'panel.statMemories': 'Memories',
        'panel.statArchived': 'Archived',
        'panel.statSessionsHint': 'Every workspace, subagents excluded',
        'panel.statSnapshotsHint': 'Automatic checkpoints across all sessions',
        'panel.statMemoriesHint': 'Global plus every workspace, archived included',
        'panel.statArchivedHint': 'Hidden from the sidebar, restorable',
        'panel.breakdownTitle': 'Where the memories live',
        'panel.breakdownGlobal': 'Global (shared by every workspace)',
        'panel.breakdownHint': 'Each workspace keeps its own store; the total above is the sum of these plus the global one.',
        'panel.repoLink': 'GitHub source — a small encouragement',
        'panel.noSettingsSeam': 'This Host build does not expose the settings navigation seam, so this row cannot open its page.',
        'archived.title': 'Archived sessions',
        'archived.description': 'Archived sessions are hidden from the sidebar. Restoring one puts it back; nothing is deleted.',
        'archived.empty': 'No archived sessions.',
        'archived.restore': 'Restore',
        'archived.restored': 'Restored',
        'archived.restoreFailed': 'Could not restore this session',
        'archived.ghost': 'stale mark',
        'archived.logged': 'has log',
        'archived.snapshots': '{n} snapshot(s)',
        'archived.cleanupTitle': 'Bulk cleanup',
        'archived.cleanupHint': 'Bot plugins can leave thousands of archived marks with no session log and no snapshots. Preview first, then remove either the whole sessions or only their snapshots.',
        'archived.preview': 'Preview',
        'archived.previewing': 'Scanning…',
        'archived.previewSessions': '{n} session(s) · {size} to free',
        'archived.previewSnapshots': '{n} snapshot set(s) · {size} to free',
        'archived.ghosts': '{n} stale registry marks (no log)',
        'archived.targetSessions': 'Delete sessions',
        'archived.targetSnapshots': 'Delete snapshots only',
        'archived.cleanSessions': 'Delete {n} archived session(s)',
        'archived.cleanSnapshots': 'Delete snapshots of {n} session(s)',
        'archived.cleaned': 'Removed {n}, failed {m}, freed {size}',
        'archived.cleanFailed': 'Cleanup failed',
        'archived.confirmSessions': 'Permanently delete {n} archived session(s)? This cannot be undone.',
        'archived.confirmSnapshots': 'Permanently delete the snapshots of {n} archived session(s)? The conversations stay.',
        'archived.limitHint': 'Batch size (0 = all)',
        'settings.archived': 'Archived',
        'settings.checkpointCount': '{n} snapshot(s)',
        'settings.working': 'Working…',
        'memory.extractionTried': 'tried {n} memory model(s)',
        'memory.extractionQueued': '{n} queued',
        'memory.extractionRejected': '{n} rejected as unusable',
        'memory.extractionEvents': '{n} session event(s) received',
        'memory.extractionTurns': '{n} turn(s) ended',
        'memory.extractionRegistered': 'hook registered',
        'memory.extractionNotRegistered': 'HOOK NOT REGISTERED',
        'memory.extractionNoTrace': 'no extraction trace recorded by this Host',
        'memory.diagTitle': 'Extraction diagnostics:',
        'memory.diagSteps': '{ok}/{total} hooks installed',
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
        'memory.implicitModel': 'Model for automatic extraction',
        'memory.implicitModelOff': 'Off — no model call, costs nothing',
        'memory.implicitModelCurrent': 'Use the model this conversation is already using',
        'memory.implicitModelHint':
          'Automatic extraction sends one small request at the end of each turn. Choosing a model here is what authorises that spend; "Off" and "Use the current model" are the two ends of the tradeoff.',
        'memory.clearCold': 'Clear cold archive',
        'memory.coldCleared': 'Cold archive cleared',
        'memory.maintainedConflicts': 'conflicts queued',
        'memory.maintainedLessonsArchived': 'lessons archived',
        'memory.painDistilled': 'Lessons from the last painful turn',
        'memory.painQuiet': 'Last turn raised no lesson',
        'memory.painTurn': 'turn',
        'memory.portableTitle': 'Portable memory snapshot',
        'memory.portableHint':
          'Export the whole library as one plain Markdown file: the global store plus every registered workspace, each in its own section. Internal and cold-archived entries are included; secret ones never leave this machine and are counted at the end.',
        'memory.portableButton': 'Download Markdown',
        'memory.portableDone': 'Memory Markdown downloaded',
        'memory.healthTitle': 'Memory subsystem health',
        'memory.healthRecallFailed': 'RECALL REBUILD FAILED — the last prompt may have had no memories',
        'memory.healthRecallError': 'last error',
        'memory.healthRecallOk': 'Recall rebuild OK',
        'memory.healthHooks': '{ok}/{total} hooks installed',
        'memory.healthHookMissing': 'not installed: {names}',
        'memory.healthNoData': 'no status reported by this Host yet',
        'memory.healthExtraction': 'extraction: {reason}',
        'memory.conflictsTitle': 'Two memories disagree',
        'memory.conflictsHint':
          'These pairs say opposite things about the same subject, and both are injected into the same prompt — the model then picks one by recency, which is a coin flip. Pick the side that is true. Detection is automatic; the choice is yours on purpose, because "retracted", "narrowed by a condition" and "plan vs. what happened" all look identical to a detector.',
        'memory.conflictKeep': 'Keep this one',
        'memory.conflictKeepBoth': 'Both are right',
        'memory.conflictSettled': 'Conflict settled — the other side no longer reaches the prompt',
        'memory.conflictDismissed': 'Both kept — this pair will not be raised again',
        'memory.conflictSimilarity': 'similarity {value}',
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
        'share.recentLabel': '最近',
        'share.recentApply': '选中',
        'share.searchPlaceholder': '搜索轮次号或文字…',
        'share.searchHit': '匹配 {n} / {total} 轮',
        'share.pageFirst': '首页',
        'share.pagePrev': '上一页',
        'share.pageNext': '下一页',
        'share.pageLast': '末页',
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
        'message.resendDone': '已作为新一轮重发',
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
        'settings.budgetInherited': '+ {n} 个继承',
        'settings.inherited': '继承',
        'settings.orphansSweep': '清理孤儿快照',
        'settings.orphansConfirm': '再点一次确认删除',
        'settings.orphansNone': '没有孤儿快照目录',
        'settings.orphansFound': '{n} 个会话的孤儿快照，可释放 {size} —— 再点一次删除',
        'settings.orphansRemoved': '已删除 {n} 个会话的孤儿快照，释放 {size}',
        'settings.ghostsSweep': '清理会话残留',
        'settings.ghostsConfirm': '再点一次确认清理',
        'settings.ghostsNone': '没有残留的会话缓存或注册表记录',
        'settings.ghostsFound': '{caches} 个残留缓存、{ids} 个注册表死 id —— 再点一次清理',
        'settings.ghostsRemoved': '已清理 {caches} 个残留缓存与 {ids} 个注册表死 id',
        'settings.budgetNote':
          '只有这个会话自己的自动快照计入预算。从父会话继承来的快照（回滚或删除消息时产生）单独保留，所以列表可能比 {keep} 长。',
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
        'memory.episode': '经历',
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
        'memory.statsKind': '库里有什么',
        'memory.statsHealth': '分数分布',
        'memory.statsTags': '主题分布',
        'memory.kind.fact': '事实',
        'memory.kind.rule': '规则',
        'memory.kind.summary': '摘要',
        'memory.kind.episode': '经历',
        'memory.band.high': '强 ≥0.60',
        'memory.band.mid': '衰减 0.45-0.60',
        'memory.band.low': '低于线 <0.45',
        'memory.pendingHint': '从最近几轮里识别出来的，确认前不会入库。',
        'memory.extractionIdle': '当前没有待确认条目。上次检查结果：{reason}',
        'memory.extractionNotYet':
          '暂时还没有待确认条目。提取在每轮对话结束时运行，而本次启动后还没完成过任何一轮——聊一两句再回来看。',
        'memory.extractionUnknown': '本次运行还没有执行过提取',
        'panel.title': '会话套件',
        'panel.description': '会话快照、长期记忆、归档会话。每行点开就是对应的页面。',
        'panel.snapshots': '会话快照',
        'panel.snapshotsHint': '每轮结束时自动记录的工作区状态',
        'panel.memory': '长期记忆',
        'panel.memoryHint': '跨会话保留的事实、规则、偏好与经历',
        'panel.archived': '归档会话',
        'panel.archivedHint': '已从侧边栏隐藏的会话，可以在这里恢复',
        'panel.sessionsCount': '{n} 个会话有快照',
        'panel.statSessions': '会话',
        'panel.statSnapshots': '快照',
        'panel.statMemories': '记忆',
        'panel.statArchived': '已归档',
        'panel.statSessionsHint': '所有工作区，不含子代理会话',
        'panel.statSnapshotsHint': '所有会话的自动快照总数',
        'panel.statMemoriesHint': '全局 + 各工作区，含已归档',
        'panel.statArchivedHint': '从侧边栏隐藏，可恢复',
        'panel.breakdownTitle': '记忆存在哪',
        'panel.breakdownGlobal': '全局（所有工作区共享）',
        'panel.breakdownHint': '每个工作区有独立的库；上面的总数 = 这些之和 + 全局。',
        'panel.repoLink': 'GitHub 源码 - 鼓励一下',
        'panel.noSettingsSeam': '这个 Host 版本没有暴露设置导航接口，无法打开对应页面。',
        'archived.title': '归档会话',
        'archived.description': '归档的会话从侧边栏隐藏。恢复后会重新出现，不会删除任何东西。',
        'archived.empty': '没有归档的会话。',
        'archived.restore': '恢复',
        'archived.restored': '已恢复',
        'archived.restoreFailed': '恢复失败',
        'archived.ghost': '残留标记',
        'archived.logged': '有日志',
        'archived.snapshots': '{n} 张快照',
        'archived.cleanupTitle': '批量清理',
        'archived.cleanupHint': 'Bot 插件会留下上千个归档标记：既没有会话日志，也没有快照。先预览，再选择删除整条会话或仅删除它的快照。',
        'archived.preview': '预览',
        'archived.previewing': '扫描中…',
        'archived.previewSessions': '{n} 个会话 · 可释放 {size}',
        'archived.previewSnapshots': '{n} 组快照 · 可释放 {size}',
        'archived.ghosts': '{n} 个残留标记（无日志）',
        'archived.targetSessions': '删除会话',
        'archived.targetSnapshots': '仅删除快照',
        'archived.cleanSessions': '删除 {n} 个归档会话',
        'archived.cleanSnapshots': '清除 {n} 个会话的快照',
        'archived.cleaned': '已清理 {n} 个，失败 {m} 个，释放 {size}',
        'archived.cleanFailed': '清理失败',
        'archived.confirmSessions': '永久删除 {n} 个归档会话？此操作不可撤销。',
        'archived.confirmSnapshots': '永久删除 {n} 个归档会话的快照？会话本身保留。',
        'archived.limitHint': '每批数量（0 = 全部）',
        'settings.archived': '已归档',
        'settings.checkpointCount': '{n} 张快照',
        'settings.working': '处理中…',
        'memory.extractionTried': '试过 {n} 个记忆模型',
        'memory.extractionQueued': '入队 {n} 条',
        'memory.extractionRejected': '剔除 {n} 条',
        'memory.extractionEvents': '收到 {n} 个会话事件',
        'memory.extractionTurns': '结束 {n} 轮',
        'memory.extractionRegistered': '钩子已注册',
        'memory.extractionNotRegistered': '钩子未注册',
        'memory.extractionNoTrace': '本次运行没有记录到提取痕迹',
        'memory.diagTitle': '提取诊断：',
        'memory.diagSteps': '{ok}/{total} 个钩子已装',
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
        'memory.implicitModel': '自动提取使用的模型',
        'memory.implicitModelOff': '关闭 —— 不调用模型，零消耗',
        'memory.implicitModelCurrent': '用当前对话正在使用的模型',
        'memory.implicitModelHint':
          '自动提取会在每轮结束时发一次小请求。在这里选定模型才代表你授权了这笔消耗；「关闭」和「用当前模型」是这笔取舍的两端。',
        'memory.clearCold': '清空冷归档',
        'memory.coldCleared': '冷归档已清空',
        'memory.maintainedConflicts': '新增矛盾',
        'memory.maintainedLessonsArchived': '归档教训',
        'memory.painDistilled': '上一轮痛苦轮提炼的教训',
        'memory.painQuiet': '上一轮无需提炼教训',
        'memory.painTurn': '第几轮',
        'memory.portableTitle': '可迁移的记忆快照',
        'memory.portableHint':
          '把整个记忆库导出为一份纯 Markdown：全局库 + 所有已登记工作区，每个工作区单独一节。能直接读、能放进 git、也能交给别的 Agent。internal 与冷归档会导出，secret 级永不离开本机，文件末尾报隐藏条数。',
        'memory.portableButton': '下载 Markdown',
        'memory.portableDone': '记忆 Markdown 已下载',
        'memory.healthTitle': '记忆子系统状态',
        'memory.healthRecallFailed': '召回重建失败 —— 上一轮可能没有注入任何记忆',
        'memory.healthRecallError': '最后一次错误',
        'memory.healthRecallOk': '召回重建正常',
        'memory.healthHooks': '钩子已安装 {ok}/{total}',
        'memory.healthHookMissing': '未安装：{names}',
        'memory.healthNoData': '本次运行尚未上报状态',
        'memory.healthExtraction': '提取：{reason}',
        'memory.conflictsTitle': '两条记忆互相矛盾',
        'memory.conflictsHint':
          '这些记忆对同一件事说了相反的话，而且两条都会被注入同一个提示词——模型只能按新旧挑一条，等于掷硬币。请选哪一条是对的。检测是自动的，裁决故意留给人：撤回的旧观念、加了条件的规则、计划与实情，在检测器眼里长得一模一样。',
        'memory.conflictKeep': '保留这条',
        'memory.conflictKeepBoth': '两条都对',
        'memory.conflictSettled': '矛盾已裁决——另一条不再进入提示词',
        'memory.conflictDismissed': '两条都保留——这对不会再被提起',
        'memory.conflictSimilarity': '相似度 {value}',
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

    /**
     * Download a file-producing action. `call()` always JSON.parse()s the body,
     * which would corrupt a Markdown attachment, so this goes straight to fetch
     * and hands the browser a Blob. Kept tiny and separate on purpose: only two
     * actions (session share and memory Markdown) return non-JSON bodies.
     */
    async function download(payload, fallbackName) {
      const response = await fetch(ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const blob = await response.blob()
      const disposition = response.headers.get('content-disposition') ?? ''
      const match = /filename="([^"]+)"/.exec(disposition)
      const name = match?.[1] ?? fallbackName
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = name
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    }

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
      // A right-pointing chevron: these rows navigate somewhere, so the row's
      // affordance is "go", not "expand".
      chevron: () => icon([h('path', { key: 'a', d: 'M6.2 3.6 10.6 8l-4.4 4.4' })]),
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
  background: var(--dsw-alias-bg-layer-3, #fff);
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
/* The model picker sits below the toggle as a labelled control, because it is a
   separate decision from "on/off": one says whether to extract, the other says who
   pays for it. */
.dss-curate-field {
  display: flex; flex-direction: column; gap: 6px; margin-top: 10px;
  padding: 12px 14px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08));
  background: var(--dsw-alias-bg-layer-1, #fff);
}
.dss-curate-label { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary, #1f1f1f); }

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

.dss-section { display: flex; flex-direction: column; gap: 12px; max-width: 1080px; width: 100%; }
/* A screen opened from the sidebar panel inherits the panel's scroll container, so it
   must not impose its own height. The settings dialog still renders these sections
   directly and relies on the dialog's own scrolling. */
/* The sidebar panel is a main-column surface. It must scroll: the memory list is
   dozens of rows, and without an explicit overflow the page clipped at the viewport
   with no way to reach the rest — reported as "no scroll wheel, there are already
   a dozen entries". The min-height 0 is required for the child flex column to shrink
   below its content size, otherwise overflow never triggers. */
.dss-panel {
  display: flex; flex-direction: column; gap: 14px;
  padding: 24px 32px; max-width: 1120px; margin: 0 auto;
  height: 100%; min-height: 0;
  overflow-y: auto; overscroll-behavior: contain;
}
.dss-panel h2 { margin: 0; font-size: 17px; font-weight: 600; color: var(--dsw-alias-label-primary, #1f1f1f); }
.dss-nav { display: flex; flex-direction: column; gap: 10px; }
/* Rows follow the shipped card idiom: the same border and background tokens
   dsh-connect-trae uses (--dsw-alias-border-l2 / --dsw-alias-bg-l2), so the panel
   looks like part of the app rather than a bolt-on. A left accent bar appears on
   hover and focus instead of a colour swap, which keeps the text readable in both
   themes and gives keyboard users the same affordance as mouse users. */
.dss-nav-row {
  position: relative;
  display: flex; align-items: center; gap: 14px; width: 100%;
  padding: 14px 16px; text-align: left; cursor: pointer;
  font: inherit; color: inherit;
  background: var(--dsw-alias-bg-layer-2, #fff);
  border: 1px solid var(--dsw-alias-border-l2, #e3e4e6);
  border-radius: 12px;
  transition: border-color .14s ease, background .14s ease, transform .14s ease;
}
.dss-nav-row::before {
  content: ''; position: absolute; left: 0; top: 12px; bottom: 12px; width: 3px;
  border-radius: 0 3px 3px 0;
  background: var(--dsw-alias-brand-primary, #4d6bfe);
  opacity: 0; transition: opacity .14s ease;
}
.dss-nav-row:hover, .dss-nav-row:focus-visible {
  border-color: var(--dsw-alias-brand-primary, #4d6bfe);
  background: var(--dsw-alias-bg-layer-3, #f7f8fa);
  outline: none;
}
.dss-nav-row:hover::before, .dss-nav-row:focus-visible::before { opacity: 1; }
.dss-nav-row:active { transform: translateY(1px); }
.dss-nav-row > svg { flex: none; color: var(--dsw-alias-label-tertiary, #9a9a9a); }
.dss-nav-main { display: flex; flex-direction: column; gap: 3px; flex: 1; min-width: 0; }
.dss-nav-title { font-size: 13.5px; font-weight: 600; color: var(--dsw-alias-label-primary, #1f1f1f); }
.dss-nav-hint { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary, #6b6b6b); }
.dss-nav-meta {
  flex: none; min-width: 28px; text-align: center;
  font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-secondary, #6b6b6b);
  background: var(--dsw-alias-bg-layer-3, #f2f3f5);
  border: 1px solid var(--dsw-alias-border-l2, #e3e4e6);
  border-radius: 999px; padding: 2px 9px;
}
.dss-panel-footer {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  font-size: 12px; color: var(--dsw-alias-label-tertiary, #9a9a9a);
  padding-top: 8px; border-top: 1px solid var(--dsw-alias-border-l3, #f0f0f0);
}
.dss-panel-link {
  color: var(--dsw-alias-brand-primary, #4d6bfe);
  text-decoration: none; font-size: 12px;
}
.dss-panel-link:hover, .dss-panel-link:focus-visible { text-decoration: underline; }
/* A four-up summary strip. It fills the column with information rather than
   decoration, and the numbers match the badges on the rows below. */
.dss-stat-strip {
  display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px;
}
.dss-stat {
  display: flex; flex-direction: column; gap: 3px;
  padding: 14px 16px;
  background: var(--dsw-alias-bg-layer-2, #fff);
  border: 1px solid var(--dsw-alias-border-l2, #e3e4e6);
  border-radius: 12px;
}
.dss-stat-value {
  font-size: 22px; font-weight: 650; line-height: 1.15;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-primary, #1f1f1f);
}
.dss-stat-label {
  font-size: 11.5px; color: var(--dsw-alias-label-secondary, #6b6b6b);
}
/* The caption under each figure. Small and tertiary: it explains the number without
   competing with it. */
.dss-stat-hint {
  font-size: 10.5px; line-height: 1.4;
  color: var(--dsw-alias-label-tertiary, #9a9a9a);
}
.dss-breakdown {
  display: flex; flex-direction: column; gap: 6px;
  padding: 14px 16px;
  background: var(--dsw-alias-bg-layer-3, #f7f8fa);
  border: 1px solid var(--dsw-alias-border-l2, #e3e4e6);
  border-radius: 12px;
}
.dss-breakdown-row { display: flex; align-items: baseline; gap: 10px; font-size: 12.5px; }
.dss-breakdown-key {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--dsw-alias-label-primary, #1f1f1f);
}
.dss-breakdown-value {
  flex: none; font-variant-numeric: tabular-nums; font-weight: 600;
  color: var(--dsw-alias-label-secondary, #6b6b6b);
}
.dss-breakdown-hint { font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-tertiary, #9a9a9a); }
/* The way back from a screen. Left-aligned and small: it is an escape hatch, not
   an action competing with the page's own controls. */
.dss-panel-nav { display: flex; align-items: center; margin-bottom: -2px; }
.dss-section.dss-embedded { max-width: none; gap: 10px; }
.dss-section h2 { margin: 0; font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary, #1f1f1f); }
.dss-section-head { display: flex; flex-direction: column; gap: 4px; }
.dss-section-title { font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary, #1f1f1f); }
.dss-section-desc { font-size: 12.5px; line-height: 19px; color: var(--dsw-alias-label-secondary, #6b6b6b); }
.dss-card {
  border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08));
  border-radius: 10px; background: var(--dsw-alias-bg-layer-1, #fff);
}
/* A bounded list: the library scrolls, the page does not.
   Without this the settings below sat below the fold behind fifty rows, so every
   change meant scrolling past the whole library first. 480px is about eleven rows,
   picked by looking at it rather than by arithmetic — it was raised from 360px after
   the first version read as too short. Single number, retune freely. overscroll-behavior
   contain stops a scroll that reaches the end of the list from continuing into the page,
   which is what makes the box feel like a box rather than a speed bump. */
/* Bulk archive cleanup. The old archive page statted every session on every
   render, which timed out at a thousand rows; the list below is capped and the
   cleanup card is the way to deal with the rest. */
.dss-archive-body { display: flex; flex-direction: column; gap: 12px; }
.dss-archive-cleanup {
  display: flex; flex-direction: column; gap: 8px;
  padding: 14px 16px;
}
.dss-archive-controls {
  display: flex; flex-wrap: wrap; align-items: center; gap: 12px;
  margin-top: 6px; font-size: 12.5px;
  color: var(--dsw-alias-label-secondary, #6b6b6b);
}
.dss-archive-controls label { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; }
.dss-archive-controls input[type='radio'] { accent-color: var(--dsw-alias-link, #4d6bfe); }
.dss-archive-limit input[type='number'] {
  width: 72px; height: 26px; padding: 0 8px;
  border: 1px solid var(--dsw-alias-border-l2, #e3e4e6);
  border-radius: 7px;
  background: var(--dsw-alias-bg-layer-1, #fff);
  color: var(--dsw-alias-label-primary, #1f1f1f);
  font: inherit;
}
.dss-archive-preview {
  display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px;
  margin-top: 8px; padding: 10px 12px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2, #fff);
  color: var(--dsw-alias-label-primary, #1f1f1f);
  font-size: 12.5px;
}
.dss-scroll-box {
  max-height: 480px;
  overflow-y: auto;
  overscroll-behavior: contain;
}
/* The extraction diagnostic. Deliberately larger than the meta text around it and set
   on its own tinted strip: it exists to answer "why is the queue empty", and the first
   version was 11px grey text inside a bordered box that the user reported not seeing
   at all. A diagnostic that cannot be found is not a diagnostic. */
.dss-extraction-diag {
  display: flex; flex-wrap: wrap; gap: 6px 16px; align-items: baseline;
  margin-top: 8px; padding: 8px 12px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2, #f2f3f5);
  font-size: 12.5px; line-height: 1.5;
  color: var(--dsw-alias-label-secondary, #4a4a4a);
  font-variant-numeric: tabular-nums;
}
.dss-diag-title {
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #1f1f1f);
}
.dss-diag-steps { color: var(--dsw-alias-label-secondary, #6b6b6b); }
/* The summary charts. Two narrow panels for composition and health, one wide panel
   for tags: composition and health are short lists, tags can run long. Bars are divs,
   not SVG, so they inherit the theme and stay legible in both palettes. */
.dss-stats { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.dss-stats-panel {
  display: flex; flex-direction: column; gap: 8px;
  padding: 14px 16px;
  background: var(--dsw-alias-bg-layer-1, #fff);
  border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08));
  border-radius: 10px;
}
.dss-stats-wide { grid-column: 1 / -1; }
.dss-statbar { display: flex; align-items: center; gap: 10px; font-size: 12px; }
/* The label was a fixed 76px with nowrap + ellipsis, so anything longer than a
   couple of Chinese characters was cut off mid-word — 「低于压缩线（<0.45）」
   rendered as 「低于压缩线…」 and the reader could not tell which band it was.
   A wider column that wraps is the honest fix: a truncated label still occupies the
   same space, it just stops being readable. */
.dss-statbar-label {
  flex: none; width: 108px;
  color: var(--dsw-alias-label-primary, #1f1f1f);
  line-height: 1.35;
  overflow-wrap: anywhere;
}
/* Composition and tag bars get distinct hues — declared at the END of the sheet, next
   to the fill rule, because source order decides between two single-class rules and an
   earlier declaration lost to the fill's own background. */
.dss-statbar-track {
  flex: 1; height: 8px; min-width: 0;
  background: var(--dsw-alias-bg-layer-2, #f2f3f5);
  border-radius: 4px; overflow: hidden;
}
.dss-statbar-fill {
  height: 100%; border-radius: 4px;
  background: var(--dsw-alias-brand-primary, #2563eb);
  transition: width .2s ease;
}
/* Health bands use the semantic colours the rest of the app already uses, so the
   meaning does not depend on reading the label. */
.dss-tone-good { background: var(--dsw-alias-state-success-primary, #1a9c50); }
.dss-tone-warn { background: var(--dsw-alias-state-warn-primary, #d97706); }
.dss-tone-bad { background: var(--dsw-alias-state-error-primary, #d93025); }
.dss-statbar-value {
  flex: none; width: 32px; text-align: right;
  font-variant-numeric: tabular-nums; font-weight: 600;
  color: var(--dsw-alias-label-secondary, #6b6b6b);
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
/* "Newest N" shortcut: sits at the end of the selection toolbar. The box is small on
   purpose — it takes a turn count, not free text. */
.dss-recent { display: flex; align-items: center; gap: 6px; margin-left: auto; }
.dss-recent-label { font-size: 12px; color: var(--dsw-alias-label-secondary, #6b6b6b); white-space: nowrap; }
.dss-recent-input { width: 72px; flex: 0 0 auto; text-align: right; }
/* Turn picker: search box, a fixed 10-row page, and a pager. The picker itself keeps
   its own scroll as a fallback for short viewports, but the page is bounded so the
   dialog height no longer depends on how long the conversation is. */
.dss-picker-wrap { display: flex; flex-direction: column; gap: 8px; min-height: 0; }
.dss-picker-filter { display: flex; align-items: center; gap: 8px; }
.dss-picker-search { flex: 1 1 auto; min-width: 0; }
.dss-picker-hit { font-size: 12px; color: var(--dsw-alias-label-secondary, #6b6b6b); white-space: nowrap; }
.dss-pager {
  display: flex; align-items: center; justify-content: center; gap: 6px;
  padding-top: 4px; font-size: 12px;
  color: var(--dsw-alias-label-secondary, #6b6b6b);
}
.dss-pager-pos { display: flex; align-items: center; gap: 4px; }
.dss-pager-input { width: 56px; text-align: center; }
.dss-pager-total { font-variant-numeric: tabular-nums; }
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
/* Colour overrides, last in the sheet on purpose.
   The first version put the hue classes before the fill rule, which sets a brand
   background — so every bar rendered the same near-black colour and the chart looked
   like five copies of one object. Source order decides here, not specificity: both are
   single-class selectors. Declared last so the hue wins, and the double-class form for
   the extra specificity that makes it survive a future rule added above. */
.dss-statbar-fill.dss-tone-c0 { background: #4d6bfe; }
.dss-statbar-fill.dss-tone-c1 { background: #7b5cf5; }
.dss-statbar-fill.dss-tone-c2 { background: #2aa6c9; }
.dss-statbar-fill.dss-tone-c3 { background: #14a37f; }
.dss-statbar-fill.dss-tone-c4 { background: #e0a03a; }
.dss-statbar-fill.dss-tone-c5 { background: #d9636a; }
.dss-statbar-fill.dss-tone-good { background: var(--dsw-alias-state-success-primary, #1a9c50); }
.dss-statbar-fill.dss-tone-warn { background: var(--dsw-alias-state-warn-primary, #d97706); }
.dss-statbar-fill.dss-tone-bad { background: var(--dsw-alias-state-error-primary, #d93025); }
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
      // Select the newest N turns. Turn numbers ascend with the conversation, so
      // "recent" means the highest N — sorting rather than slicing by array position,
      // because the outline order is not guaranteed to be the turn order.
      const recent = useCallback(
        count => {
          const rows = outline?.turns ?? []
          const keep = [...rows]
            .sort((a, b) => b.turn - a.turn)
            .slice(0, Math.max(1, count))
            .map(row => row.turn)
          setSelected(new Set(keep))
        },
        [outline],
      )
      return { selected, toggle, all, none, recent }
    }

    function rangesOf(outline, selected) {
      return (outline?.turns ?? [])
        .filter(row => selected.has(row.turn))
        .map(row => ({ startSeq: row.startSeq, endSeq: row.endSeq }))
    }

    const TURNS_PER_PAGE = 10

    function TurnPicker({ outline, selected, onToggle, t }) {
      const raw = outline?.turns ?? []
      // Newest first. Turn numbers ascend with the conversation, so sorting descending
      // puts the turn you just had on page 1 — which is what anyone opening this dialog
      // expects. The outline itself arrives oldest-first because that is the log order.
      const turns = [...raw].sort((a, b) => b.turn - a.turn)
      // Page + filter state live here, so paging does not reset when a box is ticked.
      const [page, setPage] = useState(1)
      const [query, setQuery] = useState('')

      if (turns.length === 0) return h('div', { className: 'dss-empty' }, t('settings.empty'))

      // Search matches the turn number or either side's text. Matching the NUMBER as a
      // string is deliberate: typing "141" is how a user names a specific turn, and a
      // substring match finds it alongside any turn whose text mentions 141.
      const needle = query.trim().toLowerCase()
      const matched = needle
        ? turns.filter(row => {
            if (String(row.turn).includes(needle)) return true
            const hay = `${row.preview ?? ''} ${row.answerPreview ?? ''}`.toLowerCase()
            return hay.includes(needle)
          })
        : turns

      const pageCount = Math.max(1, Math.ceil(matched.length / TURNS_PER_PAGE))
      // Clamp rather than store a valid page: the filter can shrink the list under the
      // current page, and showing an empty page would look like the search found nothing.
      const current = Math.min(Math.max(1, page), pageCount)
      const from = (current - 1) * TURNS_PER_PAGE
      const visible = matched.slice(from, from + TURNS_PER_PAGE)

      const go = next => setPage(Math.min(Math.max(1, next), pageCount))

      return h(
        'div',
        { className: 'dss-picker-wrap' },
        h(
          'div',
          { className: 'dss-picker-filter' },
          h('input', {
            type: 'search',
            className: 'dss-input dss-picker-search',
            value: query,
            placeholder: t('share.searchPlaceholder'),
            onChange: event => {
              setQuery(event.target.value)
              setPage(1)
            },
          }),
          needle
            ? h('span', { className: 'dss-picker-hit' }, t('share.searchHit', { n: matched.length, total: turns.length }))
            : null,
        ),
        h(
          'div',
          { className: 'dss-picker' },
          ...visible.map(row => {
            const checked = selected.has(row.turn)
            return h(
              'label',
              { key: row.turn, className: 'dss-pick' + (checked ? ' dss-pick-on' : '') },
              h('input', { type: 'checkbox', checked, onChange: () => onToggle(row.turn) }),
              h(
                'span',
                { className: 'dss-pick-main' },
                h(
                  'span',
                  { className: 'dss-pick-title' },
                  `${t('settings.turn', { turn: row.turn })} · ${row.preview || '—'}`,
                ),
                row.answerPreview ? h('span', { className: 'dss-pick-sub' }, row.answerPreview) : null,
              ),
            )
          }),
        ),
        // Paging controls. A page number input rather than only prev/next, because
        // scrolling 146 rows to reach turn 3 is exactly what the user objected to.
        pageCount > 1
          ? h(
              'div',
              { className: 'dss-pager' },
              h('button', { type: 'button', className: 'dss-btn dss-small dss-ghost', disabled: current <= 1, onClick: () => go(1) }, t('share.pageFirst')),
              h('button', { type: 'button', className: 'dss-btn dss-small dss-ghost', disabled: current <= 1, onClick: () => go(current - 1) }, t('share.pagePrev')),
              h(
                'span',
                { className: 'dss-pager-pos' },
                h('input', {
                  type: 'number',
                  min: 1,
                  max: pageCount,
                  className: 'dss-input dss-pager-input',
                  value: current,
                  onChange: event => {
                    const value = Number.parseInt(event.target.value, 10)
                    if (Number.isFinite(value)) go(value)
                  },
                }),
                h('span', { className: 'dss-pager-total' }, `/ ${pageCount}`),
              ),
              h('button', { type: 'button', className: 'dss-btn dss-small dss-ghost', disabled: current >= pageCount, onClick: () => go(current + 1) }, t('share.pageNext')),
              h('button', { type: 'button', className: 'dss-btn dss-small dss-ghost', disabled: current >= pageCount, onClick: () => go(pageCount) }, t('share.pageLast')),
            )
          : null,
      )
    }

    function SelectionToolbar({ t, outline, selected, onAll, onNone, onRecent }) {
      const total = outline?.turns?.length ?? 0
      // A "last N turns" box, because "select all" then unticking forty checkboxes is
      // not a workflow. The number is a shortcut into the SAME selection set — it does
      // not change what gets exported, only which rows start ticked.
      const [recent, setRecent] = useState('')
      const apply = () => {
        const count = Number.parseInt(recent, 10)
        if (!Number.isFinite(count) || count <= 0) return
        onRecent(count)
      }
      return h(
        'div',
        { className: 'dss-toolbar' },
        h('span', { className: 'dss-group-title' }, t('share.selected', { count: selected.size, total })),
        h('button', { type: 'button', className: 'dss-btn dss-small dss-ghost', onClick: onAll }, t('share.all')),
        h('button', { type: 'button', className: 'dss-btn dss-small dss-ghost', onClick: onNone }, t('share.none')),
        h(
          'div',
          { className: 'dss-recent' },
          h('span', { className: 'dss-recent-label' }, t('share.recentLabel')),
          h('input', {
            type: 'number',
            min: 1,
            max: total,
            className: 'dss-input dss-recent-input',
            value: recent,
            placeholder: String(Math.min(10, total || 10)),
            onChange: event => setRecent(event.target.value),
            onKeyDown: event => {
              if (event.key === 'Enter') apply()
            },
          }),
          h('button', { type: 'button', className: 'dss-btn dss-small', onClick: apply }, t('share.recentApply')),
        ),
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
      const { selected, toggle, all, none, recent } = useTurnSelection(outline)
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
                h(SelectionToolbar, { t, outline, selected, onAll: all, onNone: none, onRecent: recent }),
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
      const { selected, toggle, all, none, recent } = useTurnSelection(outline)
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
                h(SelectionToolbar, { t, outline, selected, onAll: all, onNone: none, onRecent: recent }),
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
      // Two-step confirm for the orphan sweep: the first click reports, the second
      // deletes. Held in state so the button label can say which step it is on.
      const [orphanArmed, setOrphanArmed] = useState(false)
      const [ghostsArmed, setGhostsArmed] = useState(false)
      const [memoryDraft, setMemoryDraft] = useState('')
      // Kept for the memory.add API path that the long-term screen still uses; the
      // snapshot panel no longer renders a session-memory editor.

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
      // Split the list so the budget makes sense on screen.
      //
      // The header said "keeps the newest N automatic snapshots" while the list showed
      // sixteen, and nothing explained the difference: ten were this session's own and
      // six were inherited from the parent session by a rewind. Counting inherited
      // entries against the budget would make a fork delete every snapshot it takes
      // itself, so they are kept separately — but the user has to be told that, or the
      // number looks like a bug.
      const inheritedCount = (detail?.checkpoints ?? []).filter(cp => cp.inheritedFrom).length
      const statsLine = stats
        ? h(
            'div',
            { className: 'dss-row-meta' },
            h('span', null, t('settings.usage', { size: stats.label })),
            h('span', null, t('settings.budget', { keep: stats.budget })),
            inheritedCount > 0
              ? h('span', null, t('settings.budgetInherited', { n: inheritedCount }))
              : null,
            detail.cwd ? h('span', { title: detail.cwd }, detail.cwd) : null,
          )
        : null
      const budgetNote =
        inheritedCount > 0
          ? h('div', { className: 'dss-section-desc' }, t('settings.budgetNote', { keep: stats?.budget ?? 10 }))
          : null

      // Reclaiming snapshot directories of deleted sessions.
      //
      // `#prune` only runs when a session takes another snapshot, so a deleted
      // session's directory is never revisited and its blobs are never freed. The
      // first click reports what would go; the second confirms. A destructive action
      // that also runs on a timer is how people lose data they did not know they had,
      // so the timer only reports and this control is the only thing that deletes.
      const orphanLine = h(
        'div',
        { className: 'dss-toolbar' },
        h(
          'button',
          {
            type: 'button',
            className: 'dss-btn dss-small dss-ghost',
            disabled: busy === 'orphans',
            onClick: () =>
              run('orphans', async () => {
                const result = await call({ action: 'sweepOrphans', apply: orphanArmed })
                if (result?.orphans === 0) {
                  notify(t('settings.orphansNone'))
                  setOrphanArmed(false)
                  return
                }
                if (!orphanArmed) {
                  notify(t('settings.orphansFound', { n: result.orphans, size: result.freed }))
                  setOrphanArmed(true)
                  return
                }
                notify(t('settings.orphansRemoved', { n: result.removed, size: result.freed }))
                setOrphanArmed(false)
                bump()
              }, null),
          },
          orphanArmed ? t('settings.orphansConfirm') : t('settings.orphansSweep'),
        ),
      )

      // Stale projection caches and dead registry ids left by older deletes.
      // Both actions are dry-run by default; the first click only reports, the
      // second applies. Kept separate from the snapshot orphan sweep because
      // they clean different stores and a user may want one but not the other.
      const ghostsLine = h(
        'div',
        { className: 'dss-toolbar' },
        h(
          'button',
          {
            type: 'button',
            className: 'dss-btn dss-small dss-ghost',
            disabled: busy === 'ghosts',
            onClick: () =>
              run('ghosts', async () => {
                const [caches, registry] = await Promise.all([
                  call({ action: 'sweepGhostCaches', apply: ghostsArmed }),
                  call({ action: 'purgeRegistryGhosts', apply: ghostsArmed }),
                ])
                const cacheCount = caches?.orphans ?? 0
                const idCount = registry?.deadIds?.length ?? 0
                if (cacheCount === 0 && idCount === 0) {
                  notify(t('settings.ghostsNone'))
                  setGhostsArmed(false)
                  return
                }
                if (!ghostsArmed) {
                  notify(t('settings.ghostsFound', { caches: cacheCount, ids: idCount }))
                  setGhostsArmed(true)
                  return
                }
                notify(t('settings.ghostsRemoved', { caches: caches?.removed ?? 0, ids: idCount }))
                setGhostsArmed(false)
                bump()
              }, null),
          },
          ghostsArmed ? t('settings.ghostsConfirm') : t('settings.ghostsSweep'),
        ),
      )

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
                      // Inherited snapshots are a different thing from this session's
                      // own: they came from the parent by a rewind, they do not count
                      // against the budget, and deleting the child does not delete them.
                      cp.inheritedFrom ? h('span', { className: 'dss-badge' }, t('settings.inherited')) : null,
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

      // The session-memory block was removed deliberately.
      //
      // It was a per-session list of loose facts, never written to, sitting next to a
      // real trajectory view that the Host already provides. Two surfaces for "what
      // happened in this session" — one authoritative and read-only, one a stub that
      // nobody fed — invites the reader to trust the stub. The trajectory is the
      // record of what happened and is not meant to be edited; a hand-written note
      // beside it is a weaker duplicate. Removed rather than hidden so the panel does
      // not advertise a capability it does not have.

      return h(
        'div',
        { className: sectionClass },
        head,
        picker,
        statsLine,
        budgetNote,
        checkpointList,
        undoList,
        orphanLine,
        ghostsLine,
      )
    }

    // ------------------------------------------------------- long-term memory

    /**
     * One horizontal bar, drawn with a div rather than SVG.
     *
     * A bar chart of five rows does not need a charting library: a filled div inside
     * a track is the whole implementation, it inherits the theme's colours, and it
     * stays readable in both light and dark without any per-chart configuration. The
     * value is printed next to the bar, because the bar communicates proportion and
     * the number communicates quantity — one without the other is guesswork.
     *
     * @param {any} props row props
     * @returns {any} row element
     */
    function StatBar(props) {
      const { label, value, max, tone, hue } = props
      const ratio = max > 0 ? Math.min(1, value / max) : 0
      // `tone` is semantic (health bands); `hue` is positional (composition and tags).
      // They are separate because one means "this is bad" and the other means "this is
      // a different row" — conflating them would colour a healthy category red just
      // because it happens to be fifth.
      const fillClass = tone
        ? ` dss-tone-${tone}`
        : typeof hue === 'number'
          ? ` dss-tone-c${hue % 6}`
          : ''
      return h(
        'div',
        { className: 'dss-statbar' },
        h('div', { className: 'dss-statbar-label', title: String(label) }, label),
        h(
          'div',
          { className: 'dss-statbar-track' },
          h('div', {
            className: `dss-statbar-fill${fillClass}`,
            style: { width: `${Math.round(ratio * 100)}%` },
          }),
        ),
        h('div', { className: 'dss-statbar-value' }, String(value)),
      )
    }

    /**
     * The memory summary: what the library is made of, and whether it is healthy.
     *
     * Each panel answers one question a reader would actually ask, and each implies a
     * next action: a high rule count means maintenance is over-producing, a large
     * "below threshold" band means decay is about to archive things, a lopsided tag
     * list means one topic is crowding out the rest. Numbers nobody would act on are
     * decoration; these are not.
     *
     * @param {any} props panel props
     * @returns {any} summary element
     */
    function MemoryStats(props) {
      const t = props.t ?? (key => key)
      const stats = props.stats
      if (!stats || typeof stats !== 'object') return null

      const kinds = [
        ['fact', stats.kind?.fact ?? 0],
        ['rule', stats.kind?.rule ?? 0],
        ['summary', stats.kind?.summary ?? 0],
        ['episode', stats.kind?.episode ?? 0],
      ].filter(([, count]) => count > 0)
      const kindMax = Math.max(1, ...kinds.map(([, count]) => count))

      const bands = [
        ['high', stats.bands?.high ?? 0, 'good'],
        ['mid', stats.bands?.mid ?? 0, 'warn'],
        ['low', stats.bands?.low ?? 0, 'bad'],
      ]
      const bandMax = Math.max(1, ...bands.map(([, count]) => count))

      const tagMax = Math.max(1, ...(stats.tags ?? []).map(item => item.count))

      return h(
        'div',
        { className: 'dss-stats' },
        h(
          'div',
          { className: 'dss-stats-panel' },
          h('div', { className: 'dss-group-title' }, t('memory.statsKind')),
          ...kinds.map(([kind, count], index) =>
            h(StatBar, { key: kind, label: t(`memory.kind.${kind}`), value: count, max: kindMax, hue: index }),
          ),
        ),
        h(
          'div',
          { className: 'dss-stats-panel' },
          h('div', { className: 'dss-group-title' }, t('memory.statsHealth')),
          ...bands.map(([band, count, tone]) =>
            h(StatBar, { key: band, label: t(`memory.band.${band}`), value: count, max: bandMax, tone }),
          ),
        ),
        h(
          'div',
          { className: 'dss-stats-panel dss-stats-wide' },
          h('div', { className: 'dss-group-title' }, t('memory.statsTags')),
          ...(stats.tags ?? []).slice(0, 6).map((item, index) =>
            h(StatBar, { key: item.tag, label: item.tag, value: item.count, max: tagMax, hue: index }),
          ),
        ),
      )
    }

    function useWorkspacePath() {
      return runtime.resolveCwd?.() ?? runtime.cwd
    }

    /** Last path segment, for a compact workspace label. */
    function basename(value) {
      const text = String(value ?? '')
      const cut = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'))
      return cut >= 0 ? text.slice(cut + 1) || text : text
    }

    // --------------------------------------------------------- sidebar panel

    /**
     * The sidebar icon.
     *
     * The owner supplies `size` and `active`, so the glyph has to inherit both
     * rather than carry its own colour — a tinted icon reads as branding and
     * clashes with the selected state the shell already draws around it.
     *
     * @param {any} props owner props
     * @returns {any} icon element
     */
    function SuiteIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 18
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        // Two stacked frames: this bundle is about sessions kept as snapshots, so
        // the mark is layers rather than the clock-like arc a "history" icon would
        // use (and which already means rewind in the action row).
        h('rect', { key: 'a', x: 2.6, y: 4.4, width: 8.4, height: 8.2, rx: 1.6 }),
        h('path', { key: 'b', d: 'M5.4 4.3V3.4a1.2 1.2 0 0 1 1.2-1.2h5.4a1.2 1.2 0 0 1 1.2 1.2v6.4' }),
      )
    }

    /**
     * The panel shown when the sidebar icon is selected.
     *
     * It renders the three screens IN PLACE rather than navigating to Settings.
     *
     * That is not the first design. The first version was a navigation menu whose
     * rows called the settings shell's `openSection(id)`, copied from a comment in
     * dsh-connect-trae. It did nothing, and reading the shipped bundles explains why:
     *
     *   • `createSettingsShellStore()` is created inside
     *     `dsh-client-ui-settings-general` and never published — no `reflect.provide`,
     *     no service name — so no other client plugin can reach `openSection`.
     *   • `pluginNavigation` (the one real navigation service) offers only
     *     `openList()` and `openBundle(name)`, and `openBundle` lands on the bundle
     *     page (`view: { kind: 'package' }`), which renders `plugins.bundle.config`
     *     and bundle rows — it does not render `settings.section` pages at all.
     *
     * So "click a row, land on a settings page" cannot be built from outside the
     * settings package. The honest fix is to put the screens here, where they are
     * reachable, and keep the settings pages as a second way in. Both render the same
     * components, so there is one implementation of each screen and nothing to sync.
     *
     * @param {any} props slot props
     * @returns {any} panel element
     */
    function SuitePanel(props) {
      const t = props.t ?? (key => key)
      const rev = useStore(revision)
      // Which screen is open. `null` shows the three-entry list.
      const [open, setOpen] = useState(null)
      const [counts, setCounts] = useState(null)
      const [error, setError] = useState(null)

      // The three numbers that tell the user whether there is anything behind each
      // row. A panel whose entries all look identical regardless of content is just
      // a menu; showing counts is what makes it worth opening.
      //
      // Two shape facts this relies on, both of which cost a round of debugging when
      // guessed wrong: the action is `list` (not `listSessions` — the Host method is
      // named that, the action is not), and it answers with a bare ARRAY.
      //
      // `scope: 'all'` is passed deliberately. The panel has no workspace of its own,
      // and calling `longterm.list` with no scope returned only the GLOBAL store —
      // 17 rows for a library of 51 — which is why the panel said 17 while the
      // settings page said something else entirely. 'all' now means every store.
      useEffect(() => {
        let alive = true
        // Whether the long-term memory engine is running at all.
        //
        // It is OFF by default because it collides with dsh-fish-memory: both inject at
        // `systemPrompt.context({ order: 900 })`, so two memory blocks per request and
        // double the tokens. When it is off the API answers LONGTERM_DISABLED and the
        // panel must show only the session half — a memory row that opens onto a
        // disabled engine is worse than no row.
        Promise.all([
          call({ action: 'longterm.list', scope: 'all' }).then(
            value => ({ enabled: true, value }),
            error => ({ enabled: error?.code !== 'LONGTERM_DISABLED', value: [] }),
          ),
          call({ action: 'list' }).catch(() => []),
          // Per-workspace breakdown, so the totals can be explained rather than
          // merely displayed. The counts above are sums; without this the user
          // cannot tell which workspace contributes what — the exact question that
          // made the earlier 17/21/27/51 mismatch look like a bug.
          call({ action: 'longterm.workspaces' }).catch(() => []),
        ])
          .then(([memory, sessions, workspaces]) => {
            if (!alive) return
            const items = Array.isArray(sessions) ? sessions : []
            const stores = Array.isArray(workspaces) ? workspaces : []
            const memoryRows = Array.isArray(memory?.value) ? memory.value : []
            // The global store's size, so the breakdown adds up to the total instead
            // of leaving the difference unexplained.
            const globalRows = memoryRows.filter(row => row.scope === 'global').length
            setCounts({
              memoryEnabled: memory?.enabled === true,
              memories: memoryRows.length,
              memoryActive: memoryRows.filter(row => row.archived !== true).length,
              memoryArchived: memoryRows.filter(row => row.archived === true).length,
              memoryGlobal: globalRows,
              sessions: items.length,
              snapshots: items.reduce((sum, item) => sum + (item.checkpoints ?? 0), 0),
              archived: items.filter(item => item.archived === true).length,
              // Each store's own size, so the total has a visible decomposition.
              stores: stores.map(store => ({
                cwd: store.cwd ?? store.key,
                entries: store.entries ?? 0,
              })),
            })
          })
          .catch(failure => alive && setError(failure?.message ?? String(failure)))
        return () => {
          alive = false
        }
      }, [rev])

      // One screen is open: render it, with a way back.
      if (open) {
        const screens = {
          snapshots: SnapshotSection,
          memory: MemorySection,
          archived: ArchivedSection,
        }
        const Screen = screens[open]
        return h(
          'div',
          { className: 'dss-panel' },
          h(
            'div',
            { className: 'dss-panel-nav' },
            h(
              'button',
              { type: 'button', className: 'dss-btn dss-small dss-ghost', onClick: () => setOpen(null) },
              `‹ ${t('panel.title')}`,
            ),
          ),
          Screen ? h(Screen, { t }) : null,
        )
      }

      /** @param {string} key screen key @param {string} title row title @param {string} hint row hint */
      const row = (key, title, hint, meta) =>
        h(
          'button',
          {
            key,
            type: 'button',
            className: 'dss-nav-row',
            onClick: () => setOpen(key),
          },
          h(
            'div',
            { className: 'dss-nav-main' },
            h('div', { className: 'dss-nav-title' }, title),
            h('div', { className: 'dss-nav-hint' }, hint),
          ),
          meta === undefined ? h(Icons.chevron, null) : h('div', { className: 'dss-nav-meta' }, String(meta)),
        )

      return h(
        'div',
        { className: 'dss-panel' },
        h(
          'div',
          { className: 'dss-section-head' },
          h('h2', null, t('panel.title')),
          h('div', { className: 'dss-section-desc' }, t('panel.description')),
        ),
        error ? h('div', { className: 'dss-dialog-error' }, error) : null,
        // A summary strip, because three rows alone left most of the column empty.
        // The numbers are the same ones the rows carry, so it adds orientation
        // without inventing a second source of truth.
        //
        // Each figure states what it counts. Showing bare numbers is how the earlier
        // mismatch became a bug report: the user saw 17 here and 21 there, both
        // labelled "memory", with nothing on screen saying one was the global store
        // and the other was global plus one workspace.
        h(
          'div',
          { className: 'dss-stat-strip' },
          ...[
            ['panel.statSessions', counts?.sessions, 'panel.statSessionsHint'],
            ['panel.statSnapshots', counts?.snapshots, 'panel.statSnapshotsHint'],
            // Memory figures only exist when the engine is on. Showing a zero here
            // would claim "you have no memories" when the truth is "memory is off".
            ...(counts?.memoryEnabled === true
              ? [
                  ['panel.statMemories', counts?.memories, 'panel.statMemoriesHint'],
                  ['panel.statArchived', counts?.archived, 'panel.statArchivedHint'],
                ]
              : [['panel.statArchived', counts?.archived, 'panel.statArchivedHint']]),
          ].map(([label, value, hint]) =>
            h(
              'div',
              { className: 'dss-stat', key: label, title: t(hint) },
              h('div', { className: 'dss-stat-value' }, value === undefined ? '—' : String(value)),
              h('div', { className: 'dss-stat-label' }, t(label)),
              h('div', { className: 'dss-stat-hint' }, t(hint)),
            ),
          ),
        ),
        // The decomposition, so the total is checkable rather than a number to trust.
        // Only when memory is on: it explains the memory total.
        counts?.memoryEnabled === true && counts?.stores?.length
          ? h(
              'div',
              { className: 'dss-breakdown' },
              h('div', { className: 'dss-group-title' }, t('panel.breakdownTitle')),
              h(
                'div',
                { className: 'dss-breakdown-row' },
                h('span', { className: 'dss-breakdown-key' }, t('panel.breakdownGlobal')),
                h('span', { className: 'dss-breakdown-value' }, String(counts.memoryGlobal ?? '—')),
              ),
              ...counts.stores.map(store =>
                h(
                  'div',
                  { className: 'dss-breakdown-row', key: store.cwd },
                  h(
                    'span',
                    { className: 'dss-breakdown-key', title: store.cwd },
                    String(store.cwd).split(/[\\/]/).filter(Boolean).pop() ?? store.cwd,
                  ),
                  h('span', { className: 'dss-breakdown-value' }, String(store.entries)),
                ),
              ),
              h('div', { className: 'dss-breakdown-hint' }, t('panel.breakdownHint')),
            )
          : null,
        h(
          'div',
          { className: 'dss-nav' },
          row('snapshots', t('panel.snapshots'), t('panel.snapshotsHint'), counts?.snapshots),
          // The memory screen is shown whenever the engine is running. It was hidden
          // for a while when the engine was off by default; now that the engine is on
          // by default again, the row belongs here unconditionally — the engine is
          // this bundle's own long-term memory, not a competing plugin's.
          counts?.memoryEnabled === true
            ? row('memory', t('panel.memory'), t('panel.memoryHint'), counts?.memories)
            : null,
          row('archived', t('panel.archived'), t('panel.archivedHint'), counts?.archived),
        ),
        h(
          'div',
          { className: 'dss-panel-footer' },
          h('span', null, t('panel.sessionsCount', { n: counts?.sessions ?? 0 })),
          // A way to find the source. dsh-connect-trae puts a GitHub link in the same
          // place, and it is the one line in a panel like this that answers "who made
          // this and where do I report a problem".
          h(
            'a',
            {
              className: 'dss-panel-link',
              href: 'https://github.com/heixiua/dsh-session-suite',
              target: '_blank',
              rel: 'noreferrer noopener',
            },
            t('panel.repoLink'),
          ),
        ),
      )
    }

    // --------------------------------------------------- archived sessions

    /**
     * Archived sessions, with a way back.
     *
     * Archiving existed as a Host command but had no surface here, so a session
     * could be archived and then be unreachable — the sidebar hides it and the only
     * way back was the Host's own menu, which is disabled in the context where the
     * archive happened. This page is the missing half: it lists what the sidebar is
     * hiding and offers restore.
     *
     * Restore, not delete, is the primary action. Archived rows are still complete
     * sessions; the common mistake is to treat "hidden" as "gone" and destroy data
     * to tidy a list.
     *
     * @param {any} props slot props
     * @returns {any} section element
     */
    function ArchivedSection(props) {
      const t = props.t ?? (key => key)
      const rev = useStore(revision)
      const [rows, setRows] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(null)
      const [target, setTarget] = useState('sessions')
      const [preview, setPreview] = useState(null)
      const [previewBusy, setPreviewBusy] = useState(false)
      const [limit, setLimit] = useState(0)

      /**
       * `listArchived` folds snapshot counts in on the Host in ONE pass. The
       * old `list` action statted every session on every render; with the
       * thousand-plus archived rows left by bot plugins that timed out the
       * page and reported "0 snapshots" for everything.
       */
      useEffect(() => {
        let alive = true
        call({ action: 'listArchived' })
          .then(result => {
            if (!alive) return
            setRows(Array.isArray(result) ? result : [])
          })
          .catch(failure => alive && setError(failure?.message ?? String(failure)))
        return () => {
          alive = false
        }
      }, [rev])

      // A preview is only valid for the target and limit it was computed with.
      useEffect(() => { setPreview(null) }, [target, limit, rev])

      /** @param {string} sessionId session to restore */
      const restore = async sessionId => {
        setBusy(sessionId)
        setError(null)
        try {
          await call({ action: 'restoreSession', sessionId })
          notify(t('archived.restored'))
          bump()
        } catch (failure) {
          setError(failure?.message ?? t('archived.restoreFailed'))
        } finally {
          setBusy(null)
        }
      }

      const runPreview = async () => {
        setPreviewBusy(true)
        setError(null)
        try {
          const data = await call({ action: 'previewArchivedSweep', target, limit })
          setPreview(data)
        } catch (failure) {
          setError(failure?.message ?? t('archived.cleanFailed'))
        } finally {
          setPreviewBusy(false)
        }
      }

      const runClean = () => {
        const count = preview?.candidates?.filter(row => row.skipped === undefined).length ?? 0
        if (count === 0) return
        const size = humanBytes(preview?.bytes ?? 0)
        dialog.set({
          title: t('archived.cleanupTitle'),
          critical: true,
          body: t(target === 'sessions' ? 'archived.confirmSessions' : 'archived.confirmSnapshots', { n: count }) +
            ` (${size})`,
          onConfirm: async () => {
            const result = await call({ action: 'sweepArchivedSessions', target, limit })
            notify(t('archived.cleaned', {
              n: result?.removed?.length ?? 0,
              m: result?.failed?.length ?? 0,
              size: humanBytes(result?.bytes ?? 0),
            }))
          },
        })
      }

      const head = h(
        'div',
        { className: 'dss-section-head' },
        h('h2', null, t('archived.title')),
        h('div', { className: 'dss-section-desc' }, t('archived.description')),
      )

      if (error) return h('div', { className: 'dss-section' }, head, h('div', { className: 'dss-dialog-error' }, error))
      if (!rows) return h('div', { className: 'dss-section' }, head, h('div', { className: 'dss-empty' }, t('settings.loading')))

      const ghosts = rows.filter(row => row.hasLog === false).length
      const cleanup = h(
        'div',
        { className: 'dss-card dss-archive-cleanup' },
        h('div', { className: 'dss-section-title' }, t('archived.cleanupTitle')),
        h('div', { className: 'dss-section-desc' }, t('archived.cleanupHint')),
        h(
          'div',
          { className: 'dss-archive-controls' },
          h(
            'label',
            null,
            h('input', {
              type: 'radio', name: 'dss-archive-target', checked: target === 'sessions',
              onChange: () => setTarget('sessions'),
            }),
            t('archived.targetSessions'),
          ),
          h(
            'label',
            null,
            h('input', {
              type: 'radio', name: 'dss-archive-target', checked: target === 'snapshots',
              onChange: () => setTarget('snapshots'),
            }),
            t('archived.targetSnapshots'),
          ),
          h('label', { className: 'dss-archive-limit' },
            t('archived.limitHint'),
            h('input', {
              type: 'number', min: 0, step: 50, value: limit,
              onChange: event => setLimit(Math.max(0, Number(event.target.value) || 0)),
            }),
          ),
          h('button', {
            type: 'button', className: 'dss-btn dss-small',
            disabled: previewBusy, onClick: runPreview,
          }, previewBusy ? t('archived.previewing') : t('archived.preview')),
        ),
        preview
          ? h(
              'div',
              { className: 'dss-archive-preview' },
              h('div', null, t(target === 'sessions' ? 'archived.previewSessions' : 'archived.previewSnapshots', {
                n: preview.candidates?.length ?? 0,
                size: humanBytes(preview.bytes ?? 0),
              })),
              h('div', null, t('archived.ghosts', {
                n: preview.candidates?.filter(row => row.hasLog === false).length ?? 0,
              })),
              h('button', {
                type: 'button', className: 'dss-btn dss-small dss-primary',
                disabled: busy !== null, onClick: runClean,
              }, t(target === 'sessions' ? 'archived.cleanSessions' : 'archived.cleanSnapshots', {
                n: preview.candidates?.filter(row => row.skipped === undefined).length ?? 0,
              })),
            )
          : null,
      )

      const body =
        rows.length === 0
          ? h('div', { className: 'dss-empty' }, t('archived.empty'))
          : h(
              'div',
              { className: 'dss-archive-body' },
              cleanup,
              h(
                'div',
                { className: 'dss-card' },
                ...rows.slice(0, 200).map(entry =>
                  h(
                    'div',
                    { className: 'dss-row', key: entry.sessionId },
                    h(
                      'div',
                      { className: 'dss-row-main' },
                      h('div', { className: 'dss-memory-text' }, entry.title || entry.sessionId),
                      h(
                        'div',
                        { className: 'dss-row-meta' },
                        h('span', { className: 'dss-badge dss-temp' }, t('settings.archived')),
                        h('span', null, entry.hasLog === false ? t('archived.ghost') : t('archived.logged')),
                        h('span', null, t('archived.snapshots', { n: entry.checkpoints ?? 0 })),
                      ),
                    ),
                    h(
                      'div',
                      { className: 'dss-row-actions' },
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dss-btn dss-small',
                          disabled: busy === entry.sessionId || entry.running === true,
                          onClick: () => restore(entry.sessionId),
                        },
                        busy === entry.sessionId ? t('settings.working') : t('archived.restore'),
                      ),
                    ),
                  ),
                ),
                rows.length > 200
                  ? h('div', { className: 'dss-row-meta', style: { padding: '10px 14px' } },
                      `+${rows.length - 200} more — use bulk cleanup`)
                  : null,
              ),
            )

      return h('div', { className: 'dss-section' }, head, body)
    }

    /** @param {number} bytes @returns {string} human-readable size */
    function humanBytes(bytes) {
      const n = Number(bytes) || 0
      if (n < 1024) return `${n} B`
      if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
      if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
      return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
    }

    function MemorySection(props) {
      const t = props.t
      const rev = useStore(revision)
      const [tab, setTab] = useState('all')
      const [items, setItems] = useState(null)
      const [settings, setSettings] = useState(null)
      const [error, setError] = useState(null)
      const [draft, setDraft] = useState('')
      const [draftScope, setDraftScope] = useState('workspace')
      const [busy, setBusy] = useState(null)
      const [known, setKnown] = useState([])
      // Aggregates for the summary charts, fetched separately so a slow list load
      // never blocks the numbers from appearing.
      const [stats, setStats] = useState(null)
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
      // Contradicting pairs awaiting a human decision. Kept in its own state so a
      // failed fetch cannot empty the library list, and so the panel can render
      // above the rows where it is actually read.
      const [conflicts, setConflicts] = useState([])

      // Which models can be called, loaded from the Host rather than from config.
      //
      // The model list is no longer fetched.
      //
      // It existed only to populate the "model for automatic extraction" picker, which
      // is gone along with the background extraction pipeline. Asking the Host for the
      // full model catalogue on every panel refresh was a real cost for a control that
      // no longer exists.

      const detected = useWorkspacePath()

      // Turn a stored workspace key into a readable name.
      //
      // The badge used to say 「本工作区」 for every workspace-scoped row, so a list
      // filtered to 全部 showed a dozen rows all claiming to be "this workspace" —
      // including rows from other workspaces. The key is a one-way hash, so the name
      // has to come from the registry, which is exactly what `longterm.workspaces`
      // returns.
      const workspaceLabel = key => {
        if (!key) return t('memory.workspace')
        const match = known.find(item => item.key === key)
        if (!match) return t('memory.workspace')
        const cwd = String(match.cwd ?? '')
        return cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd ?? t('memory.workspace')
      }
      const cwd = picked !== undefined ? picked : detected

      useEffect(() => {
        let alive = true
        call({ action: 'longterm.workspaces' })
          .then(list => alive && setKnown(Array.isArray(list) ? list : []))
          .catch(() => alive && setKnown([]))
        call({ action: 'longterm.stats' })
          .then(data => alive && setStats(data ?? null))
          .catch(() => alive && setStats(null))
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
          call({ action: 'longterm.settings' }),
          call({ action: 'longterm.status' }).catch(() => null),
          // The conflict queue is advisory: if this call fails the library is
          // still perfectly usable, so it must not fail the whole page.
          call({ action: 'longterm.conflicts', cwd }).catch(() => []),
        ])
          .then(([list, config, status, pending]) => {
            if (!alive) return
            setItems(list)
            setSettings(config)
            setMaint(status)
            setConflicts(Array.isArray(pending) ? pending : [])
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

      // An empty queue used to render nothing at all, which is indistinguishable
      // from a broken feature: the user cannot tell "the model judged this turn
      // unremarkable" from "every memory model failed" or "a filter ate the
      // result". When there is nothing pending, say why.
      const extraction = status?.extraction
      // Which optional hooks installed. Reported separately from the extraction trace
      // because a hook that never installed cannot write a trace — that is the whole
      // point: "no trace" has two causes and this separates them.
      const installStatus = Array.isArray(status?.install) ? status.install : []
      // The "suggested memories" panel is REMOVED.
      //
      // It existed to review suggestions produced by a per-turn extraction pipeline —
      // a background model call that never once produced a suggestion across seven
      // attempts, and whose replacement crashed the Host. Memories are now written
      // directly by the model calling the `remember` tool, so there is nothing to
      // "confirm": a stored memory is already a memory, visible in the list below.
      //
      // Kept as a null constant rather than deleted outright so the render site below
      // stays untouched and the diff stays small.
      const pendingBlock = null

      // Contradicting pairs, each rendered as the two claims side by side with a
      // "keep this one" button on each and one "both are right" escape. The queue
      // only exists because guessing the winner is wrong (lib/conflicts.js), so
      // every row must offer the "neither" answer too — otherwise a user whose
      // contradiction is really a narrowing or a plan-vs-reality has no correct
      // button and will pick one at random.
      const conflictBlock =
        conflicts.length === 0
          ? null
          : h(
              'div',
              { className: 'dss-card' },
              h('div', { className: 'dss-curate-title' }, t('memory.conflictsTitle')),
              h('div', { className: 'dss-mem-pending-hint' }, t('memory.conflictsHint')),
              ...conflicts.map(item =>
                h(
                  'div',
                  { className: 'dss-row', key: item.id, style: { flexDirection: 'column', alignItems: 'stretch' } },
                  ...[item.a, item.b].map(side =>
                    h(
                      'div',
                      { className: 'dss-row', key: side.id },
                      h(
                        'div',
                        { className: 'dss-row-main' },
                        h('div', { className: 'dss-memory-text' }, side.text),
                        // Which store this claim came from. A global rule applies
                        // everywhere; a workspace rule only here. Without the badge
                        // the two sides look interchangeable and the user cannot
                        // tell which one is the narrower claim. The workspace name
                        // comes from the registry — a key is a one-way hash.
                        h(
                          'div',
                          { className: 'dss-row-meta' },
                          h(
                            'span',
                            { className: 'dss-badge' + (side.scope === 'global' ? ' dss-locked' : '') },
                            side.scope === 'global' ? t('memory.global') : workspaceLabel(item.workspaceKey),
                          ),
                        ),
                      ),
                      h(
                        'div',
                        { className: 'dss-row-actions' },
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'dss-btn dss-small',
                            disabled: busy === `cfl:${item.id}`,
                            onClick: () =>
                              run(
                                `cfl:${item.id}`,
                                () => call({ action: 'longterm.resolve', id: item.id, winnerId: side.id }),
                                t('memory.conflictSettled'),
                              ),
                          },
                          t('memory.conflictKeep'),
                        ),
                      ),
                    ),
                  ),
                  h(
                    'div',
                    { className: 'dss-row-actions' },
                    h('span', { className: 'dss-row-meta' }, t('memory.conflictSimilarity', { value: Number(item.similarity ?? 0).toFixed(2) })),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dss-btn dss-small dss-ghost',
                        disabled: busy === `cfl:${item.id}`,
                        onClick: () =>
                          run(
                            `cfl:${item.id}`,
                            () => call({ action: 'longterm.resolve', id: item.id }),
                            t('memory.conflictDismissed'),
                          ),
                      },
                      t('memory.conflictKeepBoth'),
                    ),
                  ),
                ),
              ),
            )

      // The list gets its own scroll box.
      //
      // Without one, the whole page scrolled: fifty memories pushed the maintenance
      // and model controls far below the fold, so changing a setting meant scrolling
      // past the entire library first. A bounded box keeps the controls in place and
      // makes the list the only thing that moves. The height is a deliberate starting
      // point — roughly eight rows — chosen to leave the settings visible on a
      // laptop screen; it is a single number, easy to retune.
      const listBlock =
        visible.length === 0
          ? h('div', { className: 'dss-empty' }, t('memory.empty'))
          : h(
              'div',
              { className: 'dss-card dss-scroll-box' },
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
                      h('span', { className: 'dss-badge' + (entry.scope === 'global' ? ' dss-locked' : '') }, entry.scope === 'global' ? t('memory.global') : workspaceLabel(entry.workspaceKey)),
                      entry.kind === 'rule' ? h('span', { className: 'dss-badge dss-temp' }, t('memory.rule')) : null,
                      // An episode is a dated event, not a truth. Labelling it
                      // separately is what lets the user tell "this happened once"
                      // from "this is how things are".
                      entry.kind === 'episode' ? h('span', { className: 'dss-badge' }, t('memory.episode')) : null,
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
        // Which model does the background extraction call?
        //
        // This has to be an explicit choice. An earlier build silently fell back to
        // the Host's default model whenever no chain was configured, which spends the
        // The "model for automatic extraction" selector is REMOVED.
        //
        // It configured which model a background per-turn extraction call would use.
        // That pipeline no longer exists: memories are written by the model calling the
        // `remember` tool mid-conversation, so there is no separate model to choose and
        // no background cost to authorise. A control that configures nothing is worse
        // than no control — it implies a cost that is not being incurred.
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

      // The workspace picker only means something where a workspace is part of
      // the answer. On the 全局 tab every row is a global memory regardless of
      // which workspace is selected, so leaving the control visible invited the
      // reasonable question "why does switching it change nothing?" — the honest
      // fix is to hide it rather than to keep a control that does nothing.
      const showsWorkspaceScope = tab === 'all' || tab === 'workspace'
      const workspacePicker =
        !showsWorkspaceScope || known.length === 0
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
                `${t('memory.maintainedRules')} ${lastReport.rules}` +
                // Conflicts found by this pass. Without it the queue above would
                // appear with no explanation of when it was populated.
                (typeof lastReport.conflictsQueued === 'number' && lastReport.conflictsQueued > 0
                  ? ` · ${t('memory.maintainedConflicts')} ${lastReport.conflictsQueued}`
                  : '') +
                // Distilled lessons pushed out by their own ceiling. Eviction that
                // is not reported reads as data loss.
                (typeof lastReport.distilledArchived === 'number' && lastReport.distilledArchived > 0
                  ? ` · ${t('memory.maintainedLessonsArchived')} ${lastReport.distilledArchived}`
                  : ''),
            )
          : null,
        // Why the last painful turn did or did not produce a lesson. The three
        // outcomes (no pain / already known / read failed) are otherwise
        // indistinguishable, and the feature looks broken in two of them.
        maint?.pain
          ? h(
              'span',
              { className: 'dss-maint-report' },
              maint.pain.painful
                ? `${t('memory.painDistilled')} ${maint.pain.written} · ${(maint.pain.reasons ?? []).join(', ')}`
                : `${t('memory.painQuiet')} · ${t('memory.painTurn')} ${maint.pain.turn}`,
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

      // A portable, owner-readable snapshot. `call()` cannot be used here: it
      // JSON.parse()s every response, which would corrupt a Markdown body.
      const portableBlock = h(
        'div',
        { className: 'dss-card' },
        h('div', { className: 'dss-row-title' }, t('memory.portableTitle')),
        h('div', { className: 'dss-hint' }, t('memory.portableHint')),
        h(
          'div',
          { className: 'dss-row-actions' },
          h(
            'button',
            {
              className: 'dss-action',
              disabled: busy === 'portable',
              onClick: () =>
                run(
                  'portable',
                  () =>
                    download(
                      { action: 'longterm.exportMarkdownFile', cwd, workspaceLabel: cwd },
                      'dsh-memory.md',
                    ),
                  t('memory.portableDone'),
                ),
            },
            busy === 'portable' ? t('settings.loading') : t('memory.portableButton'),
          ),
        ),
      )

      // Failures that used to be invisible. `longterm.status` already carries
      // these three diagnostics; showing them is what turns "the queue is
      // empty / no memories got injected" from a mystery into a stated cause.
      // A hook that never installed cannot write a trace, so the ledger is
      // listed separately from the extraction reason.
      const healthRecall = maint?.recall
      const installRows = Array.isArray(maint?.install) ? maint.install : []
      const installOk = installRows.filter(row => row?.ok === true || row?.installed === true).length
      const missing = installRows
        .filter(row => row && row.ok !== true && row.installed !== true)
        .map(row => String(row.label ?? row.name ?? row.id ?? '?'))
      const extractionReason = maint?.extraction?.reason
      const healthBlock = h(
        'div',
        { className: 'dss-card' },
        h('div', { className: 'dss-row-title' }, t('memory.healthTitle')),
        maint
          ? h(
              'div',
              null,
              healthRecall?.failed
                ? h(
                    'div',
                    { className: 'dss-hint' },
                    t('memory.healthRecallFailed'),
                    healthRecall.error ? ` · ${t('memory.healthRecallError')}: ${String(healthRecall.error).slice(0, 160)}` : '',
                  )
                : h('div', { className: 'dss-hint' }, t('memory.healthRecallOk')),
              h(
                'div',
                { className: 'dss-row-meta' },
                t('memory.healthHooks', { ok: installOk, total: installRows.length }),
                missing.length ? ` · ${t('memory.healthHookMissing', { names: missing.join(', ') })}` : '',
              ),
              extractionReason
                ? h('div', { className: 'dss-row-meta' }, t('memory.healthExtraction', { reason: extractionReason }))
                : null,
            )
          : h('div', { className: 'dss-hint' }, t('memory.healthNoData')),
      )

      return h(
        'div',
        { className: 'dss-section' },
        head,
        pendingBlock,
        conflictBlock,
        h(MemoryStats, { t, stats }),
        explainBlock,
        portableBlock,
        healthBlock,
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

    /**
     * Report a Client-half failure somewhere a human can find it.
     *
     * A throw inside apply() makes the whole module register nothing, and the
     * symptom is silence: no settings page, no session-menu rows, no buttons.
     * There is no error surface of its own, so record the failure on a global and
     * log it loudly. This exists because the failure was invisible for several
     * rounds of debugging, with only a metadata warning to go on.
     *
     * @param {string} stage where it broke
     * @param {unknown} error what was thrown
     */
    function reportClientFailure(stage, error) {
      const detail = {
        bundle: 'dsh-session-suite',
        stage,
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? String(error.stack ?? '').split('\n').slice(0, 6).join('\n') : '',
        at: new Date().toISOString(),
      }
      try {
        globalThis.__DSH_SESSION_SUITE_ERROR__ = detail
      } catch {
        /* a frozen global is not worth failing over */
      }
      try {
        console.error('[dsh-session-suite] client half failed', detail)
      } catch {
        /* console may be unavailable in a sandboxed runtime */
      }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        try {
          applyInner(ctx)
        } catch (error) {
          reportClientFailure('apply', error)
          throw error
        }

        /**
         * The real body. Split out so one try/catch can cover every registration
         * without wrapping each line.
         *
         * @param {any} ctx client context
         */
        function applyInner(ctx) {
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

        // ---------------------------------------------------- sidebar entry
        //
        // A first-class sidebar entry, matching how dsh-connect-trae,
        // dsh-connect-workbuddy and dsh-context present themselves: an icon in
        // `sidebar.panellist` plus a panel under the same key in `main`. Both are
        // additive (`replaceRisk: none` on the list, and the key is one only this
        // plugin claims), so nothing shipped is shadowed.
        //
        // Why a panel at all: the features already existed but were reachable only
        // through Settings → one of two sections, three steps from anywhere. The
        // panel is pure navigation — it does not reimplement the sections, it opens
        // them, so there is one implementation of every screen.
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: 'session-suite', order: 25, locale: NS },
            withT(SuiteIcon),
          ),
        )

        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: 'session-suite' }, withT(SuitePanel)),
        )

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

        // The three settings sections are gone on purpose.
        //
        // They were the only way in before the sidebar panel existed, so the same
        // three screens appeared twice: once under Settings and once behind the
        // sidebar icon. Two entry points for one screen is not convenience, it is
        // two places to keep consistent and two places for the user to wonder about.
        // The panel is the primary surface now; these registrations were removed
        // rather than hidden behind a flag, because a dead section in Settings is
        // worse than an absent one.
        }
      },
    }
  },
})
