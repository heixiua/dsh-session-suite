/**
 * Privacy levels: not everything true should be equally visible.
 *
 * The library had a scope (global / workspace) but no notion of who may read an
 * entry. That is a real gap: a password filed under `workspace` was still injected
 * into every prompt in that workspace and still written into every share export.
 *
 * What this pins:
 *   1. credentials and ids are detected and filed as `secret`;
 *   2. personal-but-not-credential topics are at least `internal`;
 *   3. the default is `internal`, never `public`;
 *   4. `secret` is never injected (not in the matched half, not in a card);
 *   5. an export carries only `public` entries and reports how many it withheld;
 *   6. an explicit level wins over the heuristic.
 *
 * Usage: node tools/selftest-memory-privacy.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  MemoryEngine,
  PRIVACY_LEVELS,
  inferPrivacy,
  isExportable,
  isInjectable,
} from '../lib/memory-engine.js'

const checks = []

/** @returns {Promise<string>} throwaway root */
async function freshRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'privacy-'))
}

// 1. Credentials and identifiers are detected.
{
  const secrets = [
    '密码：hunter2',
    'password = abcdef123',
    'token: sk-abcdefghijklmnopqrstuvwx',
    '我的手机号 13812345678',
    '邮箱 heixiu_lin@163.com',
    '身份证 440301199001011234',
    '银行卡 6222021234567890123',
    '私钥放在这个文件里',
  ]
  for (const text of secrets) {
    assert.equal(inferPrivacy(text), 'secret', `must classify as secret: ${text}`)
  }
  checks.push('credentials and identifiers are classified as secret')
}

// 2. Personal topics that are not credentials stay internal.
{
  const personal = ['这个月工资到手 8k', '存款还有 2.5 万', '房租 1300']
  for (const text of personal) {
    assert.equal(inferPrivacy(text), 'internal', `must stay internal: ${text}`)
  }
  checks.push('personal-but-not-credential topics stay internal')
}

// 3. The default is internal. This is the property that matters most: guessing wrong
//    toward privacy costs convenience, guessing wrong the other way leaks.
{
  assert.equal(inferPrivacy('项目使用 pnpm 管理依赖'), 'internal')
  assert.equal(inferPrivacy(''), 'internal')
  assert.equal(inferPrivacy(null), 'internal')
  assert.equal(inferPrivacy(undefined), 'internal')
  // An unrecognised explicit level must not be trusted into a weaker one.
  assert.equal(inferPrivacy('随便一句话', 'nonsense'), 'internal')
  checks.push('the default level is internal, never public')
}

// 4. An explicit level wins over the heuristic, in both directions.
{
  assert.equal(inferPrivacy('密码：hunter2', 'public'), 'public', 'an explicit level must be honoured')
  assert.equal(inferPrivacy('普通事实', 'secret'), 'secret')
  assert.deepEqual(PRIVACY_LEVELS, ['public', 'internal', 'secret'])
  checks.push('an explicit level wins over the heuristic')
}

// 5. Injectable and exportable are different questions.
{
  assert.equal(isInjectable({ privacy: 'secret' }), false, 'a secret must never be injected')
  assert.equal(isInjectable({ privacy: 'internal' }), true)
  assert.equal(isInjectable({ privacy: 'public' }), true)
  assert.equal(isInjectable({}), true, 'a legacy entry with no level is injectable')

  assert.equal(isExportable({ privacy: 'public' }), true)
  assert.equal(isExportable({ privacy: 'internal' }), false, 'internal must not leave the machine')
  assert.equal(isExportable({ privacy: 'secret' }), false)
  assert.equal(isExportable({}), false, 'a legacy entry with no level must not be exported')
  checks.push('injection and export are separate questions')
}

// 6. Storing and reading back preserves the level, and a secret never reaches the
//    matched half of the injection.
{
  const root = await freshRoot()
  const engine = new MemoryEngine({ root, config: {} })
  const cwd = 'D:\\ws-privacy'
  await engine.remember({ scope: 'workspace', cwd, text: '密码：hunter2', tags: ['账号'] })
  await engine.remember({ scope: 'workspace', cwd, text: '项目使用 pnpm 管理依赖', tags: ['工具'] })

  const listed = await engine.list({ cwd })
  const secret = listed.find(entry => entry.text.includes('hunter2'))
  assert.equal(secret?.privacy, 'secret', 'the level must survive a round trip')

  const selection = await engine.select({ cwd, query: '密码 hunter2', limit: 6, touch: false })
  for (const item of selection.items) {
    assert.equal(
      item.text.includes('hunter2'),
      false,
      'a secret must not appear in the recall selection',
    )
  }
  checks.push('a secret never reaches the recall selection')
  await fs.rm(root, { recursive: true, force: true })
}

// 7. A secret is excluded from resident cards too — a card summary is injected text,
//    so listing one there would leak it just as surely.
{
  const root = await freshRoot()
  const engine = new MemoryEngine({ root, config: {} })
  const cwd = 'D:\\ws-privacy-7'
  await engine.remember({ scope: 'workspace', cwd, text: '密码：hunter2', tags: ['账号'] })
  const cards = await engine.residentCards({ cwd })
  for (const card of cards) {
    assert.equal(card.summary.includes('hunter2'), false, 'a secret must not appear in a card')
  }
  checks.push('a secret is excluded from resident cards')
  await fs.rm(root, { recursive: true, force: true })
}

// 8. An export carries only public entries and reports what it withheld.
{
  const root = await freshRoot()
  const engine = new MemoryEngine({ root, config: {} })
  const cwd = 'D:\\ws-privacy-8'
  await engine.remember({ scope: 'workspace', cwd, text: '可公开的结论', tags: ['公开'], privacy: 'public' })
  await engine.remember({ scope: 'workspace', cwd, text: '内部结论', tags: ['内部'] })
  await engine.remember({ scope: 'workspace', cwd, text: '密码：hunter2', tags: ['账号'] })

  const dumped = await engine.export({ cwd })
  const json = JSON.stringify(dumped)
  assert.equal(json.includes('可公开的结论'), true, 'a public entry must be exported')
  assert.equal(json.includes('内部结论'), false, 'an internal entry must not be exported')
  assert.equal(json.includes('hunter2'), false, 'a secret must not be exported')
  assert.equal(dumped.excluded >= 2, true, `withheld count must be reported, got ${dumped.excluded}`)
  checks.push('an export carries only public entries and reports the withheld count')
  await fs.rm(root, { recursive: true, force: true })
}

// 9. The injection path applies the filter itself, not just the engine.
{
  const hostSource = await fs.readFile('lib/memory-host.js', 'utf8')
  assert.equal(
    /item\.privacy !== 'secret'/.test(hostSource),
    true,
    'buildRecallText must exclude secrets',
  )
  const engineSource = await fs.readFile('lib/memory-engine.js', 'utf8')
  assert.equal(
    /entry\.privacy !== 'secret'/.test(engineSource),
    true,
    'residentCards must exclude secrets',
  )
  checks.push('the injection paths apply the filter themselves')
}

console.log(checks.map((line, index) => `  ${index + 1}. ${line}`).join('\n'))
console.log(`\n${checks.length}/${checks.length} checks passed`)
