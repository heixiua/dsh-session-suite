# Long-term memory

The engine that answers "why doesn't DSH remember across sessions?" — and unlike
Doubao, it never writes anything you did not approve.

## Two stores, no third

| Store | Lifetime | Who sees it |
|---|---|---|
| `global` | forever | every session, every workspace |
| `workspace` | while the folder matters | sessions in that working directory |

Session snapshots are **not** a memory store. They exist for rewinding a
conversation, and they never enter scoring, decay, or clustering — the spec is
explicit about that, and the code keeps the two systems separate
(`lib/checkpoints.js` vs `lib/memory-engine.js`).

Recall order is global first, workspace second, and a workspace memory wins when
the two conflict.

## Writing memory

**Explicit** (highest priority, parsed before the step runs, no model involved):

```
【记住：插件代码只依赖 node 内置模块】
【新增全局记忆：调度优先用 WorkBuddy 积分】
【新增本工作区记忆：这个仓库用 pnpm】
```

**Implicit** (one cheap model call after each turn): the transcript is screened
for stable preferences, fixed technical conventions, long-term strategy, and
personal habits. One-off tasks, transient debugging, and small talk are dropped
by two keyword filters *and* by the model's own judgement. Whatever survives
becomes a **pending suggestion** in the settings page; nothing is stored until
you press *Keep*. Untick *Suggest memories automatically* to turn the whole
implicit path off.

## Scoring (four factors)

Every entry carries creation time, last-access time, access count, affect, and a
duplicate signal. The composite is:

```
score = 0.35·frequency + 0.30·recency + 0.15·affect + 0.20·uniqueness
```

* **frequency** — `log(1+accesses) / log(1+max)`, so often-recalled entries rise;
* **recency** — `exp(-days / halfLife)` measured from the **last access**, not
  creation: being recalled restarts the clock. A frozen entry is pinned at 1;
* **affect** — how much the statement reads as a hard constraint or preference;
* **uniqueness** — `1 − max similarity to any other entry`, so a near-duplicate
  is worth less than a fresh fact.

Weights and the two thresholds are configurable (`weights`, `thresholds`,
`decayDays`).

## Lifecycle

| Score | State | What happens |
|---|---|---|
| ≥ compress threshold (0.45) | `active` | full text stays in the recall pool |
| between thresholds | `compressed` | stays, but a cluster summary may stand in for it |
| < archive threshold (0.25) | `archived` | moved to cold storage; no longer auto-injected, still listable |

Nothing is hard-deleted by decay. A memory you keep using keeps its score; one
nobody touches slowly falls out of the pool. That is the "dynamic decay, not a
fixed 90-day delete" rule.

## Clustering and abstraction

`maintain()` runs three passes. It fires **automatically every
`maintainIntervalMs` (default 30 minutes)** over the global store plus the
workspace of the most recent turn, and can also be triggered from the settings
page:

1. **score + decay** — recompute every entry, move entries across the two
   thresholds;
2. **cluster** — group entries above `clusterSimilarity` (default 0.5), emit one
   summary entry for the group, and archive the originals to cold storage. A
   recall can still reach the originals on request;
3. **abstract** — when `ruleMinSize` (default 3) entries share a tag, write a
   `rule`-type memory that outranks the scattered facts. Example:

   > 闲时用 WorkBuddy 积分、代码任务优先 Trae、贵重 V4.1 Flash 只给核心推理
   > → 规则（调度）：优先消耗 WorkBuddy/Trae 积分，DeepSeek V4.1 Flash 仅分配给高优先级核心任务

Clustering needs *similar* entries, so it stays quiet until a project actually
accumulates overlapping facts — one lone memory never clusters, and unrelated
memories never do.

## Which model extracts memories

Implicit extraction is one cheap call per turn, and it uses a **fallback chain**
so a rate-limited or unreachable free tier never silently disables the feature:

```yaml
memoryModels:
  - provider: agnes
    model: agnes-3.0-flash
  - provider: agnes-backup
    model: agnes-3.0-flash
  - provider: zhipu
    model: glm-4.7-flash
  - provider: siliconflow
    model: Qwen/Qwen2.5-7B-Instruct
```

Every entry is tried in order until one returns text; a `429` or a dead provider
just moves to the next. `memoryModel` (singular) is still accepted for a
one-model setup, and the two forms can be combined. Entries missing a `provider`
or `model` are dropped, and duplicates collapse so no model is called twice.

## Commands and controls

| Action | Where |
|---|---|
| `【记住：…】` / `【新增全局记忆：…】` | chat, parsed every step |
| `memory` tool (`remember` / `recall` / `list` / `forget` / `freeze`) | any agent |
| Settings → **Long-term memory**: tabs, scores, freeze, delete, add | Web UI |
| Workspace picker (when no session is open) | the same page |
| Re-score and compress now | the same page |
| Clear cold archive | the same page |
| Export everything (JSON) | `longterm.export` action |

Freezing a memory pins it: it never decays, is never archived, and survives the
cluster pass. Freezing an archived memory restores it to the live pool.

## Workspace isolation

Workspace memories live in `workspaces/<key>.json`, where `key` is
`sha256(normalized path).slice(0, 16)` — two different project directories hash
to two different keys and never share a file. Case, separator style, and a
trailing slash all normalize to the same key, so `D:\…\DSH Optimize` and
`d:/…/dsh optimize/` are one workspace. The global store is a separate file and
is never written by a workspace-scoped write.

Because the key is a one-way hash, each store also records its readable `cwd` in
`workspaces.json`; that registry is what lets the settings page name a workspace
and offer a picker instead of showing a bare hash.


## What the model sees

A `session-suite-memory` prompt context injects **only** the entries relevant to
the current question — up to `recallLimit` (default 6), workspace entries first,
each labelled `[全局]` or `[本工作区]`. The whole library is never pasted into
context; that is the recall-throttling rule from the spec.

## Storage

```
%DSH_HOME%/storages/dsh-session-suite/memory/
  global.json                    global store
  workspaces/<hash>.json         one file per working directory
  cold/global.json               archived global entries
  cold/<hash>.json               archived workspace entries
  pending.json                   suggestions awaiting confirmation
  settings.json                  weights, thresholds, decay, implicit on/off
```

The workspace key is a hash of the normalized absolute path, so moving a project
keeps its memories with it only if the path stays the same — a deliberate
trade-off that avoids storing machine-specific paths in the memory text.
