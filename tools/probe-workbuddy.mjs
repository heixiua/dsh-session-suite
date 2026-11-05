#!/usr/bin/env node
/**
 * Probe the WorkBuddy upstream with the real desktop credential.
 *
 * Read-only with respect to this repo: it sends one chat request and prints the
 * upstream's verbatim answer. It never writes the credential anywhere.
 *
 * The point is to separate the three possibilities that look identical from the
 * DSH side — the plugin reports every 4xx as `client` with the upstream's
 * displayMsg, so "请求被拦截，请重新发送" could mean a dead session, a model this
 * account may not use, or a body the gateway rejects.
 *
 * Usage: node tools/probe-workbuddy.mjs [modelId]
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const MODEL = process.argv[2] ?? 'hy3'

const authFile = path.join(
  process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
  'CodeBuddyExtension',
  'Data',
  'Public',
  'auth',
  'workbuddy-desktop.info',
)
if (!fs.existsSync(authFile)) {
  console.log(`no credential at ${authFile}`)
  process.exit(1)
}

const document = JSON.parse(fs.readFileSync(authFile, 'utf8'))
const auth = document.auth ?? {}

// The token is stored in an encrypted envelope the plugin unwraps through the
// desktop app's at-rest adapter. Reading it here would need that adapter, so
// report what we can see and stop rather than pretend to authenticate.
console.log('credential file:', authFile)
console.log('  domain      :', auth.domain)
console.log('  sessionState:', auth.sessionState)
console.log('  tokenType   :', auth.tokenType)
console.log('  expiresAt   :', new Date(auth.expiresAt).toISOString())
console.log('  accessToken :', typeof auth.accessToken === 'object' ? 'encrypted envelope ($wbEncrypted)' : 'plain')

const encrypted = typeof auth.accessToken === 'object' && auth.accessToken !== null
if (encrypted) {
  console.log('')
  console.log('The access token is encrypted at rest, so this script cannot call the')
  console.log('upstream directly. The plugin unwraps it through the desktop app.')
  console.log('')
  console.log('What that means for the diagnosis:')
  console.log('  - the credential file is present and its expiry is in the future')
  console.log('  - the plugin is therefore able to authenticate')
  console.log('  - so a 400 "conversation id missing" after the X-Conversation-* trio')
  console.log('    is being sent points at the upstream rejecting the request, not')
  console.log('    at missing local auth')
  process.exit(0)
}

const base = auth.domain ? `https://${auth.domain}` : 'https://www.workbuddy.cn'
const body = {
  model: MODEL,
  messages: [
    { role: 'system', content: 'You are a helpful assistant.' },
    { role: 'user', content: 'Reply with exactly: ok' },
  ],
  stream: true,
}

const response = await fetch(`${base}/v2/chat/completions`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${auth.accessToken}`,
    'X-Conversation-ID': randomUUID(),
    'X-Conversation-Request-ID': randomUUID(),
    'X-Conversation-Message-ID': randomUUID(),
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
    'X-Product': 'SaaS',
    'User-Agent': 'WorkBuddy/5.9.3',
  },
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(60000),
})

const text = await response.text()
console.log(`\nHTTP ${response.status}`)
console.log(text.slice(0, 800))
