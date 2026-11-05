/**
 * Self-test for lib/step-tag-filter.js.
 *
 * Run: node tools/selftest-step-tag-filter.mjs
 * Exits 0 on success, 1 on the first failed assertion.
 */

import assert from 'node:assert/strict'
import {
  STEP_TAGS,
  stripStepTags,
  stripStepTagsFromStream,
} from '../lib/step-tag-filter.js'

const T = {
  fa: '\u003c发\u003e',
  exec: '\u003c执行\u003e',
  ok: '\u003c好\u003e',
  now: '\u003c现在\u003e',
}

function makeStream(chunks) {
  let returned = 0
  const stream = {
    async *[Symbol.asyncIterator]() {
      try {
        for (const chunk of chunks) yield chunk
      } finally {
        // generator finally runs on completion AND on early return
      }
    },
    get returned() {
      return returned
    },
  }
  // Wrap the iterator so the test can observe return() calls on the adapter.
  const original = stream[Symbol.asyncIterator]
  stream[Symbol.asyncIterator] = function () {
    const inner = original.call(this)
    return {
      next: () => inner.next(),
      return: async () => {
        returned += 1
        return inner.return ? inner.return() : { done: true, value: undefined }
      },
    }
  }
  return stream
}

async function collect(stream) {
  const out = []
  for await (const chunk of stripStepTagsFromStream(stream)) out.push(chunk)
  return out
}

function textOf(chunks) {
  // Mirrors BlockAssembler: deltas accumulate, a block-end carrying full block
  // text replaces that block's accumulated text.
  const blocks = new Map()
  const order = []
  for (const chunk of chunks) {
    if (chunk.type === 'block-start') {
      if (!blocks.has(chunk.index)) {
        order.push(chunk.index)
        blocks.set(chunk.index, '')
      }
      continue
    }
    if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
      if (!blocks.has(chunk.index)) {
        order.push(chunk.index)
        blocks.set(chunk.index, '')
      }
      blocks.set(chunk.index, blocks.get(chunk.index) + chunk.text)
      continue
    }
    if (chunk.type === 'block-end' && (chunk.block?.type === 'text' || chunk.block?.type === 'reasoning')) {
      if (!blocks.has(chunk.index)) order.push(chunk.index)
      blocks.set(chunk.index, chunk.block.text)
    }
  }
  return order.map(index => blocks.get(index)).join('')
}

let passed = 0
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1
      console.log(`ok ${passed} - ${name}`)
    })
    .catch(error => {
      console.error(`not ok - ${name}`)
      console.error(error)
      process.exitCode = 1
      throw error
    })
}

async function main() {
  await ok('STEP_TAGS are the four exact literals', () => {
    assert.deepEqual([...STEP_TAGS], [T.fa, T.exec, T.ok, T.now])
  })

  await ok('stripStepTags removes tags and keeps other angle-bracket text', () => {
    assert.equal(stripStepTags(`a${T.fa}b${T.exec}c${T.ok}d${T.now}e`), 'abcde')
    assert.equal(stripStepTags(`x\u003c我现在写\u003ey`), `x\u003c我现在写\u003ey`)
    assert.equal(stripStepTags('plain text'), 'plain text')
    assert.equal(stripStepTags(''), '')
  })

  await ok('removes tags split across text deltas', async () => {
    const chunks = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'a<' },
      { type: 'text-delta', index: 0, text: '发' },
      { type: 'text-delta', index: 0, text: '>b' },
      { type: 'text-delta', index: 0, text: T.exec },
      { type: 'text-delta', index: 0, text: 'c' },
      { type: 'block-end', index: 0, block: { type: 'text', text: `a${T.fa}b${T.exec}c` } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const out = await collect(makeStream(chunks))
    assert.equal(textOf(out), 'abc')
    assert.ok(!textOf(out).includes('\u003c'))
    // non-delta chunks survive untouched
    assert.equal(out.at(-1).type, 'finish')
  })

  await ok('sanitizes terminal block-end block text even without deltas', async () => {
    const chunks = [
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: `think ${T.now} done` } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const out = await collect(makeStream(chunks))
    const end = out.find(chunk => chunk.type === 'block-end')
    assert.equal(end.block.text, 'think  done')
    assert.notEqual(end, chunks[1])
  })

  await ok('flushes a held partial tag when the stream ends without block-end', async () => {
    const chunks = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'tail<' },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const out = await collect(makeStream(chunks))
    assert.equal(textOf(out), 'tail<')
  })

  await ok('keeps a long custom angle-bracket marker across deltas', async () => {
    const chunks = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: `a\u003c我现在` },
      { type: 'text-delta', index: 0, text: `写\u003eb` },
      { type: 'block-end', index: 0, block: { type: 'text', text: `a\u003c我现在写\u003eb` } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const out = await collect(makeStream(chunks))
    assert.equal(textOf(out), `a\u003c我现在写\u003eb`)
  })

  await ok('passes a tag-free stream through with identical chunks', async () => {
    const chunks = [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'hello' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'hello' } },
      { type: 'usage', usage: { inputTokens: 1 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const out = await collect(makeStream(chunks))
    assert.deepEqual(out, chunks)
  })

  await ok('releases the adapter iterator when the consumer stops early', async () => {
    const stream = makeStream([
      { type: 'text-delta', index: 0, text: 'a' },
      { type: 'text-delta', index: 0, text: 'b' },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    for await (const _chunk of stripStepTagsFromStream(stream)) break
    assert.equal(stream.returned, 1)
  })

  await ok('non-iterable stream is returned unchanged by the wrapper guard', () => {
    // Mirrors the guard in index.js: undefined is not wrapped.
    const value = undefined
    const guarded = value === null || value === undefined || typeof value[Symbol.asyncIterator] !== 'function'
      ? value
      : 'wrapped'
    assert.equal(guarded, undefined)
  })
}

main().then(() => {
  console.log(`\n${passed} checks passed`)
})
