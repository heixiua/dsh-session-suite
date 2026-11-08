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
import { installMemory } from './lib/memory-host.js'
import { SessionSuiteService } from './lib/service.js'
import { stripStepTagsFromStream } from './lib/step-tag-filter.js'

export const name = 'session-suite'

/**
 * The HTTP carrier is the only hard requirement; everything else degrades gracefully.
 *
 * 0.6.2: `agents` and `timer` were added for an implicit-extraction polling loop. That
 * loop crashed the Host with `cannot get property "timer" without inject` on every
 * 500ms tick. Both are removed. Do not re-add them without also proving the tick body
 * cannot throw and that the timer is disposed with the effect.
 */
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

  // The HTTP route comes first and unconditionally: session delete, share, and
  // rewind must keep working even if an optional integration below fails.
  ctx.effect(
    () => ctx.connection.fetch.register(createRoute(service, { log })),
    'session-suite: http route',
  )
  log(`http route ready at ${API_PATH}`)

  // Output hygiene: models occasionally emit the four internal step tags
  // (`<发>` / `<执行>` / `<好>` / `<现在>`, U+003C + word + U+003E) as a long run
  // inside an ordinary assistant reply. Left alone they land in the durable
  // assistant message, the live transcript, share exports, and every later
  // request that replays history. The `llm/stream` waterfall is the one layer
  // that covers all of those at once: the filter removes the tags from token
  // deltas and from the terminal block text the assembler persists. It is
  // config-gated (`stripStepTags: false` disables it) and never rewrites any
  // other angle-bracket text. A failure here is reported and skipped rather
  // than taking the bundle down.
  if (config.stripStepTags !== false) {
    try {
      ctx.effect(
        () =>
          ctx.on('llm/stream', (options, next) => {
            const stream = next()
            if (
              stream === null ||
              stream === undefined ||
              typeof stream[Symbol.asyncIterator] !== 'function'
            ) {
              return stream
            }
            return stripStepTagsFromStream(stream)
          }),
        'session-suite: step tag filter',
      )
      log('step tag filter ready')
    } catch (error) {
      log('step tag filter could not be installed; continuing without it', error)
    }
  }

  // Long-term memory: recall into the prompt, explicit writes, implicit
  // suggestions, the `memory` tool, and its management surface. A failure here
  // is reported and skipped rather than taking the whole bundle down.
  if (config.longTermMemory !== false) {
    try {
      const installed = installMemory({ ctx, root, config, log })
      // Attach the hook-level diagnostics to the engine before it is published:
      // `longterm.status` reads the engine, and a diagnostic that lives only in
      // the install return value can never be seen from the settings page.
      installed.attachStatus?.(installed.engine)
      service.longTerm = installed.engine
      // Kept separately: the engine is the memory store, and this is the record of
      // which optional registrations succeeded. Exposed through the status endpoint so
      // a missing feature can be traced to a step that never installed.
      service.memoryInstallStatus = installed.installStatus
      log('long-term memory engine ready')
    } catch (error) {
      log('long-term memory failed to install; continuing without it', error)
    }
  }

  // One automatic checkpoint per turn, taken when the turn finishes: a snapshot
  // then represents "the workspace after turn N", which is exactly the state a
  // rewind to turn N must restore.
  if (config.autoCheckpoint !== false) {
    ctx.effect(
      () =>
        ctx.on('session/event', (session, event) => {
          if (!event || (event.type !== 'turn/end' && event.type !== 'turn/start')) return
          // Subagent children are not conversations a user can open. Capturing
          // their workspace state produces snapshot directories nobody can
          // reach from the panel — the list already hides them — and costs a
          // full tree walk on every one of their turns.
          if (session?.header?.origin === 'subagent' || session?.origin === 'subagent') return
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
      // Snapshot directories of deleted sessions are never revisited by the
      // per-session prune, so they accumulate. Checked here rather than deleted:
      // reclaiming disk on a timer without a record of what went is not something to
      // do unattended, so this only reports and the settings page applies it. The
      // check runs a quarter as often as the sweep — it lists sessions, which is
      // more expensive than expiring a file.
      let tick = 0
      const timer = setInterval(() => {
        void service.sweep().catch(error => log('sweep failed', error))
        tick += 1
        if (tick % 4 !== 0) return
        void service
          .sweepOrphanCheckpoints(false)
          .then(result => {
            if (result?.orphans > 0) {
              log(`orphan snapshots: ${result.orphans} session(s), ${result.freed} reclaimable`)
            }
          })
          .catch(error => log('orphan snapshot check failed', error))
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
