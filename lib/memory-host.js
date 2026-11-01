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

const EXPLICIT_PATTERNS = [
  { pattern: /【(?:新增)?全局记忆[:：]\s*(.*?)】/g, scope: 'global' },
  { pattern: /【(?:新增)?本工作区记忆[:：]\s*(.*?)】/g, scope: 'workspace' },
  { pattern: /【记住[:：]\s*(.*?)】/g, scope: 'workspace' },
  { pattern: /\[(?:新增)?全局记忆[:：]\s*(.*?)\]/g, scope: 'global' },
  { pattern: /\[记住[:：]\s*(.*?)\]/g, scope: 'workspace' },
]

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
   * Recall text per agent scope. `agent/pre-step` runs before the prompt is
   * assembled for that step and is the only place the current question is
   * visible, so it computes the recall here and the context provider below
   * reads it back by scope.
   */
  const recallByScope = new Map()
  let lastRecall = ''

  // --- 1. Recall into the system prompt -----------------------------------
  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt?.context) {
    ctx.effect(
      () =>
        systemPrompt.context({
          name: 'session-suite-memory',
          order: 900,
          text: context => {
            const scoped = context?.scope ? recallByScope.get(context.scope) : undefined
            return scoped?.text || lastRecall || ''
          },
        }),
      'session-suite: memory context',
    )
  }

  // --- 2. Explicit writes, before the step runs ---------------------------
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
          for (const message of messages) {
            if (message?.role !== 'user') continue
            const text = contentText(message.content)
            if (!text) continue
            for (const { pattern, scope } of EXPLICIT_PATTERNS) {
              pattern.lastIndex = 0
              for (const match of text.matchAll(pattern)) {
                const value = (match[1] ?? '').trim()
                if (!value) continue
                await engine.remember({
                  scope,
                  cwd,
                  text: value,
                  tags: inferTags(value),
                  affect: DURABLE_HINTS.test(value) ? 0.85 : 0.6,
                  source: 'explicit',
                  sessionId: agent?.sessionId,
                })
                log(`explicit memory stored (${scope})`)
              }
            }
          }

          const question = lastUserText(messages)
          const text = await buildRecallText({ engine, cwd, question, config })
          if (agent) recallByScope.set(agent, { text, at: Date.now() })
          lastRecall = text
        } catch (error) {
          log('memory recall failed', error)
        }
        return decision
      }),
    'session-suite: memory recall and explicit writes',
  )

  // --- 3. Implicit extraction after a turn --------------------------------
  ctx.effect(
    () =>
      ctx.on('session/event', (session, event) => {
        if (!event || event.type !== 'turn/end') return
        const sessionId = session?.id
        if (typeof sessionId !== 'string') return
        const cwd = resolveCwd(ctx, session)
        void extractAfterTurn({ ctx, engine, sessionId, cwd, log, config }).catch(error =>
          log('implicit memory extraction failed', error),
        )
      }),
    'session-suite: implicit memory',
  )

  // --- 4. The memory tool -------------------------------------------------
  const tools = ctx.get('tools')
  if (tools?.register) {
    ctx.effect(
      () =>
        tools.register({
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
            },
            required: ['action'],
          },
          async execute(args, exec) {
            const cwd = resolveCwd(ctx, exec?.agent)
            if (args.action === 'remember') {
              if (typeof args.text !== 'string' || !args.text.trim()) throw new Error('text is required')
              const result = await engine.remember({
                scope: args.scope === 'global' ? 'global' : 'workspace',
                cwd,
                text: args.text,
                tags: inferTags(args.text),
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
        }),
      'session-suite: memory tool',
    )
  }

  return { engine, dispose: () => {} }
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
  const items = await engine.recall({ cwd, query: question ?? '', limit })
  const usable = items.filter(item => !item.archived && (item.rank > 0 || items.length <= 3))
  if (usable.length === 0) return ''
  const lines = usable.map(item => `- ${item.scope === 'global' ? '[全局]' : '[本工作区]'} ${item.text}`)
  return [
    '## 长期记忆（跨会话）',
    '',
    '以下条目来自长期记忆库，与本轮问题相关。它们是稳定事实或约定，不是本轮对话内容；冲突时以用户当前的话为准。',
    '',
    ...lines,
    '',
    '如果用户说【记住：…】或【新增全局记忆：…】，立即照做；如果这些记忆已经过时，用 memory 工具更正。',
  ].join('\n')
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
async function extractAfterTurn({ ctx, engine, sessionId, cwd, log, config }) {
  const settings = await engine.settings()
  if (settings.implicit === false) return
  const llm = ctx.get('llm')
  if (!llm?.stream) return

  const sessionController = ctx.get('sessionController')
  const inspection = await sessionController?.inspect?.(sessionId).catch(() => undefined)
  const events = inspection?.events ?? []
  const turn = lastCompletedTurn(events)
  if (typeof turn !== 'number') return
  const transcript = turnTranscript(events, turn)
  if (!transcript) return

  const model = config.memoryModel
  if (!model?.provider || !model?.model) return

  let answer = ''
  try {
    for await (const chunk of llm.stream({
      provider: model.provider,
      model: model.model,
      reasoningEffort: 'low',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `下面是一轮对话。找出其中**长期有效**的信息：稳定偏好、固定技术约定、长期策略、用户固有习惯。\n单次任务、一次性查询、临时调试、闲聊都不要。\n只输出 JSON：{"memories":[{"text":"...","scope":"workspace|global","affect":0.0-1.0,"tags":["..."]}]}\n没有就输出 {"memories":[]}。\n\n对话：\n${transcript}`,
            },
          ],
        },
      ],
      maxTokens: 400,
      purpose: 'compaction',
    })) {
      if (chunk?.type === 'text-delta') answer += chunk.text
    }
  } catch (error) {
    log('memory extraction call failed', error)
    return
  }

  const parsed = parseJsonBlock(answer)
  if (!parsed?.memories?.length) return
  for (const item of parsed.memories.slice(0, 4)) {
    const text = String(item.text ?? '').trim()
    if (!text || !DURABLE_HINTS.test(text)) continue
    if (TRANSIENT_HINTS.test(text)) continue
    await engine.suggest({
      text,
      scope: item.scope === 'global' ? 'global' : 'workspace',
      cwd,
      tags: Array.isArray(item.tags) ? item.tags : inferTags(text),
      affect: typeof item.affect === 'number' ? item.affect : 0.6,
      sessionId,
    })
  }
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

/** @param {any} ctx plugin context @param {any} owner agent or session @returns {string | undefined} cwd */
function resolveCwd(ctx, owner) {
  const workingDirectory = ctx.get('workingDirectory')
  if (workingDirectory?.get) {
    try {
      const value = workingDirectory.get(owner)
      if (typeof value === 'string' && value.length > 0) return value
    } catch {
      // fall through to the session header
    }
  }
  const meta = owner?.meta ?? owner?.header
  return typeof meta?.cwd === 'string' ? meta.cwd : undefined
}

export { EXPLICIT_PATTERNS, inferTags }
