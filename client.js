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
        'message.undo': 'Undo this rewind',
        'message.undoDone': 'Rewind undone',
        'message.delete': 'Delete message',
        'message.deleteTitle': 'Delete this message?',
        'message.deleteBody':
          'The conversation rewinds to the message before it, so this message and everything after it leave the session. Workspace files and memory are restored to that point too.',
        'message.deleteConfirm': 'Delete',
        'message.deleteFailed': 'Could not delete this message',
        'message.deleteOnly': 'This is the only message in the session. Deleting it also deletes the session.',
        'dialog.cancel': 'Cancel',
        'dialog.delete': 'Delete',
        'dialog.deleteTitle': 'Delete session',
        'dialog.deleteBody':
          'The session and everything inside it will be removed from local storage, including its conversation log, snapshots, and memory. This cannot be undone.',
        'dialog.deleting': 'Deleting…',
        'dialog.deleteDone': 'Session deleted',
        'dialog.deleteFailed': 'Could not delete the session',
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
      },
      zh: {
        'menu.delete': '删除任务',
        'menu.shareMarkdown': '分享为 Markdown',
        'menu.shareText': '复制对话文本',
        'menu.shareJson': '分享为 JSON',
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
        'message.undo': '撤销本次回滚',
        'message.undoDone': '已撤销回滚',
        'message.delete': '删除消息',
        'message.deleteTitle': '确定要删除这条消息吗？',
        'message.deleteBody':
          '删除后，对话会回滚到这条消息之前，这条消息及其之后的内容都不会再出现在会话里，工作区文件与会话记忆也会恢复到那一刻。',
        'message.deleteConfirm': '删除',
        'message.deleteFailed': '删除消息失败',
        'message.deleteOnly': '这是当前会话中唯一的消息，删除后会同时删除该会话。',
        'dialog.cancel': '取消',
        'dialog.delete': '删除',
        'dialog.deleteTitle': '删除任务',
        'dialog.deleteBody': '删除后，这个会话及其所有内容将从本地移除，包括聊天记录、快照和会话记忆，且无法恢复。',
        'dialog.deleting': '正在删除…',
        'dialog.deleteDone': '会话已删除',
        'dialog.deleteFailed': '删除会话失败',
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

    function shareUrl(sessionId, format, download) {
      const search = new URLSearchParams({ action: 'share', sessionId, format })
      if (download) search.set('download', '1')
      return `${ROUTE}?${search.toString()}`
    }

    function downloadShare(sessionId, format) {
      const anchor = document.createElement('a')
      anchor.href = shareUrl(sessionId, format, true)
      anchor.download = ''
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
    }

    async function copyShare(sessionId) {
      const response = await fetch(shareUrl(sessionId, 'txt', false))
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const text = await response.text()
      if (!text.trim()) throw new Error('empty export')
      await navigator.clipboard.writeText(text)
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

.dss-toast {
  position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%);
  z-index: 70; padding: 9px 14px; border-radius: 999px; pointer-events: none;
  font-size: 13px; color: var(--dsw-alias-bg-base, #fff);
  background: var(--dsw-alias-label-primary, #1f1f1f);
  box-shadow: 0 8px 24px rgba(15, 18, 24, .24);
}
.dss-toast.dss-error { background: var(--dsw-alias-state-error-primary, #d93025); }

.dss-section { display: flex; flex-direction: column; gap: 12px; max-width: 720px; }
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

    function DialogFrame({ title, critical, onClose, children }) {
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
            className: 'dss-dialog',
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
      const t = state.t ?? (key => key)

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
            await call({ action: 'deleteSession', sessionId: state.sessionId })
            notify(t('dialog.deleteDone'))
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

      const body = state.mode === 'delete-session'
        ? h('div', { className: 'dss-dialog-body' }, t('dialog.deleteBody'), state.onlyMessage ? h('div', { style: { marginTop: 8 } }, t('message.deleteOnly')) : null)
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

    function SuiteOverlay() {
      const state = useStore(dialog)
      const message = useStore(toast)
      return h(
        React.Fragment,
        null,
        state ? h(SelectSessionDialog, { key: state.key ?? 'dialog', state, onClose: () => dialog.set(null) }) : null,
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

    function ShareMarkdownRow(props) {
      const { setMenuOpen, sessionId, t } = useSessionMenuRows(props, props.t)
      return h(MenuRow, {
        label: t('menu.shareMarkdown'),
        iconNode: h(Icons.download, null),
        separator: true,
        onSelect: () => {
          setMenuOpen(false)
          downloadShare(sessionId, 'md')
        },
      })
    }

    function ShareTextRow(props) {
      const { setMenuOpen, sessionId, t } = useSessionMenuRows(props, props.t)
      return h(MenuRow, {
        label: t('menu.shareText'),
        iconNode: h(Icons.clipboard, null),
        onSelect: () => {
          setMenuOpen(false)
          void copyShare(sessionId).then(
            () => notify(t('menu.shareCopied')),
            () => notify(t('menu.shareFailed'), 'error'),
          )
        },
      })
    }

    function ShareJsonRow(props) {
      const { setMenuOpen, sessionId, t } = useSessionMenuRows(props, props.t)
      return h(MenuRow, {
        label: t('menu.shareJson'),
        iconNode: h(Icons.code, null),
        onSelect: () => {
          setMenuOpen(false)
          downloadShare(sessionId, 'json')
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
          const result = await call({
            action: state.mode === 'delete' ? 'deleteMessage' : 'rollback',
            sessionId,
            messageId: state.messageId,
          })
          if (result?.childId && props.openSession) {
            props.openSession(result.childId)
          }
          notify(result?.deletedSession ? t('dialog.deleteDone') : t('message.rewindDone'))
          pending.set(null)
          bump()
        } catch (failure) {
          setError(failure?.message ?? t('message.rewindFailed'))
        } finally {
          setBusy(false)
        }
      }

      const isDelete = state.mode === 'delete'
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
            h('span', { className: 'dss-banner-title' }, t(isDelete ? 'message.deleteTitle' : 'message.rewindTitle')),
            h('span', { className: 'dss-banner-body' }, t(isDelete ? 'message.deleteBody' : 'message.rewindBody')),
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
            busy ? t('message.rewinding') : t(isDelete ? 'message.deleteConfirm' : 'message.rewindConfirm'),
          ),
        ),
      )
    }

    // ------------------------------------------------------- settings section

    function SnapshotSection(props) {
      const t = props.t
      const rev = useStore(revision)
      const [sessions, setSessions] = useState(null)
      const [selected, setSelected] = useState(null)
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
              const withSnapshots = rows.find(row => row.checkpoints > 0)
              return (withSnapshots ?? rows[0])?.sessionId ?? null
            })
          })
          .catch(failure => alive && setError(failure.message))
        return () => {
          alive = false
        }
      }, [rev])

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

      const head = h(
        'div',
        { className: 'dss-section-head' },
        h('h2', null, t('settings.title')),
        h('div', { className: 'dss-section-desc' }, t('settings.description')),
      )

      if (error && !detail) {
        return h('div', { className: 'dss-section' }, head, h('div', { className: 'dss-dialog-error' }, error))
      }
      if (!sessions) return h('div', { className: 'dss-section' }, head, h('div', { className: 'dss-empty' }, t('settings.loading')))
      if (sessions.length === 0) return h('div', { className: 'dss-section' }, head, h('div', { className: 'dss-empty' }, t('settings.noSessions')))

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
        { className: 'dss-section' },
        head,
        picker,
        statsLine,
        checkpointList,
        undoList,
        memoryBlock,
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
          const uiWorkspace = ctx.get('uiWorkspace')
          if (uiWorkspace?.openSession) {
            uiWorkspace.openSession(sessionId)
            return
          }
          const layout = ctx.get('layout')
          layout?.selectPanel?.('conversation')
        }
        runtime.openSession = openSession
        runtime.archiveSession = async sessionId => {
          const uiWorkspace = ctx.get('uiWorkspace')
          if (uiWorkspace?.archiveSession) return uiWorkspace.archiveSession(sessionId, { stopActivity: true })
          const workspaces = ctx.get('workspaces')
          if (workspaces?.archiveSession) return workspaces.archiveSession(sessionId, { stopActivity: true })
          return undefined
        }

        const withT = (component, extra) => props => h(component, { ...props, t: props.t ?? t, ...extra })

        const menuSlots = [
          ['sidebar.workspaces.session.menu.item', 'session-suite-share-markdown', 460, ShareMarkdownRow],
          ['sidebar.workspaces.session.menu.item', 'session-suite-share-text', 461, ShareTextRow],
          ['sidebar.workspaces.session.menu.item', 'session-suite-share-json', 462, ShareJsonRow],
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
      },
    }
  },
})
