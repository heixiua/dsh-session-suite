/**
 * A small Markdown subset parser shared by the HTML and image exports.
 *
 * The export pipeline must not depend on a markup library (a Host plugin cannot
 * import extra packages), and both renderers need the *same* structure: headings,
 * paragraphs, lists, quotes, fenced code, and inline emphasis. So the Host parses
 * once into blocks with inline runs, the HTML renderer emits markup, and the
 * browser draws the very same runs on a canvas.
 *
 * Supported: `#`–`######`, paragraphs, `-`/`*`/`+` and `1.` lists (indent = nesting),
 * `>` quotes, ``` fenced code, `---` rules, `**bold**`, `*italic*`, `` `code` ``,
 * `[text](url)`. Anything else stays literal text, which is the right failure mode
 * for a transcript.
 */

/**
 * Split one line of inline Markdown into styled runs.
 *
 * @param {string} text inline source
 * @returns {{ text: string, bold?: true, italic?: true, code?: true, href?: string }[]} runs
 */
export function inlineRuns(text) {
  const source = String(text ?? '')
  const pattern = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*\n]+\*|_[^_\n]+_|\[[^\]]+\]\([^)\s]+\))/g
  const runs = []
  let last = 0
  for (const match of source.matchAll(pattern)) {
    if (match.index > last) runs.push({ text: source.slice(last, match.index) })
    const token = match[0]
    if (token.startsWith('**') || token.startsWith('__')) runs.push({ text: token.slice(2, -2), bold: true })
    else if (token.startsWith('`')) runs.push({ text: token.slice(1, -1), code: true })
    else if (token.startsWith('[')) {
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token)
      if (link) runs.push({ text: link[1], href: link[2] })
      else runs.push({ text: token })
    } else runs.push({ text: token.slice(1, -1), italic: true })
    last = match.index + token.length
  }
  if (last < source.length) runs.push({ text: source.slice(last) })
  return runs.length > 0 ? runs : [{ text: '' }]
}

/**
 * Parse a Markdown document into blocks.
 *
 * @param {string} source markdown
 * @returns {any[]} blocks
 */
export function parseMarkdown(source) {
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n')
  const blocks = []
  let paragraph = []
  let index = 0

  const flush = () => {
    if (paragraph.length === 0) return
    blocks.push({ type: 'paragraph', runs: inlineRuns(paragraph.join('\n').trim()) })
    paragraph = []
  }

  while (index < lines.length) {
    const line = lines[index]

    if (/^\s*```/.test(line)) {
      flush()
      const lang = line.trim().slice(3).trim()
      const body = []
      index += 1
      while (index < lines.length && !/^\s*```/.test(lines[index])) {
        body.push(lines[index])
        index += 1
      }
      index += 1
      blocks.push({ type: 'code', lang, text: body.join('\n') })
      continue
    }

    if (/^\s*$/.test(line)) {
      flush()
      index += 1
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      flush()
      blocks.push({ type: 'heading', level: heading[1].length, runs: inlineRuns(heading[2].trim()) })
      index += 1
      continue
    }

    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flush()
      blocks.push({ type: 'hr' })
      index += 1
      continue
    }

    // Pipe table: a header row immediately followed by a separator row.
    const separator = /^\s*\|?[\s:|-]*-[\s:|-]*\|[\s:|-]*$/
    if (/^\s*\|.*\|\s*$/.test(line) && index + 1 < lines.length && separator.test(lines[index + 1]) && lines[index + 1].includes('-')) {
      flush()
      const cells = row => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim())
      const headers = cells(line).map(cell => inlineRuns(cell))
      index += 2
      const rows = []
      while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index])) {
        rows.push(cells(lines[index]).map(cell => inlineRuns(cell)))
        index += 1
      }
      blocks.push({ type: 'table', headers, rows })
      continue
    }

    if (/^\s*>/.test(line)) {
      flush()
      const quote = []
      while (index < lines.length && /^\s*>/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, ''))
        index += 1
      }
      blocks.push({ type: 'quote', lines: quote.map(entry => inlineRuns(entry.trim())).filter(runs => runs.some(run => run.text.trim())) })
      continue
    }

    const bullet = /^(\s*)([-*+])\s+(.*)$/.exec(line)
    const ordered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line)
    if (bullet || ordered) {
      flush()
      const isOrdered = Boolean(ordered)
      const items = []
      while (index < lines.length) {
        const nextBullet = /^(\s*)([-*+])\s+(.*)$/.exec(lines[index])
        const nextOrdered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(lines[index])
        const match = isOrdered ? nextOrdered : nextBullet
        if (match) {
          items.push({ indent: Math.floor(match[1].replace(/\t/g, '  ').length / 2), runs: inlineRuns(match[3].trim()) })
          index += 1
          continue
        }
        if (items.length > 0 && /^\s{2,}\S/.test(lines[index])) {
          const continuation = lines[index].trim()
          const lastItem = items[items.length - 1]
          lastItem.runs = inlineRuns(`${runsToText(lastItem.runs)} ${continuation}`)
          index += 1
          continue
        }
        break
      }
      blocks.push({ type: 'list', ordered: isOrdered, start: isOrdered ? Number(ordered[2]) : 1, items })
      continue
    }

    paragraph.push(line)
    index += 1
  }

  flush()
  return blocks
}

/** @param {readonly any[]} runs runs @returns {string} plain text */
export function runsToText(runs) {
  return (runs ?? []).map(run => run.text ?? '').join('')
}

/** @param {string} value raw @returns {string} HTML-safe */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
}

/**
 * @param {readonly any[]} runs runs
 * @returns {string} inline HTML
 */
export function runsToHtml(runs) {
  return (runs ?? [])
    .map(run => {
      let html = escapeHtml(run.text ?? '')
      if (run.code) html = `<code>${html}</code>`
      if (run.bold) html = `<strong>${html}</strong>`
      if (run.italic) html = `<em>${html}</em>`
      if (run.href) html = `<a href="${escapeHtml(run.href)}" rel="noreferrer noopener" target="_blank">${html}</a>`
      return html
    })
    .join('')
}

/**
 * @param {readonly any[]} blocks parsed blocks
 * @returns {string} block HTML
 */
export function blocksToHtml(blocks) {
  const out = []
  for (const block of blocks ?? []) {
    if (block.type === 'heading') {
      const level = Math.min(6, Math.max(1, block.level ?? 2) + 1)
      out.push(`<h${level}>${runsToHtml(block.runs)}</h${level}>`)
    } else if (block.type === 'paragraph') {
      out.push(`<p>${runsToHtml(block.runs).replace(/\n/g, '<br>')}</p>`)
    } else if (block.type === 'list') {
      const tag = block.ordered ? 'ol' : 'ul'
      const startAttr = block.ordered && block.start !== 1 ? ` start="${block.start}"` : ''
      const items = block.items
        .map(item => {
          const depth = Math.min(3, item.indent ?? 0)
          return `<li class="depth-${depth}">${runsToHtml(item.runs)}</li>`
        })
        .join('')
      out.push(`<${tag}${startAttr}>${items}</${tag}>`)
    } else if (block.type === 'quote') {
      out.push(`<blockquote>${(block.lines ?? []).map(runs => `<p>${runsToHtml(runs)}</p>`).join('')}</blockquote>`)
    } else if (block.type === 'table') {
      const head = (block.headers ?? []).map(runs => `<th>${runsToHtml(runs)}</th>`).join('')
      const body = (block.rows ?? [])
        .map(row => `<tr>${row.map(runs => `<td>${runsToHtml(runs)}</td>`).join('')}</tr>`)
        .join('')
      out.push(`<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`)
    } else if (block.type === 'code') {
      out.push(`<pre><code>${escapeHtml(block.text)}</code></pre>`)
    } else if (block.type === 'hr') {
      out.push('<hr>')
    }
  }
  return out.join('\n')
}

/**
 * Plain one-line preview of a Markdown string, for menu and picker rows.
 *
 * @param {string} text markdown
 * @param {number} [limit] character budget
 * @returns {string} preview
 */
export function previewText(text, limit = 120) {
  const plain = String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    // attachment placeholders are honest in an export but useless in a menu row
    .replace(/［?(?:图片|image|file)[^］\]]*］?/g, ' ')
    .replace(/［文件：[^］]*］/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/[*_`>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length > limit ? `${plain.slice(0, limit)}…` : plain
}
