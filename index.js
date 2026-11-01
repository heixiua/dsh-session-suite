/**
 * dsh-session-suite — Host half.
 *
 * Registers, for the desktop/web profile:
 *
 * - incremental workspace checkpoints captured at the start of every turn;
 * - the rollback operation (conversation prefix + files + memory, with an undo
 *   bundle that expires after ten minutes);
 * - permanent session deletion (log, projection cache, checkpoints, memory);
 * - session sharing as Markdown / text / JSON;
 * - a per-session memory ledger that participates in rollback;
 * - the authenticated Fetch route the browser half talks to.
 *
 * The module intentionally depends on `node:` builtins only: a bundle installed
 * into a profile is resolved from the profile, not from the DSH installation,
 * so importing @deepseek-ai runtime packages would not resolve.
 */

import os from 'node:os'
import path from 'node:path'
import { API_PATH, createRoute } from './lib/api.js'
import { CheckpointStore } from './lib/checkpoints.js'
import { MemoryLedger } from './lib/memory.js'
import { SessionSuiteService } from './lib/service.js'

export const name = 'session-suite'

/** The HTTP carrier is the only hard requirement; the rest degrade gracefully. */
export const inject = ['connection']

/**
 * @param {any} ctx plugin context
 * @param {any} [config] row config from cordis.patch.yml
 */
export function apply(ctx, config = {}) {
  const log = (message, error) => {
    if (error) ctx.logger?.warn?.(`[session-suite] ${message}`, error)
    else ctx.logger?.info?.(`[session-suite] ${message}`)
  }
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
  const root = path.join(home, 'storages', 'dsh-session-suite')
  const store = new CheckpointStore({
    root,
    log,
    ignores: Array.isArray(config.ignore) ? config.ignore.filter(item => typeof item === 'string') : [],
  })
  const memory = new MemoryLedger({ root })
  const service = new SessionSuiteService({ ctx, root, store, memory, log, config })

  ctx.effect(
    () => ctx.connection.fetch.register(createRoute(service, { log })),
    'session-suite: http route',
  )
  log(`http route ready at ${API_PATH}`)

  // One automatic checkpoint per turn, taken when the turn finishes: a snapshot
  // then represents "the workspace after turn N", which is exactly the state a
  // rewind to turn N must restore.
  if (config.autoCheckpoint !== false) {
    ctx.effect(
      () =>
        ctx.on('session/event', (session, event) => {
          if (!event || (event.type !== 'turn/end' && event.type !== 'turn/start')) return
          const sessionId = session?.id
          if (typeof sessionId !== 'string') return
          const cwd = resolveCwd(ctx, session)
          if (!cwd) return
          const limits = {
            keep: numberOr(config.keep, 10),
            maxFileBytes: numberOr(config.maxFileBytes, undefined),
            maxFiles: numberOr(config.maxFiles, undefined),
          }
          if (event.type === 'turn/end') {
            const turn = typeof event.data?.turn === 'number' ? event.data.turn : undefined
            void store
              .capture({
                sessionId,
                cwd,
                seq: typeof event.seq === 'number' ? event.seq : undefined,
                turn,
                phase: 'end',
                kind: 'auto',
                label: `after turn ${turn ?? '?'}`,
                limits,
              })
              .catch(error => log(`automatic checkpoint failed for ${sessionId}`, error))
            return
          }
          // Baseline: the state this session started from, captured before the
          // first turn touches anything. Rewinding to the very first prompt needs
          // it, and it is taken once per session.
          const startTurn = typeof event.data?.turn === 'number' ? event.data.turn : 1
          void store
            .list(sessionId)
            .then(list => {
              if (list.length > 0) return undefined
              return store.capture({
                sessionId,
                cwd,
                seq: typeof event.seq === 'number' ? event.seq : undefined,
                turn: startTurn - 1,
                phase: 'end',
                kind: 'auto',
                label: 'baseline',
                limits,
              })
            })
            .catch(error => log(`baseline checkpoint failed for ${sessionId}`, error))
        }),
      'session-suite: turn checkpoints',
    )
  }

  // Expired undo bundles and the per-session budget are swept on a slow timer.
  const sweepMs = numberOr(config.sweepIntervalMs, 5 * 60 * 1000)
  if (sweepMs > 0) {
    ctx.effect(() => {
      const timer = setInterval(() => {
        void service.sweep().catch(error => log('sweep failed', error))
      }, sweepMs)
      timer.unref?.()
      return () => clearInterval(timer)
    }, 'session-suite: sweep timer')
  }

  // A cold start should not leave expired bundles behind.
  void service.sweep().catch(error => log('initial sweep failed', error))
}

/**
 * @param {any} ctx plugin context
 * @param {any} session live session
 * @returns {string | undefined} workspace directory
 */
function resolveCwd(ctx, session) {
  const workingDirectory = ctx.get('workingDirectory')
  if (workingDirectory?.get) {
    try {
      const value = workingDirectory.get(session)
      if (typeof value === 'string' && value.length > 0) return value
    } catch {
      // fall through to the session header
    }
  }
  const meta = session?.meta ?? session?.header
  return typeof meta?.cwd === 'string' ? meta.cwd : undefined
}

/**
 * @param {unknown} value candidate
 * @param {number | undefined} fallback default
 * @returns {number | undefined} number
 */
function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
