# Session handoff — dsh-session-suite

Compact state for a fresh context. Read the linked files on demand; do not paste them whole.

## Repository

- Path: `D:\AI sandbox\dsh-sandbox\DSH Optimize`
- Remote: `https://github.com/heixiua/dsh-session-suite` (branch `main`)
- Local HEAD `a8258d3`; remote content verified identical (32 files) at `1895205`.
- `github.com` is **SNI-blocked** on this network; `api.github.com` works.
  Pushing therefore goes through the Git Data API (blobs → tree → commit → ref PATCH).
  A reusable script pattern lives in the transcript; regenerate it if needed.
  Because API commits carry different metadata, remote SHAs differ from local ones —
  compare **file blob SHAs**, not commit ids.

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

- Snapshots are taken at **turn/end** and mean "workspace after turn N"; a baseline
  (turn 0) is captured once per session. A rewind to a reply keeps that turn's work;
  a rewind to a prompt means the state before it.
- Never trust the `size+mtime` shortcut for files written in the last 2 seconds.
- Only `source.kind === 'user'` messages are prompts; every other user-role event
  (runtime-context, time-context, skill-catalog, agent-message, subagent-settled)
  is harness plumbing and must not reach an export.
- A session log is append-only: "cut" = keep the prefix and retire the original.
- Deleting a message cuts at the message **before its prompt** (whole turn).
- Client code may only `require('react')`; Host code only `node:` builtins.
- Windows: pnpm's relative symlink for an out-of-drive local package does not resolve;
  an absolute junction (`cmd /c mklink /J`) fixes it.

## Tests

```
node tools/selftest.mjs          # snapshot store (18 checks)
node tools/selftest-rollback.mjs # rollback / delete / share
node tools/selftest-memory.mjs   # memory engine
node tools/preview-export.mjs    # writes tools/preview/{export.html,image.html}
```

All four pass as of `a8258d3`.

## Open items

- The user still needs to **restart DSH** for Host-side changes (memory engine, turn
  snapshots) to load; client changes hot-reload.
- Not yet visually verified: the new **Settings → Long-term memory** page, and the
  memory recall actually reaching the model in a live turn.
- `memoryModel` config is unset, so implicit extraction is currently a no-op; explicit
  `【记住：…】` still works. Set it to enable suggestions.
- Extra optimisations from the original plan (context compression, multi-agent
  orchestration UI, timeout fallback) remain out of scope by agreement.

## Context discipline (user instruction, 2026-11-01)

The pi-ai gateway rejects context overflow, so:

1. never put full file contents or command output into messages — return a summary
   plus the path, and read slices on demand;
2. estimate tokens before each request and keep ~10% headroom;
3. compress old tool results to one line instead of keeping raw text;
4. read long files in slices, never in one shot.
