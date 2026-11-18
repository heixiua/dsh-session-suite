/**
 * Layering for a memory: which TIER it lives in, and which TOPIC it belongs to.
 *
 * Why two axes
 * ------------
 * `scope` (global / workspace) answers WHERE a memory is filed. It does not
 * answer either of the two questions injection actually has to settle:
 *
 *   TIER  — should this be present on EVERY turn, regardless of the question?
 *           A "never commit a .bat with a BOM" lesson applies when nothing in
 *           the prompt mentions .bat. A "the video queue returns 503" note does
 *           not. Similarity ranking cannot tell those apart, because the second
 *           one is MORE lexically similar to most work.
 *
 *   TOPIC — which subject does this belong to, so that two unrelated questions
 *           in the same workspace stop competing for one budget?
 *
 * Tier is a small closed set and is inferred deterministically: it must never
 * depend on a model call, because a wrong tier either injects junk every turn
 * or hides a real lesson forever. Topic is open-vocabulary and is inferred from
 * the text, with a model-assisted pass available for clustering.
 */

/** Closed set. Order matters: `base` is the most privileged. */
export const TIERS = ['base', 'project', 'detail']

/**
 * Default tier for a new memory, from signals that are already stored.
 *
 * - `rule` and lesson-tagged entries are `base`: a rule exists precisely because
 *   it must hold without being asked for.
 * - a workspace-scoped fact is `project`: it describes how THIS project is built,
 *   so it is worth carrying while that project is open, and pointless elsewhere.
 * - everything else (global facts, episodes, summaries) is `detail`: retrievable
 *   when asked, never paid for by default. A global fact is machine-wide, but
 *   "npm publish must be verified with dist-tags" is still an answer to a
 *   specific question, not something to inject on every turn.
 *
 * Deliberately conservative: defaulting everything to `base` is how the injected
 * block grew to 1440 characters of things that were only sometimes relevant.
 *
 * @param {{kind?: string, tags?: string[], scope?: string, frozen?: boolean}} entry entry or draft
 * @param {{lessonTags?: Iterable<string>}} [options] lesson tag vocabulary
 * @returns {'base' | 'project' | 'detail'} tier
 */
export function inferTier(entry, options = {}) {
  const lessonTags = new Set(options.lessonTags ?? [])
  const kind = entry?.kind
  const tags = Array.isArray(entry?.tags) ? entry.tags : []

  // A rule IS a standing instruction. So is a lesson, whatever its kind.
  if (kind === 'rule') return 'base'
  if (tags.some(tag => lessonTags.has(tag))) return 'base'
  if (tags.includes('错误教训')) return 'base'

  // A pinned memory is the user saying "always". Nothing outranks that.
  if (entry?.frozen === true) return 'base'

  // A summary is a pointer to other entries, never a fact on its own.
  if (kind === 'summary') return 'detail'

  // A workspace-scoped fact describes this project. Global facts and episodes
  // stay in `detail`: they answer questions, they are not standing context.
  if (entry?.scope === 'workspace' && kind !== 'episode') return 'project'

  return 'detail'
}

/**
 * Topic vocabulary: subject nouns that survive being moved between workspaces.
 *
 * A candidate is only a TOPIC if it appears across more than one workspace —
 * otherwise it is a folder name. Two measured rejections are baked in:
 *
 *   `dsh`   covers 40% of the library. It is the NAME OF THE PRODUCT whose
 *           memories these are, so it appears in nearly every note without
 *           saying anything about the subject. Measured: 44 entries, the largest
 *           single "topic" — a bin, not a subject.
 *   `插件`  covers 31%, and its entries are about installs, publishing, host
 *           lifecycle and tool registration. A word that spans that much of the
 *           library cannot budget anything.
 *
 * Kept out of the seed list rather than filtered later, so no code path can
 * reintroduce them by accident.
 */
export const TOPIC_SEEDS = [
  '记忆', '模型', '会话', '快照', '回滚', '安装', '压缩', '检索', '召回',
  '缓存', '发布', '画布', '沙箱', '权限', '提示词', '调度', '网关', '凭据',
  'npm', 'git', 'windows', 'litellm',
]

/** Words that name the product or the act, never the subject. */
export const TOPIC_EXCLUDED = new Set(['dsh', '插件', '工具', '错误', '失败'])

/**
 * Last-resort topics, used only when no subject seed matched.
 *
 * Why this exists: excluding `插件` was right for BUDGETING (it covered 31% of
 * the library, so it could not allocate anything) but wrong for LABELLING. 35 of
 * 111 entries then had no topic at all, and most of them are genuine
 * plugin-development knowledge — `cordis_inspect`, slot registration, the
 * profile manifest. Leaving them unlabelled under-served exactly the subject that
 * dominates this library.
 *
 * The order matters: a specific seed always wins, so `快照恢复失败了` stays under
 * `快照`. These only catch an entry whose only identifiable subject is the broad
 * one. The result is a large-but-honest topic (`插件`), not a silent empty one.
 */
export const TOPIC_FALLBACKS = [
  ['插件', /(插件|plugin|bundle|apply\(|cordis|槽位|slot|profile|schemastery|typert)/i],
  ['工具', /(工具链|toolchain|build_|脚本)/i],
]

/** Words that are shape, not subject. Kept out of the topic key. */
const TOPIC_STOPWORDS = new Set([
  '用户', '问题', '错误', '失败', '原因', '结果', '结论', '情况', '时候', '过程',
  '方法', '方式', '内容', '东西', '地方', '部分', '规则', '教训', '事实', '方案',
])

/**
 * Infer a topic key from a memory's text.
 *
 * Preference order:
 *   1. an explicit `topic` on the entry (the user or the model said so);
 *   2. a seed word present in the text — deterministic and shared across
 *      workspaces, which is what makes topics mergeable;
 *   3. nothing. An empty topic is honest: the entry is retrievable by similarity
 *      but does not participate in topic budgeting until something assigns one.
 *
 * Step 3 matters. A catch-all `其他` bucket would recreate the problem this is
 * meant to fix: one bin holding everything, with a name that looks like a
 * subject.
 *
 * @param {string} text memory text
 * @param {{explicit?: string}} [options] an already-assigned topic wins
 * @returns {string} topic key, or '' when none can be justified
 */
export function inferTopic(text, options = {}) {
  const explicit = typeof options.explicit === 'string' ? options.explicit.trim() : ''
  if (explicit) return TOPIC_EXCLUDED.has(explicit.toLowerCase()) ? '' : explicit.toLowerCase()
  const value = String(text ?? '')
  if (!value.trim()) return ''

  // A seed word in the text is the strongest signal we have without a model
  // call, because the vocabulary was chosen from this library's own contents.
  let best = ''
  let bestCount = 0
  for (const seed of TOPIC_SEEDS) {
    const key = seed.toLowerCase()
    if (TOPIC_EXCLUDED.has(key)) continue
    const pattern = new RegExp(seed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
    const count = (value.match(pattern) ?? []).length
    if (count > bestCount) { best = key; bestCount = count }
  }
  if (best) return best

  // No specific subject. Fall back to the broad one rather than leaving the
  // entry unlabelled: these entries are real knowledge about a real subject, and
  // an empty topic means they never participate in topic budgeting at all.
  for (const [topic, pattern] of TOPIC_FALLBACKS) {
    if (pattern.test(value)) return topic
  }
  return ''
}

/**
 * Group entries by topic, and report what the grouping actually costs.
 *
 * The point of a report rather than a bare Map: a topic holding most of the
 * library is a bin, and the caller needs to see that as a number before it
 * spends the injection budget along the same lines.
 *
 * @param {readonly any[]} entries entries with `topic`
 * @returns {{topics: Map<string, any[]>, ungrouped: any[], largestShare: number}}
 */
export function groupByTopic(entries) {
  const topics = new Map()
  const ungrouped = []
  for (const entry of entries) {
    const topic = typeof entry?.topic === 'string' ? entry.topic : ''
    if (!topic) { ungrouped.push(entry); continue }
    const bucket = topics.get(topic) ?? []
    bucket.push(entry)
    topics.set(topic, bucket)
  }
  const total = entries.length || 1
  const largest = [...topics.values()].reduce((n, bucket) => Math.max(n, bucket.length), 0)
  return { topics, ungrouped, largestShare: largest / total }
}

/**
 * Filter entries that belong to the tier(s) an injection pass may spend on.
 *
 * @param {readonly any[]} entries entries with `tier`
 * @param {readonly string[]} tiers allowed tiers
 * @returns {any[]} entries in those tiers
 */
export function filterByTier(entries, tiers) {
  const allowed = new Set(tiers)
  return entries.filter(entry => allowed.has(entry?.tier ?? 'detail'))
}
