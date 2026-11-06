/**
 * Host wiring for the long-term memory engine.
 *
 * Three responsibilities:
 *
 * 1. **Recall into the prompt** — a `systemPrompt.context()` contribution that
 *    injects only the memories relevant to the current question (never the whole
 *    library), workspace entries first.
 * 2. **Explicit writes** — the `【记住：…】` / `【新增全局记忆：…】` forms are parsed
 *    from the user's message before the step runs, so they never depend on the
 *    model deciding to call a tool.
 * 3. **Implicit extraction** — after a turn ends, one cheap model call proposes
 *    durable facts; they are queued as *pending suggestions* and only become
 *    memories when the user confirms them.
 *
 * Plus the `memory` tool and the HTTP surface the Client settings page uses.
 */

import { MemoryEngine } from './memory-engine.js'
import { normalizeTags } from './tags.js'
import { isMeaningfulText, isUserAuthored } from './util.js'

/**
 * The bracket forms that count as an explicit memory instruction.
 *
 * Exported (in the export block at the foot of this file) so that
 * `tools/audit-explicit-captures.mjs` can replay the *production* patterns
 * against real session logs instead of a copy that drifts from them.
 */
const EXPLICIT_PATTERNS = [
  { pattern: /【(?:新增)?全局记忆[:：]\s*(.*?)】/g, scope: 'global' },
  { pattern: /【(?:新增)?本工作区记忆[:：]\s*(.*?)】/g, scope: 'workspace' },
  { pattern: /【记住[:：]\s*(.*?)】/g, scope: 'workspace' },
  { pattern: /\[(?:新增)?全局记忆[:：]\s*(.*?)\]/g, scope: 'global' },
  { pattern: /\[记住[:：]\s*(.*?)\]/g, scope: 'workspace' },
]

/**
 * Pull the explicit memory instructions out of one step's messages.
 *
 * Exported so the policy can be tested without standing up a Host context. The
 * two guards here are the whole point: only user-authored messages count, and
 * only meaningful text is stored. Both exist because their absence produced 154
 * identical placeholder memories — the plugin read its own instruction footer
 * back out of a runtime-context message and obeyed itself.
 *
 * @param {readonly any[]} messages step messages
 * @returns {Array<{ scope: string, text: string }>} instructions, in order
 */
export function collectExplicitWrites(messages) {
  const out = []
  for (const message of messages ?? []) {
    if (!isUserAuthored(message)) continue
    const text = contentText(message.content)
    if (!text) continue
    const found = []
    for (const { pattern, scope } of EXPLICIT_PATTERNS) {
      pattern.lastIndex = 0
      for (const match of text.matchAll(pattern)) {
        const value = (match[1] ?? '').trim()
        if (!isMeaningfulText(value)) continue
        found.push({ scope, text: value, at: match.index ?? 0 })
      }
    }
    // Return instructions in the order they were written. Looping patterns on
    // the outside grouped them by which pattern matched, so a global
    // instruction written second came back first.
    found.sort((a, b) => a.at - b.at)
    for (const { scope, text: value } of found) out.push({ scope, text: value })
  }
  return out
}

/** Words that make a sentence a durable rule rather than a one-off task. */
const DURABLE_HINTS = /(以后|今后|之后|默认|一律|总是|永远|每次|始终|不要|必须|禁止|优先|习惯|偏好|规则|约定|记住|always|never|prefer|by default|from now on)/i
/** Words that make a sentence a one-off request, which must not be remembered. */
const TRANSIENT_HINTS = /(现在|这次|本次|帮我|马上|临时|今天|刚刚|试一下|测试|just now|this time|temporarily|for now)/i

/**
 * @param {object} options wiring options
 * @param {any} options.ctx plugin context
 * @param {string} options.root suite data directory
 * @param {any} options.config plugin config
 * @param {(message: string, error?: unknown) => void} options.log logger
 * @returns {{ engine: MemoryEngine, dispose: () => void }} engine and disposer
 */
export function installMemory({ ctx, root, config, log }) {
  const engine = new MemoryEngine({ root, log, config })

  /**
   * Run one optional registration; a failure is reported and skipped so a single
   * incompatible hook can never disable the rest of the bundle.
   *
   * Every step records its outcome. The silent-catch was the reason a broken step was
   * invisible: "the queue is empty" could mean the hook was never installed, and
   * nothing on screen said so. The steps list is published through status() so the
   * settings page can show which registrations succeeded.
   *
   * @param {string} label what is being installed
   * @param {() => void} install registration body
   */
  const steps = []
  const safe = (label, install) => {
    try {
      install()
      steps.push({ label, ok: true })
    } catch (error) {
      steps.push({ label, ok: false, error: error instanceof Error ? error.message : String(error) })
      log(`long-term memory: ${label} failed to install`, error)
    }
  }

  /**
   * Recall text per agent scope. `agent/pre-step` runs before the prompt is
   * assembled for that step and is the only place the current question is
   * visible, so it computes the recall here and the context provider below
   * reads it back by scope.
   */
  const recallByScope = new Map()
  let lastRecall = ''
  // Diagnostics for the settings page: "did the last rebuild fail, and why" must
  // be answerable, because the failure mode is invisible otherwise — the model
  // simply behaves as if the memory is missing.
  let lastRecallFailed = false
  let lastRecallError = ''

  /**
   * How long a computed recall may be reused before it must be recomputed.
   *
   * `agent/pre-step` normally refreshes it every step, so this only matters when
   * a step does not run the hook (a resumed session, a step served from a cached
   * decision). Without a bound, a memory written elsewhere could stay invisible
   * for the life of the process.
   */
  const RECALL_TTL_MS = 60_000

  // --- 1. Recall into the system prompt -----------------------------------
  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt?.context) {
    safe('prompt context', () =>
      ctx.effect(
        () =>
          systemPrompt.context({
            name: 'session-suite-memory',
            order: 900,
            // Memory text is PLAIN TEXT and must not be parsed as a prompt template.
            //
            // The Host's context/section helpers interpolate by default: a `{{name}}`
            // anywhere in the injected text is treated as a variable, and an unknown one
            // throws `unknown prompt variable`. Our memories come from user conversations,
            // so they routinely contain double braces — code snippets, templates, logs.
            // Without this flag ONE such memory would fail every turn of every session
            // until the plugin was disabled.
            //
            // Learned from dsh-fish-memory, which added the same flag after hitting it
            // (its source records the failure mode: "the user could only turn the plugin
            // off"). We are not copying its code, only the fact that the switch exists.
            interpolate: false,
            text: context => {
              const scoped = context?.scope ? recallByScope.get(context.scope) : undefined
              // Expiry is checked here rather than only at write time: a cached
              // value outlives its usefulness the moment the library changes
              // underneath it, and this is the only place that can see the age.
              if (scoped && Date.now() - scoped.at < RECALL_TTL_MS) return scoped.text
              // No fresh entry for this scope: fall back to the last text computed for
              // ANY scope. That is deliberate — the context provider can run for a scope
              // the pre-step hook did not resolve (a resumed session, a step served from
              // a cached decision), and returning '' there would inject nothing at all.
              return lastRecall || ''
            },
          }),
        'session-suite: memory context',
      ),
    )
  }

  // --- 2. Explicit writes, before the step runs ---------------------------
  safe('explicit writes', () =>
  ctx.effect(
    () =>
      ctx.on('agent/pre-step', async (payload, next) => {
        const decision = await next()
        try {
          const agent = payload.agent
          const cwd = resolveCwd(ctx, agent)
          const messages = decision?.messages ?? payload.messages ?? []

          // Explicit instructions are written before anything else, so the very
          // same step already sees them through recall.
          for (const instruction of collectExplicitWrites(messages)) {
            await engine.remember({
              scope: instruction.scope,
              cwd,
              text: instruction.text,
              tags: inferTags(instruction.text),
              affect: DURABLE_HINTS.test(instruction.text) ? 0.85 : 0.6,
              source: 'explicit',
              sessionId: agent?.sessionId,
            })
            log(`explicit memory stored (${instruction.scope})`)
          }

          // The question, plus enough of the conversation before it to resolve a
          // short follow-up. See contextualQuery: a bare 「那它为什么慢？」 has no
          // referent for 「它」 and cannot match the memory that answers it.
          const question = contextualQuery(messages, {
            chars: typeof config?.contextQueryChars === 'number' ? config.contextQueryChars : undefined,
            turns: typeof config?.contextQueryTurns === 'number' ? config.contextQueryTurns : undefined,
          })
          const text = await buildRecallText({ engine, cwd, question, config })
          // Cache key includes the QUESTION, not just the agent.
          //
          // `systemPrompt.context`'s text() is called several times per request (the
          // equivalent plugin measured 5.9 on average, up to 24 during long reasoning),
          // so caching is necessary. But caching by agent alone means a changed question
          // inside the same window reuses the previous answer — the injected memory then
          // describes a question the model is no longer asking. Keying on agent+question
          // keeps the reuse and drops the wrongness.
          if (agent) recallByScope.set(agent, { text, at: Date.now(), question })
          lastRecall = text
          lastRecallFailed = false

          // Implicit extraction is NOT run here. See the note at section 3: the model
          // writes memories by calling the `remember` tool mid-conversation, which is
          // the mechanism that actually works. A per-turn background model call was
          // never demonstrated to produce anything and cost a Host crash to attempt.
        } catch (error) {
          // A failed rebuild must not leave the previous answer in place.
          //
          // Observed in the wild: one failed rebuild, and every later turn kept
          // injecting the memory text computed BEFORE it — a memory written after
          // that point was invisible for the rest of the process, which reads as
          // "the other workspace does not know". Stale recall is worse than no
          // recall: empty at least tells the truth.
          lastRecall = ''
          if (agent) recallByScope.delete(agent)
          lastRecallFailed = true
          lastRecallError = error instanceof Error ? error.message : String(error)
          log('memory recall failed', error)
        }
        return decision
      }),
    'session-suite: memory recall and explicit writes',
  ),
  )

  // --- 2b. Per-agent extraction trigger: REMOVED (0.6.2) -----------------
  //
  // The 500ms agent-poll was the source of a Host crash: its timer callback
  // called `ctx.interval` / `ctx.get("timer")` on a context that had not
  // injected timer, producing `TypeError: cannot get property "timer" without
  // inject` on EVERY tick until the Host died. The WorkBuddy transcript showed
  // `at mount, _onTimeout, listOnTimeout` from our bundle.
  //
  // A recurring timer that can throw on every tick is not an acceptable design
  // for a plugin that runs inside a shared Host process. This whole trigger is
  // removed, and `agents`/`timer` are dropped from inject. Implicit extraction
  // stays off until a trigger can be proven safe. Do not re-add a polling loop
  // without (1) injecting timer, (2) wrapping the tick body in try/catch, and
  // (3) clearing the timer on dispose.
  // --- 3. Implicit extraction: REMOVED (0.8.0) -----------------------------
  //
  // Seven fix attempts targeted a "one cheap model call per turn" pipeline driven by
  // a Cordis event. It never fired once. Reading dsh-fish-memory's source settled why:
  // that plugin has no such pipeline at all. Its memories are written by the MODEL,
  // calling a `remember` tool mid-conversation; `agent/turn-stopping` there only marks
  // whether a recalled memory was actually used ("assembled" → "consumed").
  //
  // So the direction was wrong, not the wiring. A background timer that calls a model
  // on every turn also has a real cost and a real failure surface — the last attempt
  // crashed the Host — and the benefit was never demonstrated. It is removed rather
  // than left dormant, so no future reader mistakes it for working code.
  //
  // The memory TOOL remains (below), which is the mechanism that actually works.

  // --- 3b. Automatic maintenance -------------------------------------------
  // Scoring, decay, clustering, and cold archiving are otherwise only reachable
  // through the settings page, which means a memory library that nobody opens
  // never compresses. Run it on an interval instead, over the global store plus
  // whatever workspace the most recent turn used.
  //
  // The pass is skipped when nothing has changed since the previous one: an idle
  // Host should not wake up on a timer to rescore memory it has already scored.
  // Skipping is also the honest signal that the timer is alive, because a pass
  // that runs always writes its bookkeeping.
  const maintainEveryMs = numberOr(config.maintainIntervalMs, 30 * 60 * 1000)
  if (maintainEveryMs > 0) {
    safe('automatic maintenance', () =>
      ctx.effect(() => {
        let lastCwd
        let running = false
        const tick = async () => {
          if (running) return
          running = true
          try {
            const due = await engine.needsMaintenance(lastCwd)
            if (!due) return
            const report = await engine.maintain(lastCwd)
            log(
              `memory maintenance: scored ${report.scored}, archived ${report.archived}, ` +
                `compressed ${report.compressed}, clusters ${report.clusters}, rules ${report.rules}`,
            )
          } catch (error) {
            log('memory maintenance failed', error)
          } finally {
            running = false
          }
        }
        const timer = setInterval(tick, maintainEveryMs)
        timer.unref?.()
        // Remember which workspace to maintain as turns arrive.
        const off = ctx.on('session/event', (session, event) => {
          if (!event || event.type !== 'turn/end') return
          try {
            const cwd = resolveCwd(ctx, session)
            if (cwd) lastCwd = cwd
          } catch {
            // leave the previous workspace in place
          }
        })
        return () => {
          clearInterval(timer)
          off?.()
        }
      }),
    )
  }

  // --- 4. The memory tool -------------------------------------------------
  // `ToolDefinition` requires an `output` descriptor; without it `register`
  // throws and would take the whole bundle down, so it is provided here and the
  // registration itself stays inside a guard.
  const tools = ctx.get('tools')
  if (tools?.register) {
    ctx.effect(() => {
      try {
        return tools.register({
          name: 'memory',
          description:
            'Manage long-term memory. `remember` stores a durable fact or preference (scope: workspace by default, or global). `recall` searches memory. `list` shows scores and decay state. `forget` deletes one entry. Use it when the user states a lasting rule, preference, or convention.',
          parameters: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['remember', 'recall', 'list', 'forget', 'freeze'] },
              text: { type: 'string', description: 'the memory text (remember)' },
              scope: { type: 'string', enum: ['workspace', 'global'] },
              query: { type: 'string', description: 'what to look for (recall)' },
              id: { type: 'string', description: 'entry id (forget / freeze)' },
              frozen: { type: 'boolean', description: 'freeze state (freeze)' },
              tags: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'domain tags for remember, e.g. 错误教训 / 迭代版本 / 技术方案. Tags are canonicalised and filtered: spellings of the same domain fold together (DSH → dsh), and words that name UI rather than a subject (快照 / 删除) are dropped. Unknown subjects are kept, so a new domain is fine.',
              },
              factKey: {
                type: 'string',
                description:
                  'optional "subject.aspect" key for remember, e.g. 她.身高 or 约定.见面地点. Use it only for a fact whose value can change: entries sharing a key are treated as the same fact, so the newest one supersedes the older ones at recall time. NEVER put the value in the key (write 她.身高, not 她.身高170) — a key containing the value changes whenever the value does, so the two records never meet. Leave it out when unsure; an absent key is harmless, a wrong key can retire a good memory.',
              },
            },
            required: ['action'],
          },
          output: {
            schema: { type: 'object' },
            render: (_args, value) => [
              {
                type: 'text',
                text: typeof value === 'string' ? value : JSON.stringify(value, null, 2).slice(0, 4000),
              },
            ],
          },
          async execute(args, exec) {
            const cwd = resolveCwd(ctx, exec?.agent)
            if (args.action === 'remember') {
              if (typeof args.text !== 'string' || !args.text.trim()) throw new Error('text is required')
              const result = await engine.remember({
                scope: args.scope === 'global' ? 'global' : 'workspace',
                cwd,
                text: args.text,
                // Tags are normalised rather than trusted verbatim. The library
                // had `dsh` and `DSH` as separate domains and UI words like
                // `快照` filed as if they were subjects — see lib/tags.js.
                tags: Array.isArray(args.tags) && args.tags.length > 0
                  ? normalizeTags(args.tags)
                  : inferTags(args.text),
                factKey: typeof args.factKey === 'string' ? args.factKey : undefined,
                affect: DURABLE_HINTS.test(args.text) ? 0.85 : 0.6,
                source: 'tool',
              })
              return { stored: result.entry, duplicate: Boolean(result.duplicateOf) }
            }
            if (args.action === 'recall') {
              const items = await engine.recall({ cwd, query: args.query ?? '', limit: 8 })
              return { memories: items.map(brief) }
            }
            if (args.action === 'list') {
              const items = await engine.list({ cwd })
              return { memories: items.map(brief), pending: (await engine.pending(cwd)).map(brief) }
            }
            if (args.action === 'forget') {
              if (!args.id) throw new Error('id is required')
              return engine.remove({ id: args.id, cwd, scope: args.scope === 'global' ? 'global' : undefined })
            }
            if (args.action === 'freeze') {
              if (!args.id) throw new Error('id is required')
              return engine.update({ id: args.id, cwd, scope: args.scope === 'global' ? 'global' : undefined, patch: { frozen: args.frozen !== false } })
            }
            throw new Error(`unknown action: ${args.action}`)
          },
        })
      } catch (error) {
        log('memory tool registration failed; continuing without it', error)
        return () => {}
      }
    }, 'session-suite: memory tool')
  }

  return {
    engine,
    dispose: () => {},
    // The outcome of every optional registration, so "the queue is empty" can be
    // traced to a specific step that never installed.
    installStatus: () => [...steps],
    // Exposed so the settings page and the status endpoint can report whether the
    // last recall rebuild failed. Without this the failure is silent: the model
    // simply acts as if the memory is not there.
    recallStatus: () => ({
      failed: lastRecallFailed,
      error: lastRecallError,
      hasText: Boolean(lastRecall) || recallByScope.size > 0,
      scopes: recallByScope.size,
    }),
    // Why the last implicit extraction produced (or did not produce) candidates.
    // "The queue is empty" needs a cause, or the user cannot tell a working
    // feature from a broken one.
    extractionStatus: () => ({ ...extractionTrace }),
  }
}

/**
 * Compose the recall block injected into the prompt.
 *
 * @param {object} input recall input
 * @param {MemoryEngine} input.engine memory engine
 * @param {string} [input.cwd] workspace
 * @param {string} [input.question] the current question
 * @param {any} input.config plugin config
 * @returns {Promise<string>} prompt text (empty when nothing is relevant)
 */
async function buildRecallText({ engine, cwd, question, config }) {
  const limit = typeof config?.recallLimit === 'number' ? config.recallLimit : 6
  const residentLimit = typeof config?.residentLimit === 'number' ? config.residentLimit : 2

  // Query-matched memories first. `select` decides how many the evidence
  // actually justifies, and records the reason for every candidate it dropped so
  // the settings page can explain a recall instead of leaving it a mystery.
  const { items: matched } = await engine.select({ cwd, query: question ?? '', limit })
  // A secret never reaches a prompt. It is not context — it is a credential — and
  // injecting it would copy it into every provider request and every transcript.
  const usable = matched.filter(item => !item.archived && item.privacy !== 'secret')

  // The resident layer is an OVERVIEW, not more search results.
  //
  // It used to append the N highest-scoring entries as if they were relevant,
  // which produced two problems: the injected block mixed "matched your question"
  // with "just important in general" under one heading, and a user reading the
  // settings probe reasonably concluded that a memory which DID match had been
  // missed — it was sitting three lines below, unrelated to the query.
  //
  // Topic cards fix both: the block now says what the library knows in aggregate,
  // and the two halves are labelled so nobody has to guess which is which.
  let cards = []
  if (residentLimit > 0) {
    cards = await engine.residentCards({ cwd, limit: residentLimit }).catch(() => [])
  }

  if (usable.length === 0 && cards.length === 0) return ''

  const sections = ['## 长期记忆（跨会话）', '']
  if (usable.length > 0) {
    sections.push(
      '### 与本次提问相关',
      '',
      ...usable.map(item => `- ${item.scope === 'global' ? '[全局]' : '[本工作区]'} ${item.text}`),
      '',
    )
  }
  if (cards.length > 0) {
    sections.push(
      '### 库内概览（与本次提问无关，供你了解已积累的内容）',
      '',
      ...MemoryEngine.formatCards(cards),
      '',
    )
  }
  sections.push(
    '以上是稳定事实或约定，不是本轮对话内容；冲突时以用户当前的话为准。',
    '',
    '如果用户说【记住：…】或【新增全局记忆：…】，立即照做；如果这些记忆已经过时，用 memory 工具更正。',
  )
  return sections.join('\n')
}

/** @param {readonly any[]} messages step messages @returns {string} last user text */
function lastUserText(messages) {
  for (let index = (messages?.length ?? 0) - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'user') continue
    const text = contentText(message.content)
    if (text) return text
  }
  return ''
}

/**
 * The current question plus the tail of the conversation before it.
 *
 * Retrieval used to search for the last user message alone, so a follow-up like
 * 「那它为什么慢？」 searched for those seven characters and nothing else. "它" is a
 * pronoun with no referent in the query, so the memory that explains the slowness could
 * not be found no matter how well it was written. That is a real gap, not a tuning
 * problem.
 *
 * The shape here is deliberate:
 *
 *   • the current question comes LAST, so it dominates the lexical score (BM25 and the
 *     coverage route both reward a match in the query; putting context first would let
 *     an older turn outvote the thing being asked now);
 *   • only the previous USER turns are included, not assistant replies. Assistant text
 *     is verbose, and a long reply would drown the query in words the user never typed;
 *   • the tail is capped in characters rather than turns, because one long message and
 *     ten short ones should not cost the same;
 *   • nothing is included when the current question already stands alone (long enough
 *     and not pronoun-led), so an ordinary self-contained question is searched exactly
 *     as before.
 *
 * This is a heuristic, not a language model. It will not resolve 「那个东西」 back to a
 * noun three turns ago. It does fix the common case — a short follow-up — and it costs
 * nothing at query time.
 *
 * @param {readonly any[]} messages step messages
 * @param {{ chars?: number, turns?: number }} [limits] budget
 * @returns {string} query text
 */
function contextualQuery(messages, limits = {}) {
  const current = lastUserText(messages)
  if (!current) return ''

  // 0 is the default, and it means disabled.
  //
  // Why: the model already receives the conversation history, so it knows what a
  // pronoun refers to. Folding earlier turns into the retrieval query only improves
  // which MEMORY is picked — a real but small gain — and it costs a little accuracy
  // on self-contained questions that get padded unnecessarily. It matters for a
  // workflow that deliberately keeps the prompt small, where the history is not there
  // to be read; that is the case this exists for, and it is opt-in.
  const maxChars = typeof limits.chars === 'number' ? limits.chars : 0
  const maxTurns = typeof limits.turns === 'number' ? limits.turns : 3
  if (maxChars <= 0) return current

  // A self-contained question needs no help. The test is NOT length alone: a short
  // question that names its own subject ("导出的图片为什么断链") is self-contained,
  // while a long one made of pronouns ("那这个呢，还有刚才说的那个，它到底是怎么回事")
  // is not. Pronouns are the actual signal — they are what a query cannot resolve.
  //
  // An earlier version used `length >= 24`, which was a guess and misclassified a
  // perfectly clear 20-character question as needing context. Pronoun presence is a
  // narrower, more defensible rule: it fires exactly when the query contains a word
  // that refers to something outside itself.
  const PRONOUNS = /(它|他|她|这个|那个|这些|那些|该|此|上述|前面|刚才|上面|之前那个)/
  const looksSelfContained = !PRONOUNS.test(current)

  const earlier = []
  let budget = maxChars
  let seen = 0
  for (let index = (messages?.length ?? 0) - 1; index >= 0 && seen < maxTurns; index -= 1) {
    const message = messages[index]
    if (message?.role !== 'user') continue
    const text = contentText(message.content)
    if (!text) continue
    seen += 1
    // The newest user message IS `current`; skip it so it is not duplicated.
    if (text === current) continue
    if (budget <= 0) break
    const slice = text.length > budget ? text.slice(-budget) : text
    earlier.unshift(slice)
    budget -= slice.length
  }

  // Nothing to add, or the question stands on its own: search it as-is.
  if (earlier.length === 0 || looksSelfContained) return current

  // Context first, question last. The engine tokenises the whole string, and the
  // question's own terms are what must win.
  return `${earlier.join(' ')} ${current}`.trim()
}

/**
 * Read a session's events through whichever Host API is present.
 *
 * The Host moved from `sessionController.inspect(sessionId)` to
 * `sessionController.events({ address }, signal)`. Calling the old name behind an
 * optional chain returned `undefined` with no error, so every consumer silently saw an
 * empty session — share and segment-delete failed with a raw TypeError, and implicit
 * extraction reported "no completed turn yet" forever.
 *
 * Both shapes are attempted, newest first, and a missing implementation throws rather
 * than returning an empty list: an empty list is indistinguishable from an empty session,
 * which is exactly how this stayed hidden.
 *
 * @param {any} controller session controller
 * @param {string} sessionId session
 * @returns {Promise<any[]>} events
 */
async function readSessionEvents(controller, sessionId) {
  if (!controller) throw new Error('the sessionController service is not mounted')

  if (typeof controller.events === 'function') {
    // `events(request, signal)` — the implementation calls `signal.throwIfAborted()`,
    // so a real signal is required.
    const page = await controller.events({ address: { kind: 'session', sessionId } }, new AbortController().signal)
    const records = Array.isArray(page?.records) ? page.records : []
    return records
      .map(record => (record?.type === 'event' ? record.event : record?.event ?? record))
      .filter(Boolean)
  }

  if (typeof controller.inspect === 'function') {
    const inspection = await controller.inspect(sessionId)
    return Array.isArray(inspection?.events) ? inspection.events : []
  }

  throw new Error('this Host exposes neither sessionController.events nor sessionController.inspect')
}

/**
 * Ask a small model call what, if anything, is worth remembering from this turn.
 *
 * @param {object} input extraction input
 * @param {any} input.ctx plugin context
 * @param {MemoryEngine} input.engine memory engine
 * @param {string} input.sessionId session
 * @param {string} [input.cwd] workspace
 * @param {(message: string, error?: unknown) => void} input.log logger
 * @param {any} input.config plugin config
 */
/**
 * Why the last implicit-extraction attempt produced what it did.
 *
 * Kept as module state rather than only a log line because the plugin has no log
 * surface the user can reach: the settings page and the status endpoint read this
 * so "the queue is empty" comes with a cause.
 */
const extractionTrace = {
  sessionId: null,
  at: 0,
  ok: false,
  stage: 'idle',
  reason: '',
  candidates: [],
  produced: 0,
  queued: 0,
  rejected: 0,
}

/** @param {string} sessionId session being processed */
function resetExtractionTrace(sessionId) {
  // The counters survive a reset on purpose. They measure whether the hook is being
  // called at all, which is a property of the process, not of one extraction attempt:
  // clearing them here made every attempt look like the first one and erased the
  // evidence the diagnostic exists to collect.
  const eventsSeen = extractionTrace.eventsSeen ?? 0
  const turnEndsSeen = extractionTrace.turnEndsSeen ?? 0
  extractionTrace.sessionId = sessionId
  extractionTrace.at = Date.now()
  extractionTrace.ok = false
  extractionTrace.stage = 'start'
  extractionTrace.reason = ''
  extractionTrace.candidates = []
  extractionTrace.produced = 0
  extractionTrace.queued = 0
  extractionTrace.rejected = 0
  extractionTrace.eventsSeen = eventsSeen
  extractionTrace.turnEndsSeen = turnEndsSeen
}

/**
 * Record why extraction stopped before it could queue anything.
 *
 * @param {string} reason human-readable cause
 * @returns {undefined} always undefined, so callers can `return failExtraction(...)`
 */
function failExtraction(reason) {
  extractionTrace.ok = true
  extractionTrace.stage = 'stopped'
  extractionTrace.reason = reason
  return undefined
}

/**
 * Publish the trace to the engine so the settings page can read it.
 *
 * @param {any} engine memory engine
 */
function publishExtractionTrace(engine) {
  try {
    engine.lastExtraction = { ...extractionTrace }
  } catch {
    /* a diagnostic must never break extraction itself */
  }
}

async function extractAfterTurn({ ctx, engine, sessionId, cwd, log, config }) {
  // Every early return records why. An empty pending queue previously carried no
  // explanation at all: the user could see "nothing waiting" but not whether the
  // model found nothing, no model answered, or a filter dropped the result. That
  // is the difference between a feature that works and one that looks broken.
  resetExtractionTrace(sessionId)
  const settings = await engine.settings()
  if (settings.implicit === false) return failExtraction('implicit extraction is switched off in settings')
  const llm = ctx.get('llm')
  if (!llm?.stream) return failExtraction('the Host exposes no llm.stream')

  const sessionController = ctx.get('sessionController')
  // Read the session's events through whichever API this Host exposes.
  //
  // The optional-chained `inspect?.()` call silently produced `undefined` on the current
  // build — which has no `inspect` — so `events` was empty, `turn` was not a number, and
  // extraction returned "this session has no completed turn yet" forever. That is the
  // real reason the pending queue never filled, and it is the same defect that broke
  // share and segment-delete. The `?.` hid it: a missing method read as "nothing to do"
  // rather than as an error.
  const events = await readSessionEvents(sessionController, sessionId)
  const turn = lastCompletedTurn(events)
  if (typeof turn !== 'number') return failExtraction('this session has no completed turn yet')
  const transcript = turnTranscript(events, turn)
  if (!transcript) return failExtraction('the last turn produced no readable transcript')

  // The memory model is a fallback chain: a free provider that is rate limited
  // (429) or unreachable must not silently disable extraction for the session,
  // so every candidate is tried in order until one answers.
  const candidates = memoryCandidates(config, ctx, settings)
  if (candidates.length === 0) {
    return failExtraction(
      config?.implicitModel === 'current'
        ? 'the Host exposes no default model to fall back to'
        : 'implicit extraction has no model configured — choose one in Settings → 长期记忆 (隐式提取)',
    )
  }
  extractionTrace.candidates = candidates.map(candidate => `${candidate.provider}/${candidate.model}`)

  // The prompt asks for two different shapes, because the library stores two
  // different things: durable truths, and dated events with an outcome. Asking only
  // for the former is why episodic knowledge — "that approach failed last time" —
  // was never captured, even though it is the kind that prevents repeating a
  // mistake. The `kind` field lets the reply say which it means.
  const prompt =
    '下面是一轮对话。找出其中**值得长期记住**的信息，分两类：\n' +
    '1. durable：稳定偏好、固定技术约定、长期策略、用户固有习惯，跨会话仍然成立的事实。\n' +
    '2. episode：这一轮里实际**发生了什么**——尝试了什么、结果如何、踩了什么坑、为什么失败。带具体情境，不是泛泛结论。\n' +
    '单次闲聊、情绪流水账、没有依据的猜测都不要。\n' +
    '只输出 JSON：{"memories":[{"kind":"durable|episode","text":"...","scope":"workspace|global","affect":0.0-1.0,"tags":["..."],"context":"仅episode:当时在做什么","outcome":"仅episode:结果或教训"}]}\n' +
    '没有就输出 {"memories":[]}。\n\n' +
    `对话：\n${transcript}`

  let answer = ''
  let used
  for (const candidate of candidates) {
    answer = ''
    try {
      for await (const chunk of llm.stream({
        provider: candidate.provider,
        model: candidate.model,
        reasoningEffort: 'low',
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        maxTokens: 400,
        purpose: 'compaction',
      })) {
        if (chunk?.type === 'text-delta') answer += chunk.text
      }
      if (answer.trim()) {
        used = candidate
        break
      }
      log(`memory extraction returned nothing from ${candidate.provider}/${candidate.model}; trying the next model`)
    } catch (error) {
      log(`memory extraction failed on ${candidate.provider}/${candidate.model}: ${errorMessage(error)}`)
    }
  }
  if (!answer.trim()) {
    return failExtraction(
      `no memory model answered (tried ${candidates.length}: ${candidates
        .map(candidate => `${candidate.provider}/${candidate.model}`)
        .join(', ')})`,
    )
  }
  log(`memory extraction answered by ${used?.provider}/${used?.model}`)
  extractionTrace.used = `${used?.provider}/${used?.model}`

  const parsed = parseJsonBlock(answer)
  // Record what happened even when nothing survives, so "the queue is empty" has
  // a cause attached instead of being an unexplained absence.
  if (!parsed) {
    extractionTrace.parsed = false
    extractionTrace.reason = 'the model answered but the reply was not usable JSON'
    log(`memory extraction: no usable JSON in the reply`)
    return
  }
  const produced = Array.isArray(parsed.memories) ? parsed.memories : []
  extractionTrace.parsed = true
  extractionTrace.produced = produced.length
  if (produced.length === 0) {
    extractionTrace.reason = 'the model judged this turn to hold nothing durable'
    return
  }

  let queued = 0
  let rejected = 0
  for (const item of produced.slice(0, 4)) {
    const text = String(item.text ?? '').trim()
    // The extraction prompt already asked the model for long-lived information
    // only, so a second keyword gate here was acting as a filter on the model's
    // own paraphrase rather than on the user's words. Measured cost: 7 of 10
    // realistic candidates were dropped ("本项目使用 pnpm 管理依赖" carries none
    // of 以后/一律/总是), which made the pending queue look broken. Keep only the
    // checks that describe a malformed candidate, not a stylistic one.
    if (!text) {
      rejected += 1
      continue
    }
    if (!isMeaningfulText(text)) {
      rejected += 1
      continue
    }
    if (TRANSIENT_HINTS.test(text)) {
      rejected += 1
      continue
    }
    await engine.suggest({
      text,
      scope: item.scope === 'global' ? 'global' : 'workspace',
      cwd,
      // The prompt asks the model to label an event as an episode. Anything else —
      // including a reply from a model that ignored the new field — stays a fact,
      // so an older prompt shape cannot corrupt the library.
      kind: item.kind === 'episode' ? 'episode' : 'fact',
      ...(item.kind === 'episode'
        ? {
            context: typeof item.context === 'string' ? item.context : undefined,
            outcome: typeof item.outcome === 'string' ? item.outcome : undefined,
          }
        : {}),
      tags: Array.isArray(item.tags) ? item.tags : inferTags(text),
      affect: typeof item.affect === 'number' ? item.affect : 0.6,
      sessionId,
    })
    queued += 1
  }
  extractionTrace.queued = queued
  extractionTrace.rejected = rejected
  extractionTrace.reason =
    queued > 0 ? `queued ${queued} suggestion(s) for confirmation` : 'every candidate was rejected as unusable'
  log(`memory extraction: ${queued} queued, ${rejected} rejected`)
}

/** @param {string} text model output @returns {any | undefined} parsed JSON */
function parseJsonBlock(text) {
  const match = /\{[\s\S]*\}/.exec(String(text ?? ''))
  if (!match) return undefined
  try {
    return JSON.parse(match[0])
  } catch {
    return undefined
  }
}

/** @param {unknown} error @returns {string} readable message */
function errorMessage(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/**
 * Coerce a config value to a finite number.
 *
 * @param {unknown} value raw config value
 * @param {number} fallback used when the value is absent or not a number
 * @returns {number} the number
 */
function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * The ordered model fallback chain for implicit extraction.
 *
 * `memoryModel` may be a single `{ provider, model }` or an array of them; a
 * `memoryModels` array is also accepted so the profile can list the whole chain
 * without nesting. Entries missing a provider or model are dropped.
 *
 * @param {any} config plugin config
 * @returns {{ provider: string, model: string }[]} candidates in priority order
 */
function memoryCandidates(config, ctx, settings) {
  const raw = []
  const push = value => {
    if (Array.isArray(value)) raw.push(...value)
    else if (value) raw.push(value)
  }
  push(config?.memoryModels)
  push(config?.memoryModel)
  // A single explicit pick, stored by the settings UI as "provider/model".
  //
  // This is the "one model, chosen here" case: the user picked a specific entry from
  // the offered chain, and that pick must beat the chain (which is a fallback list,
  // not a preference). Parsed on the last slash so a model id that itself contains a
  // slash — "Qwen/Qwen2.5-7B-Instruct" — survives intact.
  //
  // Read from SETTINGS first: the UI persists the choice to memory/settings.json, and
  // reading only `config` meant a chosen model was never seen — the picker worked, the
  // file had the value, and extraction still never ran.
  const picked =
    typeof settings?.implicitModel === 'string'
      ? settings.implicitModel
      : typeof config?.implicitModel === 'string'
        ? config.implicitModel
        : ''
  if (picked && picked !== 'current' && picked !== 'off') {
    const at = picked.indexOf('/')
    if (at > 0 && at < picked.length - 1) {
      raw.unshift({ provider: picked.slice(0, at), model: picked.slice(at + 1) })
    }
  }
  // Falling back to the Host's own default model is OFF unless the user asks for it.
  //
  // An earlier version did this unconditionally, to fix "extraction never runs when
  // no chain is configured". That traded one bug for a worse one: it spends the
  // user's tokens on a model they never chose for this purpose, once per turn,
  // silently. Background spending has to be opted into — so the fallback requires
  // `implicitModel: 'current'` and otherwise returns nothing, leaving extraction off
  // with a reason the user can read.
  if (raw.length === 0 && ctx && picked === 'current') {
    try {
      const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
      if (selection?.provider && selection?.model) {
        raw.push({ provider: selection.provider, model: selection.model })
      }
    } catch {
      /* a Host without the service just means no fallback */
    }
  }
  const out = []
  const seen = new Set()
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const provider = entry.provider
    const model = entry.model
    if (typeof provider !== 'string' || !provider) continue
    if (typeof model !== 'string' || !model) continue
    const key = `${provider}/${model}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ provider, model })
  }
  return out
}

/** @param {string} text memory text @returns {string[]} tags */
function inferTags(text) {
  const value = String(text ?? '')
  const tags = []
  if (/(trae|workbuddy|open code|opencode)/i.test(value)) tags.push('调度')
  if (/(插件|plugin|bundle|dsh)/i.test(value)) tags.push('dsh')
  if (/(模型|model|积分|额度|credit)/i.test(value)) tags.push('模型')
  if (/(文件|目录|路径|workspace|工作区)/i.test(value)) tags.push('工作区')
  if (/(习惯|偏好|喜欢|prefer)/i.test(value)) tags.push('偏好')
  return tags
}

/** @param {readonly any[]} events log @param {number} turn target @returns {string} transcript */
function turnTranscript(events, turn) {
  const lines = []
  for (const event of events) {
    if (typeof event?.data?.turn !== 'number' || event.data.turn !== turn) continue
    if (event.type === 'user/message') {
      const kind = event.data?.source?.kind
      if (kind !== undefined && kind !== 'user') continue
      const text = contentText(event.data.content)
      if (text) lines.push(`用户：${text}`)
    } else if (event.type === 'assistant/message') {
      const text = contentText(event.data?.message?.content)
      if (text) lines.push(`助手：${text}`)
    }
  }
  const joined = lines.join('\n')
  return joined.length > 4000 ? joined.slice(-4000) : joined
}

/** @param {readonly any[]} events log @returns {number | undefined} turn */
function lastCompletedTurn(events) {
  let turn
  for (const event of events) if (event?.type === 'turn/end' && typeof event.data?.turn === 'number') turn = event.data.turn
  return turn
}

/** @param {any} content message content @returns {string} text */
function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .trim()
}

/** @param {any} entry memory entry @returns {any} compact view */
function brief(entry) {
  return {
    id: entry.id,
    text: entry.text,
    scope: entry.scope,
    kind: entry.kind,
    score: entry.score,
    state: entry.state ?? (entry.archived ? 'archived' : 'active'),
    frozen: entry.frozen === true,
    tags: entry.tags ?? [],
  }
}

/**
 * Resolve the workspace directory an agent or session belongs to.
 *
 * The cwd is needed to pick the per-workspace memory store, so a miss here
 * silently downgrades every workspace memory to the global one. There is no
 * `workingDirectory` service in this harness; the authoritative source is the
 * session header (`header.cwd`), which the session service validates as an
 * absolute path. An agent reaches it through its own `session`, and an agent
 * that exposes the header directly is handled too.
 *
 * @param {any} ctx plugin context
 * @param {any} owner agent or session
 * @returns {string | undefined} absolute cwd, when one is known
 */
function resolveCwd(ctx, owner) {
  if (!owner) return undefined

  // A session, or anything carrying the immutable header.
  const direct = owner.header ?? owner.meta
  if (typeof direct?.cwd === 'string' && direct.cwd.length > 0) return direct.cwd

  // An agent: prefer its own session, then the session store by id.
  const session = owner.session ?? owner.agent?.session
  const header = session?.header
  if (typeof header?.cwd === 'string' && header.cwd.length > 0) return header.cwd

  const sessionId = owner.sessionId ?? session?.id
  if (typeof sessionId === 'string') {
    try {
      const sessions = ctx.get('sessions')
      const found = sessions?.get?.(sessionId)
      const foundHeader = found?.header
      if (typeof foundHeader?.cwd === 'string' && foundHeader.cwd.length > 0) return foundHeader.cwd
    } catch {
      // no session service, or the lookup failed; report "unknown" instead of guessing
    }
  }
  return undefined
}

export { EXPLICIT_PATTERNS, inferTags, resolveCwd }
