# DSH extension points this bundle uses

Notes from building against a **DSH 0.2.1-rc.5 desktop profile** (`app.asar` build). Every name below was checked
against the live runtime with the Harness inspection providers; paths are listed so a future reader can re-verify
them after an upgrade. This is a summary, not a specification — the installed build is the authority.

## Bundle shape

* `package.json` → `dsh.bundle.patch` points at `cordis.patch.yml`, which inserts one Host row.
* `package.json` → `dsh.client` (`platform: "web"`, `immediately: true`, `inject: [...]`) makes the Client half a
  web module. The module id must equal the package name.
* The Host half exports `apply(ctx, config)` (plus optional `name` / `inject`), and the Client half calls
  `window.__ModuleLoader__.load({ id, factory(require) })` returning `{ inject, apply(ctx) }`.
* A profile-installed bundle resolves from the profile, not from the DSH installation: **import `node:` builtins
  only**. No `@deepseek-ai/*` package is importable, and Client code may only `require('react')`.

## Host services

| Service | Used for |
|---|---|
| `connection.fetch.register({ path, methods, requestBody, fetch })` | The `POST /api/session-suite` route. Connection applies its Host/Origin checks and browser authentication, then bridges the `Response`. |
| `sessionController` | `list` (running state), `inspect` (durable events + header), `fork({ sessionId, atSeq })` |
| `workspaceController` | `archiveSession({ stopActivity })` / `unarchiveSession` |
| `workingDirectory` | The per-session working directory, used when a turn starts |
| `ctx.on('session/event', ...)` | Observing `turn/start` to capture one checkpoint per turn |

`sessionController.fork` boundary semantics matter: `atSeq` is **inclusive**, the child copies `cwd` and
re-composes the agent preset, and the source session does not need to be cold. The child is what "rewinding"
means on an append-only log.

There is **no** session-deletion API anywhere in the persistence layer (the backend README says pruning stored
sessions is out-of-band maintenance), so `deleteSession` removes
`DSH_HOME/sessions/<project>/<sessionId>/` and the projection-cache row itself, after archiving the session so the
sidebar agrees.

`workspaceChanges` cannot be reused for this feature: its summaries and diffs are kept in memory plus a temp
directory and are dropped on `session/disposed`, so it cannot reconstruct file state at an arbitrary point. That is
why the bundle owns a content-addressed snapshot store instead.

## Client slots

| Slot | Registration | Props used |
|---|---|---|
| `sidebar.workspaces.session.menu.item` | list, `order` 460–462 (share) and 900 (delete) | owner `{ sessionId, displayTitle }`; injected hook `useMenuOpenState()` returns `[open, setOpen]` |
| `conversation.chat.assistant-actions` | list, `order` 20 | owner `{ messageId }` plus `sessionId` |
| `conversation.input.dock` | list, `order` 30 | owner `{ session, input }` |
| `shell.overlay` | list, `order` 40 | frame-wide, click-through layer; entries opt back into pointer events |
| `settings.section` | list, `order` 500, `label` thunk | owner `{ close }` |

Conventions worth remembering:

* Register with `locale: '<ns>'` and the renderer injects `t`; otherwise bind with `ctx.locale.bind(ns)`.
* A menu row renders one `role="menuitem"` `<button>`; the list's keyboard walk reads the DOM. Use a
  package-namespaced `id`.
* The settings shell owns the overlay, the nav column, and the scrolling content column — a section supplies only
  its own content (a heading plus fields), up to ~720 px wide.
* Style with `--dsw-alias-*` theme tokens. Harness Client packages are not importable, so controls are hand-built
  and copied in behaviour (focus, Escape, `aria-modal`).

## Storage

`node:fs/promises` is acceptable for a Host plugin (shipped persistence and the profile's `dsh-browser` plugin both
do it). Plugin state lives under `DSH_HOME/storages/dsh-session-suite/`; `DSH_HOME` comes from the environment with
`~/.dsh` as the fallback. `ctx.storageDomain` is the alternative for small JSON records, but this bundle writes
blob files and manifests, which a domain table is a poor fit for.

## Verification notes

* Host: `plugin_manager install_bundle` returned `application: "applied"`; the rows appear in
  `cordis_inspect_query` (`Config`, `Slots`) as active occupants.
* The GUI requires an authenticated page; without browser control, visual verification is reported as unavailable.
  Functional verification therefore relies on the two self-tests plus the live registration check.
* Windows quirk: `pnpm` links a directory dependency installed from another drive with a relative symlink that
  does not resolve. Replacing it with an absolute junction (`mklink /J`) makes the bundle resolvable; the manager's
  later installs keep it.
