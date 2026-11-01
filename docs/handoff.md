# Session handoff — dsh-session-suite

Compact state for a fresh context. Read the linked files on demand; do not paste them whole.

## Repository

- Path: `D:\AI sandbox\dsh-sandbox\DSH Optimize`
- Remote: `https://github.com/heixiua/dsh-session-suite` (branch `main`)
- Local and remote are the **same commit**: `011d58b`, tree `7885c9c` (36 files).
  `git push` works again; the earlier SNI block on `github.com` is gone.
  The Git Data API workaround (blobs → tree → commit → ref PATCH) is no longer needed —
  but if it returns, that pattern still applies, and then remote SHAs will differ from
  local ones: compare **tree/blob SHAs**, never commit ids.

## What the bundle does

Single bundle `dsh-session-suite` (Host + Web Client, desktop profile). Five features:

1. **Rewind** (↺ on each final assistant message) — conversation + workspace files + memory.
2. **Delete one turn** (🗑) — conversation + memory only, never files.
3. **Delete a run of turns** / **delete a session** — from the session `…` menu.
4. **Share** — pick turns, then PNG / self-contained HTML / Markdown / JSON / clipboard.
5. **Long-term memory** — global + per-workspace stores, settings page.

## Key files (read on demand)

| File | Contents |
|---|---|
| `lib/checkpoints.js` | content-addressed snapshot store (turn snapshots, 10-budget, undo bundles) |
| `lib/service.js` | rollback / undo / delete / share / deleteMessage / deleteSegment |
| `lib/share.js` | session log → Markdown/text/JSON/HTML + block doc |
| `lib/markdown.js` | dependency-free Markdown subset parser |
| `lib/memory-engine.js` | long-term memory: scoring, decay, clustering, rules, recall |
| `lib/memory-host.js` | prompt recall, explicit `【记住：…】`, implicit extraction, `memory` tool |
| `lib/api.js` | `POST api/session-suite` action router |
| `client.js` | all UI slots (menu rows, message actions, banner, dialogs, settings pages) |
| `docs/long-term-memory.md` | memory formula, thresholds, lifecycle |
| `docs/credits.md` | WorkBuddy / Trae credit plugins (model providers, not dispatchers) |

## Invariants learned the hard way

- A plugin row that throws inside `apply` ends up `fiberPhase: "failed"`; every
  HTTP action then 404s and the UI surfaces a bare `not found`. Check the row's
  fiber phase first, and keep optional wiring non-fatal.
- `ToolDefinition` requires an `output: { schema, render }`; registering without
  it throws and takes the whole bundle down.
- Snapshots are taken at **turn/end** and mean "workspace after turn N"; a baseline
  (turn 0) is captured once per session. A rewind to a reply keeps that turn's work;
  a rewind to a prompt means the state before it.
- Never trust the `size+mtime` shortcut for files written in the last 2 seconds.
- Only `source.kind === 'user'` messages are prompts; every other user-role event
  (runtime-context, time-context, skill-catalog, agent-message, subagent-settled)
  is harness plumbing and must not reach an export.
- A session log is append-only: "cut" = keep the prefix and retire the original.
- Deleting a message cuts at the message **before its prompt** (whole turn).
- **Compaction is append-only too.** It writes a `compaction/summary` event and
  then a synthetic `user/message` whose `source.kind` is `compact-checkpoint` and
  whose `surfaceOp` replaces the summarized range. The raw events stay in the log.
  Any code that scans raw events must skip that node, or a summary looks like a
  user prompt and the cut point lands in the wrong place. `previousMessageSeq`
  and `previousUserSeq` both filter it via `isConversationMessage`.
- Compaction runs **inside the turn** (`agent/pre-step` → `compactIfNeeded`), not
  only at the boundary, and a failure only logs a warning. `fork(atSeq)` copies an
  **inclusive** prefix, so rollback and segment delete keep working after
  compaction — they cut at real events, and the summary node is skipped.
- Client code may only `require('react')`; Host code only `node:` builtins.
- Windows: pnpm's relative symlink for an out-of-drive local package does not resolve;
  an absolute junction (`cmd /c mklink /J`) fixes it.
- **Prompt cache is endpoint-local, not model-local.** The same model name served by
  two providers is two invisible cache domains. Measured in this session:
  `deepseek-account` 99.6% over 695 steps, `trae` **0%** over 441 steps (Trae's
  upstream sends no `cached_tokens` at all; `dsh-connect-trae` maps every field it
  is given, so the plugin is not at fault). A hit-rate drop is a provider switch,
  not compaction. `tools/cache-by-provider.mjs` attributes it.
- `inputTokens` is the **uncached remainder**, so
  `totalTokens = inputTokens + cacheReadTokens + outputTokens` (holds for 620/620
  DeepSeek steps). Compute the hit rate as `cached / (cached + uncached)`.
- The cwd for per-workspace memory comes from the **session header** (`header.cwd`,
  validated absolute by the session service). There is no `workingDirectory`
  service. A miss here silently downgrades every workspace memory to the global
  store, which is why `resolveCwd` now walks `header` → `session.header` →
  `agent.session.header` → `sessions.get(id).header`, and returns `undefined`
  rather than guessing.

## Tests

```
node tools/selftest.mjs                    # snapshot store (18 checks)
node tools/selftest-rollback.mjs           # rollback / delete / share
node tools/selftest-memory.mjs             # memory engine
node tools/selftest-memory-scope.mjs       # fallback chain + workspace isolation (9 checks)
node tools/selftest-workspace-registry.mjs # workspace registry + maintenance
node tools/selftest-compaction-boundaries.mjs # cut points after a compaction
node tools/selftest-resolve-cwd.mjs        # workspace cwd resolution (8 checks)
node tools/check-locale.mjs                # dictionary completeness
node tools/preview-export.mjs              # writes tools/preview/{export.html,image.html}
```

Diagnostics (not part of the pass/fail set):

```
node tools/cache-report.mjs        # hit-rate trend for one session
node tools/cache-by-provider.mjs   # attribute cache misses to a provider
node tools/push-github.mjs         # Git Data API push when git-over-https is filtered
```

`docs/pitfalls.md` is the long-form version of this section: 42 entries, each with
symptom → root cause → fix.

All pass as of the commit that added the compaction-boundary test.

## Verified live (2026-11-01, desktop profile)

Everything below was checked against the running app, not just the source:

| Surface | Evidence |
|---|---|
| Host half loaded | `memory` tool registered; `POST api/session-suite` answers `401` (route alive, auth-gated) rather than `404` |
| Client half loaded | slot occupants `session-suite-rewind` (`conversation.chat.assistant-actions`), `session-suite-share` / `-snapshots` / `-segment` / `-delete` (`sidebar.workspaces.session.menu.item`), `session-snapshots` + `long-term-memory` (`settings.section`) |
| Snapshots on disk | two sessions, 7 + 2 manifests, 43 files / 924 KB at the newest checkpoint; undo bundle `undo_87c70a766b04.json` present |
| Export quality | `tools/preview/export.html`: Markdown tables + headings + code, 1 inlined `data:image`, **0** `Time sampled` leaks |

## Open items

- Context compaction (`@deepseek-ai/dsh-compaction-basic`,
  `-tool-result-pruner`, `@deepseek-ai/dsh-command-compact`) is enabled in the profile
  patch layer. Trigger is `floor(min(W×0.8, W−O−65536))` — for a 1M window that is
  **≈800K**, so a 710K session correctly does not compact yet. Run `/compact` to force it.
- `memoryModel` config is unset, so implicit extraction is currently a no-op; explicit
  `【记住：…】` and the `memory` tool both work (verified live).
- Extra optimisations from the original plan (multi-agent orchestration UI, timeout
  fallback) remain out of scope by agreement.

## Context discipline (user instruction, 2026-11-01)

The pi-ai gateway rejects context overflow, so:

1. never put full file contents or command output into messages — return a summary
   plus the path, and read slices on demand;
2. estimate tokens before each request and keep ~10% headroom;
3. compress old tool results to one line instead of keeping raw text;
4. read long files in slices, never in one shot.
