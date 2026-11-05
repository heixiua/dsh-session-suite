/**
 * Controlled vocabulary for memory tags.
 *
 * History: tags were whatever a caller passed, used verbatim. In practice that
 * produced a library where the same domain appeared under different spellings
 * (`dsh` and `DSH`), UI words leaked in as if they were domains (`快照`,
 * `删除` — those are features, not subjects), and near-duplicates fragmented the
 * list (`记忆` / `机制` / `项目经验`). The user's report was blunt: 标签打得有点乱.
 *
 * Two rules fix that without taking control away from the caller:
 *
 *   1. **Normalise before storing.** Case, surrounding space, full-width
 *      punctuation, and the half-dozen spellings a domain actually appears in
 *      all collapse to one canonical label.
 *   2. **Refuse what is not a subject.** A tag must name a domain of knowledge.
 *      Words that describe the plugin's own UI, or that are pure scaffolding,
 *      are dropped rather than stored, because a tag nobody can filter by is
 *      worse than no tag.
 *
 * The vocabulary is a suggestion list, not a jail: an unknown tag that looks
 * like a real subject is still accepted, after normalisation. Refusing all
 * novelty would make the feature useless for new domains, and the user has been
 * explicit that they want the system to decide, not to be asked.
 */

/**
 * Canonical labels, with the spellings that must fold into each.
 *
 * Keys are the stored form; values are recognised aliases. Chinese entries use
 * the form the user's own notes use.
 */
export const TAG_ALIASES = {
  错误教训: ['错误教训', '教训', '踩坑', '错误', 'bug', 'mistake', 'lesson'],
  技术方案: ['技术方案', '方案', '技术', '实现', 'design', 'technique'],
  迭代版本: ['迭代版本', '迭代', '版本', 'version', 'iteration'],
  偏差档案: ['偏差档案', '偏差', 'deviation'],
  调度: ['调度', 'scheduling', 'routing'],
  配置: ['配置', '设置', 'config', 'configuration', 'settings'],
  安全: ['安全', 'security', 'safety'],
  检索: ['检索', '搜索', 'search', 'retrieval'],
  记忆: ['记忆', 'memory'],
  模型: ['模型', 'model', 'provider'],
  工具: ['工具', 'tool', 'tools'],
  档案: ['档案', 'archive', 'profile'],
  事实: ['事实', 'fact', 'facts'],
  偏好: ['偏好', 'preference', 'preferences'],
  项目经验: ['项目经验', '经验', 'experience'],
  工作区: ['工作区', 'workspace'],
  dsh: ['dsh', 'DSH', 'DeepSeek Harness', '深寻'],
}

/**
 * Words that describe the plugin's own UI or are pure scaffolding. These were
 * observed as tags and are not subjects: a user cannot sensibly filter a memory
 * library by `全部标签`.
 */
export const TAG_STOPWORDS = new Set([
  '全部标签',
  '快照',
  '删除',
  '回滚',
  '重发',
  '编辑',
  '共装',
  '降链',
  '降级链',
  '插件',
  'all',
  'all tags',
  'snapshot',
  'delete',
  'rollback',
  'resend',
  'edit',
  'plugin',
  'tag',
  'tags',
])

/** @param {string} value raw tag @returns {string} comparable form */
function comparable(value) {
  return String(value ?? '')
    .replace(/[\u3000\s]+/g, ' ')
    .trim()
    .replace(/[，。、；：,.;:]+$/g, '')
    .toLowerCase()
}

/** alias lookup, built once */
const ALIAS_INDEX = (() => {
  const index = new Map()
  for (const [canonical, aliases] of Object.entries(TAG_ALIASES)) {
    for (const alias of aliases) index.set(comparable(alias), canonical)
  }
  return index
})()

/**
 * Canonicalise one tag.
 *
 * @param {unknown} raw caller-supplied tag
 * @returns {string | null} the canonical label, or null when it is not a subject
 */
export function normalizeTag(raw) {
  if (typeof raw !== 'string') return null
  const key = comparable(raw)
  if (!key) return null
  if (TAG_STOPWORDS.has(key)) return null
  const canonical = ALIAS_INDEX.get(key)
  if (canonical !== undefined) return canonical

  // Unknown but plausibly a subject: keep it, trimmed, with internal spacing
  // collapsed. Reject one-character noise and anything absurdly long, which are
  // the shapes auto-extraction produces when it splits a sentence badly.
  const trimmed = String(raw).replace(/\s+/g, ' ').trim()
  if (trimmed.length < 2 || trimmed.length > 24) return null
  if (!/[\p{L}\p{N}]/u.test(trimmed)) return null
  return trimmed
}

/**
 * Canonicalise a tag list, dropping duplicates and non-subjects.
 *
 * @param {unknown} raw caller-supplied tags
 * @returns {string[]} canonical tags, in first-seen order
 */
export function normalizeTags(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  const seen = new Set()
  for (const item of raw) {
    const tag = normalizeTag(item)
    if (tag === null) continue
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(tag)
  }
  return out
}
