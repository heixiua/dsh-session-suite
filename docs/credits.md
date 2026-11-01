# Using WorkBuddy and Trae credits from DSH

These two plugins are **model providers**, not automation channels. They let a DSH
session run on the credits you already pay for in the WorkBuddy and Trae desktop
apps, so the same agent can switch between DeepSeek's own account, WorkBuddy
credits, and Trae credits without leaving the harness.

They are separate packages and are **not** bundled with `dsh-session-suite`:

```bash
dsh plugin --profile desktop install dsh-workbuddy-connect@0.7.9
dsh plugin --profile desktop install dsh-connect-trae
```

## What they actually do

| Plugin | Adds to DSH | Needs |
|---|---|---|
| `dsh-workbuddy-connect` | the WorkBuddy model group in the model picker | WorkBuddy desktop app installed and signed in |
| `dsh-connect-trae` | the Trae model groups (CN / enterprise / global) | Trae desktop app installed and signed in |

Both reuse the desktop app's **existing sign-in state** — no API key is copied,
and the apps keep their own account. Switching accounts in the app is picked up
automatically.

## WorkBuddy

Installed and signed in at `D:\AI app\Workbuddy` on this machine. The plugin
discovers it, reads the account, and publishes its model catalog; sixteen models
were listed at the time of writing, including `DeepSeek-V4.1-Flash` with a 1M
context window, `GLM-5.3`, and `Hy4 preview`, each with its credit rate.

Notes:

* the plugin's default lookup is `%LOCALAPPDATA%\Programs\WorkBuddy\WorkBuddy.exe`;
  an install elsewhere still works because the plugin also reads the app's own
  heartbeat and storage, but if a machine has an unusual layout, set
  `authFile` in the plugin config to the app's auth file;
* the model list is cached in `~/.dsh/.workbuddy-catalog.json`;
* credits are consumed by the app's own accounting — DSH only shows the rate.

## Trae

The plugin reads Trae's `storage.json`
(`%APPDATA%\Trae CN\User\globalStorage\storage.json` on a CN install), which
carries the `iCubeAuthInfo` entries, and exposes the account's models plus a
credits overview.

## What this is not

Neither plugin turns DSH into a dispatcher for the other apps. They do not send
tasks to Trae, drive WorkBuddy's UI, or read their conversation history — they
only make their **models** available inside DSH. A "DSH drives Trae/WorkBuddy"
feature would need an MCP server or a terminal/automation bridge, which is a
different kind of integration and out of scope for this repository.

## Version compatibility

`dsh-workbuddy-connect@0.7.9` declares `@deepseek-ai/dsh-*` peers pinned to
`0.2.1-rc.2`; the desktop build here is `0.2.1-rc.5`, so installation requires an
explicit exact-version exemption. The plugin runs, but treat that as an accepted
risk: pin the pair when DSH updates.

`dsh-connect-trae` declares ranges (`>=0.1.7-rc.1 <0.3.0-0`), so it installs
without an exemption.
