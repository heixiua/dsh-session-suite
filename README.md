# dsh-session-suite

**By [heixiua](https://github.com/heixiua)** · [github.com/heixiua/dsh-session-suite](https://github.com/heixiua/dsh-session-suite) · MIT
· npm: [`@heixui/dsh-session-suite`](https://www.npmjs.com/package/@heixui/dsh-session-suite)

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

From npm:

```bash
dsh plugin --profile desktop install @heixui/dsh-session-suite
```

> The published package is scoped because the unscoped name `dsh-session-suite`
> belongs to a different project on npm (`chc-1986/dsh-session-suite`), not to
> this one. The scope is only the npm package identity — the plugin id, the
> storage directory, and the bundle name remain `dsh-session-suite`, so data from
> earlier builds is still found.

From a checkout:

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
node tools/selftest-cluster-idempotence.mjs   # repeated passes never multiply rules or summaries
node tools/selftest-inherit.mjs               # a forked session keeps its snapshots
node tools/selftest-retrieval.mjs             # BM25, coverage and RRF primitives
node tools/selftest-wordlist.mjs              # longest-match CJK segmentation
node tools/selftest-factkeys.mjs              # fact-key canonicalisation and supersession
node tools/selftest-factkey-integration.mjs   # fact keys through remember and recall
node tools/selftest-injection.mjs             # how many memories get injected, and why not
node tools/selftest-explicit-writes.mjs       # a pipeline message is never obeyed as a user instruction
node tools/selftest-list-sessions.mjs         # a rewound session is still listed; subagents stay hidden
node tools/selftest-delete-cascade.mjs        # cascade delete order, and refuse-before-touching
node tools/check-locale.mjs                   # every t() key exists in both dictionaries
```

Every one of these has been mutation-checked: a deliberate break of the
behaviour it names makes it fail. That is the only claim worth making about a
test — one that passes on broken code is documentation, not a guard.

`tools/ablate-word-route.mjs` answers a narrower question: does the third
retrieval route earn its place? It runs each probe twice against the *same*
store, once with the route and once without, so a shifted memory library cannot
confound the comparison:

```bash
node tools/ablate-word-route.mjs
```

The result is that the word route raises MRR on both the held-out and final sets
(0.491 → 0.561 and 0.612 → 0.683) while leaving recall@5 unchanged — better
ordering, no lost hits.

Retrieval quality is measured, not asserted. Three probes report the standard
metrics (recall@k, MRR, nDCG@k) instead of a pass/fail on the top hit:

```bash
node tools/probe-recall.mjs           # the six queries the rerank was tuned on
node tools/probe-recall-heldout.mjs   # seven unseen, everyday-worded queries
node tools/probe-recall-final.mjs     # ten queries written before the hybrid change
```

The three sets exist because one set cannot tell honest progress from
overfitting. `probe-recall.mjs` holds the queries the coverage rerank was tuned
against, so it proves only that the code fits its own training set;
`probe-recall-heldout.mjs` was written afterwards to expose that rerank's blind
spots, and `probe-recall-final.mjs` was written *before* the hybrid change and
never used to design it. All three rose when the hybrid landed, which is the
evidence that matters:

| query set | MRR before | MRR after | recall@5 before | recall@5 after |
|---|---|---|---|---|
| tuned (6) | 0.833 | **0.917** | — | — |
| held-out (7) | 0.339 | **0.600** | 0.714 | **0.857** |
| final (10) | 0.466 | **0.733** | 0.800 | **1.000** |

Ranking runs three lexical routes with different blind spots and fuses them by
rank, following the hybrid-retrieval design in chapter 3 of 《深入理解 AI Agent》:

| route | vocabulary | scored by | blind spot it covers |
|---|---|---|---|
| precise | character bigrams + ASCII words | BM25 | — |
| loose | single characters + ASCII words | IDF-weighted coverage | partial word overlap |
| word | words from a general Chinese dictionary | BM25 | over-matching across word boundaries |

The third route exists because character bigrams cannot tell 「车」 inside
「车站」 from 「车」 standing alone, so they match across word boundaries; a word
list fixes exactly that. It is weaker on anything outside the list — personal
names, code identifiers, new coinages — which is why it joins the fusion rather
than replacing a route. A third opinion only helps when it is wrong in different
places, and `tools/ablate-word-route.mjs` is what checks that it is.

The book fuses a dense route with a sparse one; recall runs offline and must stay
offline, so every route here is lexical.

That limit is worth stating plainly: no route crosses languages, so a query that
shares no character with a memory — 「checkpoint」 against 「快照」 — still scores
zero. The hybrid recovers ranking order among memories that are already
reachable; it cannot invent a match where no character is shared.

## What actually gets injected

`recallLimit` is a ceiling, not a quota. Filling it on every turn is how a weak
question drags six unrelated memories into the prompt and then asserts they are
relevant. The injected count steps down with the evidence — the full budget for a
strong match, fewer for a weaker one, and one entry when the question barely
matches anything. A question that matches nothing injects nothing.

A small resident layer runs alongside: the two most important memories ride along
regardless of the question. Without it, an ordinary follow-up like 「继续」 shares
no vocabulary with anything, a strict relevance filter would inject nothing at
all, and the feature would look broken rather than selective. Set
`residentLimit: 0` to turn it off.

Every candidate that is *not* injected is reported with the rule that dropped it
(`no-match` or `capacity`). A memory system that silently decides not to recall
something is indistinguishable from one that has forgotten it; naming the reason
is the difference between a black box and a debuggable feature.

The memory settings page has a **"What would this question recall?"** box that
shows this live: type a question, see which memories it pulls in, how many the
evidence justifies, and why each of the rest was left out. The dry run is
read-only (`touch: false`), so trying queries cannot re-rank your own library.

## Fact keys: the same fact, restated

Lexical similarity cannot see a value change. 「拼团还没开」 and 「拼团开了」 are
the same fact before and after, but they look unrelated; 「身高一米七」 and
「长胖到 55 公斤」 look alike but are different facts. Neither comparison can be
made from the text.

So an entry may carry a `subject.aspect` key — `她.身高`, `约定.见面地点`. Entries
sharing a key are the same fact, and only the newest is recalled; the older ones
are marked superseded, stay on disk, and are never deleted. Restating a superseded
fact revives that record rather than forking a second one.

Two rules keep it safe. A key that is too broad is **refused** rather than
trusted — a single-segment key like `身高` names a category, not a fact, so the
entry simply opts out of supersession. And a key must never contain the value:
`她.身高170` changes whenever the height does, so the two records never meet. An
absent key is harmless; a wrong key can retire a good memory.

## If your memory library was affected

Between 2026-11-04 and the fix in this version, a self-triggering bug made the
plugin obey its own instruction text: it scanned every message with
`role === 'user'` without checking `source.kind`, harness pipeline messages carry
that role, and this plugin's injected memory block ends with the literal example
`【记住：…】`. The plugin captured that placeholder and stored it as a memory, 154
times.

Three guards now prevent it, each with a regression test: only user-authored
messages are obeyed, placeholder-only captures are refused, and identical text
reinforces instead of appending. Real memories were never overwritten — the write
path never rewrites text — so they are recoverable from any pre-poisoning
snapshot, including the atomic write's leftover `.tmp` file:

```bash
node tools/repair-memory-store.mjs           # dry run: reports the plan
node tools/repair-memory-store.mjs --apply   # backs up first, then repairs
```

The repair backs the current store up under `memory/backups/` before writing
anything, and it never deletes real content.

`docs/pitfalls.md` collects every trap hit while building this bundle, each written
as symptom → root cause → fix. Read it before changing the snapshot, compaction,
memory, or export paths.

`docs/memory-architecture.md` maps the memory engine against the standard
two-layer agent-memory design, with measured numbers rather than claims — including
the parts that are deliberately not built and why.

## What changed in 0.4.0

The memory engine was reorganised; the session features are unchanged.

| Area | Before | Now |
|---|---|---|
| Duplicate memories | One topic occupied 7 of 46 entries | Maintenance is idempotent (verified across 6 passes); existing duplicates merged into cold storage |
| Resident layer | 2 flat entries mixed into the "relevant" block | Up to 5 topic cards, in their own labelled section |
| Episodic memory | Absent | `kind: 'episode'` with time, context, and outcome; decays twice as fast |
| Dense reranking | Implemented but off, weight unverified | **Optional, off by default**, weight calibrated by measurement (MRR 0.535 → 0.760 on 8 paraphrased queries, recall unchanged) |
| Privacy | Scope only | `public` / `internal` / `secret`; credentials auto-detected; `secret` never injected or exported |
| Implicit queue | Keyword gate dropped 7 of 10 valid candidates | Gate removed; an empty queue now states why it is empty |

**Embedding is optional and adds no download by default.** Lexical retrieval alone is
the default behaviour; installing a model adds cross-lingual and paraphrase recall.
See `docs/memory-architecture.md` for the measured effect and
`tools/download-embedding.mjs` for the deliberate, explicit install path.

## Limits

* Rewinding does not rewrite the durable log; it forks at the target message and archives the old session. That
  is the only shape the append-only log supports, and it is what makes undo possible at all.
* **Edit-and-resend appends, it does not replace.** The edited question is sent as a new turn in the same
  session; the original question and its reply stay in the history above. This is a property of the append-only
  log, not a shortcut: a plugin cannot erase events that were already written. Products like Doubao or ChatGPT can
  replace a message in place because they own a mutable message table. If you need the old exchange to actually
  disappear, use rewind (which forks) instead — it has that behaviour, at the cost of a new session.
* **Tags are normalised, not taken verbatim.** Spellings of the same domain fold together (`DSH` → `dsh`,
  `踩坑` → `错误教训`), and words that name this plugin's own UI (`快照`, `删除`) are dropped rather than stored,
  because a tag nobody can filter by is worse than no tag. New domains are still accepted.
* Snapshots cover files, not external side effects: database state, running processes, and network calls are out
  of scope.
* Cross-session memory is this bundle's ledger (`memory/`), not a Host feature; it is exposed through the settings
  page and participates in rollback because the bundle owns it.
* The HTTP route is protected by DSH Connection (Host/Origin checks plus the browser session), so it is reachable
  only from the authenticated Web GUI.
* Retrieval is lexical. Neither route crosses languages, so a query sharing no character with a memory
  (`checkpoint` against `快照`) scores zero; the hybrid improves ordering among reachable memories, it cannot
  invent a match.

## Author

Built by **heixiua** — <https://github.com/heixiua/dsh-session-suite>.

Every source file, the git history, and the published npm tarball carry this
identity. If you found this plugin through a fork or a repackaged bundle, the
upstream repository above is the original.

## License

MIT. The bundle ships one third-party data file — a Chinese word list derived
from [jieba](https://github.com/fxsjy/jieba) (MIT) — whose provenance, changes,
and full licence text are recorded in [THIRD-PARTY.md](THIRD-PARTY.md).
