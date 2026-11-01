# dsh-session-suite

Session checkpoints for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH): rewind a
conversation *together with the workspace files and the session memory it produced*, delete sessions for good,
share a conversation as an image or a self-contained page — and keep a **long-term memory** that survives across
sessions and workspaces.

It is a DSH bundle (Host + Web Client) built against the desktop profile, and it deliberately targets the
interaction pattern of Trae's session actions.

| Capability | Where it lives |
|---|---|
| Rewind to a message (conversation + files + memory) | ↺ button on every final assistant message, inline confirm bar above the composer |
| Delete one turn (conversation + memory only) | 🗑 button beside ↺ |
| Delete a chosen run of turns | Session menu → **Delete part of the conversation**, with a turn picker |
| Delete a session permanently | Session menu → **Delete session** (confirmation dialog) |
| Share a chosen range | Session menu → **Share**: pick turns, then Image / Web page / Markdown / JSON / copy text |
| Snapshot management | Session menu → **Session snapshots**, and Settings → **Session snapshots** |
| Long-term memory (global + per-workspace) | Settings → **Long-term memory**; `【记住：…】`; the `memory` tool |
| Use WorkBuddy / Trae credits as models | **not this bundle** — see [Using WorkBuddy and Trae credits](docs/credits.md) |

### Long-term memory

Two isolated stores (`global` and per-`workspace`), a four-factor importance score
(frequency · recency · affect · uniqueness), dynamic decay with a cold archive, similarity clustering with
summary compression, and rule abstraction from repeated tags.

The part that matters most: **nothing is stored implicitly without your consent.** After each turn a cheap model
call proposes durable facts, they queue in the settings page, and only *Keep* writes them. Explicit
`【记住：…】` / `【新增全局记忆：…】` instructions skip the queue and write immediately.

Full detail — scoring formula, thresholds, lifecycle, commands, storage layout — in
[docs/long-term-memory.md](docs/long-term-memory.md).


### What each destructive action touches

| Action | Conversation | Memory | Workspace files |
|---|---|---|---|
| Rewind (↺) | cut at the message | trimmed to that point | **restored** to that turn's snapshot |
| Delete a turn (🗑) | the prompt, the reply, and the steps between them | trimmed to that point | untouched |
| Delete part of the conversation | cut at the first selected turn (its prompt included) | trimmed to that point | untouched |
| Delete session | removed from disk | removed | untouched (the folder stays) |

Only a rewind puts files back; every other delete leaves the working tree exactly as it is. A session log is
append-only, so "cut" always means "keep the prefix and retire the original" — the turns after a removed range go
with it.

### Sharing

The share dialog lists every turn with its prompt and a preview of the answer. Everything is selected by default;
untick what should stay out. Then choose an output:

* **Image** — a PNG of the selected turns, drawn on a canvas (no other library involved);
* **Web page** — one self-contained HTML file with inline CSS, light/dark aware, printable to PDF;
* **Markdown** / **JSON** — for pasting into an issue or feeding another tool;
* **Copy text** — the plain transcript on the clipboard.

Both rich formats render the model's Markdown instead of echoing it: headings, bold/italic, inline code, fenced
code blocks, ordered and bulleted lists, block quotes, pipe tables, and links. The Host parses the log once into
blocks with inline runs (`lib/markdown.js`), the HTML renderer emits markup from those blocks, and the browser draws
the very same blocks on a canvas — so the page and the image never disagree.

Screenshots travel with the export. Attachments live outside the session log, so the Host resolves them
(`attachments.imageHostPath`) and inlines them as data URLs under a bounded budget, which keeps the page a single
portable file. In the image they are drawn at full card width (height-capped, aspect preserved); in the HTML page
each screenshot is a button that opens a built-in viewer at native resolution — the page carries a small inline
script and no external request.

A raster image cannot contain clickable images: if opening a screenshot at full size matters, share the HTML file
rather than the PNG. Nothing in the export depends on a network request either way.

### What an export contains

A session log is mostly plumbing: runtime context, the skill catalog, time samples, subagent relays, tool calls,
and the narration a model writes between tools. None of that is the conversation:

* only `source.kind === "user"` messages count as prompts — everything else in a user-role event is dropped;
* **Final answers only** (the default) keeps your prompt plus the closing reply of each turn;
* untick it to export every assistant step, including the narration around tool calls;
* tool results never appear in the rich exports, and Markdown/JSON follow the same curation.

Consecutive assistant steps of one turn merge into a single card, and steps with no prose are dropped rather than
exported as empty `Assistant` labels.

A public share link would need a server holding the conversation; the web page file is the portable equivalent, so
that is what this bundle produces instead of minting URLs that would only work on this machine.

## Install

```bash
# from a checkout of this repository
dsh plugin --profile desktop install .   # or: pnpm add -D . inside the profile
```

Or let the running Harness install it (this is what `plugin_manager` does):

```js
// tool call
plugin_manager({ action: 'install_bundle', target: 'D:/path/to/dsh-session-suite' })
```

Install once, then reload the page. The bundle registers a single Host row (`session-suite`) whose patch lives in
`cordis.patch.yml`; the Client half is discovered from `package.json` → `dsh.client`.

## How a rewind works

DSH's session log is append-only and is the only source of truth, so a rewind cannot delete events. The suite
implements it as an atomic three-part operation:

1. **Protect** — capture a temporary *undo* snapshot of the workspace and the memory ledger (10-minute TTL).
2. **Conversation** — `sessionController.fork({ sessionId, atSeq })` copies the exact event prefix into a new
   session (inclusive boundary, same `cwd`, same agent preset).
3. **Files** — restore the checkpoint recorded for that turn: changed files are rewritten, files the session
   created afterwards are removed, and files that existed before the session are never touched.
4. **Memory** — trim memory entries observed after the target sequence.
5. **Retire** — archive the source session (hidden from the sidebar, log kept) so nothing is destroyed.

`Undo` reverses all of it: files, memory, the archived session, and the forked child.

## Snapshots on disk

```
%DSH_HOME%/storages/dsh-session-suite/
  sessions/<sessionId>/index.json        # checkpoint records
  sessions/<sessionId>/manifests/*.json  # path -> {hash, size, mtime}
  sessions/<sessionId>/blobs/<ab>/<hash> # gzip-compressed file contents, content-addressed
  memory/<sessionId>.json                # per-session memory ledger
  memory/_global.json                    # cross-session long-term memory
  undo/<id>.json                         # rollback undo bundles
```

* **Incremental** — a manifest stores only tracked paths and hashes; identical content is stored once, and
  unchanged files are skipped using the previous manifest's `(size, mtime)` fingerprint.
* **Budget** — the newest 10 automatic checkpoints per session are kept; locked checkpoints never expire;
  temporary undo bundles live outside the budget and are swept after 10 minutes.
* **Ignore list** — `node_modules`, `.git`, caches, build output, logs, lockfiles, and binary files are never
  recorded; `config.ignore` adds your own patterns.
* **Limits** — files above 2 MiB and trees above 4000 files are skipped rather than slowing a turn down.

## Configuration

```yaml
- insert:
    - id: session-suite
      name: dsh-session-suite
      config:
        keep: 10               # automatic checkpoints kept per session
        autoCheckpoint: true   # capture one at the start of every turn
        maxFileBytes: 2097152
        maxFiles: 4000
        sweepIntervalMs: 300000
        ignore: []             # extra ignore patterns
```

## Layout

```
index.js            Host half: route registration, per-turn checkpoints, sweep timer
client.js           Client half: menu rows, message actions, banner, dialog, settings page
lib/api.js          Authenticated Fetch route (POST api/session-suite)
lib/service.js      Session operations: rollback, undo, delete, share, delete-message
lib/checkpoints.js  Content-addressed incremental snapshot store
lib/memory.js       Session memory ledger with rollback trimming
lib/share.js        Session log → Markdown / text / JSON projection
locale/{en,zh}.json Plugin Manager display metadata and strings
tools/              Self-tests and the pre-clean helper (not part of the bundle)
docs/               Requirements and API notes
```

## Tests

The self-tests exercise the engine and the orchestration against throwaway directories; they never touch the
real DSH home.

```bash
node tools/selftest.mjs                       # snapshots, ignore rules, restore, pruning
node tools/selftest-rollback.mjs              # rollback, undo, delete-message, share, permanent delete
node tools/selftest-memory.mjs                # scoring, decay, clustering, rules
node tools/selftest-memory-scope.mjs          # model fallback chain, workspace isolation
node tools/selftest-workspace-registry.mjs    # workspace registry, automatic maintenance
node tools/selftest-compaction-boundaries.mjs # cut points survive a compaction
node tools/selftest-resolve-cwd.mjs           # an agent can find its own workspace
node tools/selftest-maintenance.mjs           # idle libraries skip, rules never duplicate
node tools/check-locale.mjs                   # every t() key exists in both dictionaries
```

`docs/pitfalls.md` collects every trap hit while building this bundle, each written
as symptom → root cause → fix. Read it before changing the snapshot, compaction,
memory, or export paths.

## Limits

* Rewinding does not rewrite the durable log; it forks at the target message and archives the old session. That
  is the only shape the append-only log supports, and it is what makes undo possible at all.
* Snapshots cover files, not external side effects: database state, running processes, and network calls are out
  of scope.
* Cross-session memory is this bundle's ledger (`memory/`), not a Host feature; it is exposed through the settings
  page and participates in rollback because the bundle owns it.
* The HTTP route is protected by DSH Connection (Host/Origin checks plus the browser session), so it is reachable
  only from the authenticated Web GUI.

## License

MIT.
