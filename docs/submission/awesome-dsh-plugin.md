# awesome-dsh-plugin 投稿草稿（本地草稿，未提交 PR）

> 目标仓库：https://github.com/awesome-dsh-plugin/awesome-dsh-plugin
> 投稿方式：fork 后新建 **`data/plugins/heixiua__dsh-session-suite.yml`**，内容即下方 YAML，一个 PR 只加这一个文件。
> 命名规则见 [contributing.md](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)：`data/plugins/<owner>__<repo>.yml`。
>
> 提交前自检：
> - `url` 必须与仓库完全一致 ✅ `https://github.com/heixiua/dsh-session-suite`
> - `package.json` 声明 `dsh.bundle.patch` + 根目录有 `cordis.patch.yml` ✅
> - 仓库创建满 1 天 ✅
> - 仓库已加 `dsh-plugin` topic（如未加，先到 GitHub 仓库页补上）
> - `category: session` —— 主体是会话快照/回滚/删除/导出，记忆只是其中一块；描述里不夸大数字
> - 描述含 `: ` 的地方必须加引号 ✅ 全部用引号包住
>
> **本文件不放进 npm 包**（`package.json` 的 `files` 白名单不含 `docs/`）。

## data/plugins/heixiua__dsh-session-suite.yml

```yaml
url: https://github.com/heixiua/dsh-session-suite
name: heixiua/dsh-session-suite
category: session
description:
  en: "Session toolkit for DeepSeek Harness: per-turn workspace checkpoints, rewind a conversation together with its files, permanent session and subagent deletion, archive/restore, Markdown/HTML/JSON exports, and a long-term memory library with scope isolation, contradiction review, lesson distillation, and a portable Markdown snapshot. Installs as one npm package with no Python, vector database, or external service required."
  zh: "给 DeepSeek Harness 补上会话层管理：每轮自动拍工作区快照、回滚对话同时恢复文件、永久删除会话与子智能体、归档恢复、Markdown/HTML/JSON 导出，以及按工作区与全局隔离的长期记忆（含冲突裁决、教训蒸馏、可迁移 Markdown 快照）。单个 npm 包即可安装，不需要 Python、向量库或外部服务。"
```

## 备注

- 类目可能由维护者改成 `memory`；按 contributing.md 的说明，「选得不够准由维护者直接改，不会打回」，不必纠结。
- `description.en` 提到的每个能力都能在代码里核到：
  - checkpoints → `lib/checkpoints.js`
  - rewind/delete/archive/export → `lib/service.js`、`lib/share.js`
  - contradiction review → `lib/conflicts.js` / `longterm.conflicts` / `longterm.resolve`
  - lesson distillation → `lib/pain.js`
  - portable Markdown → `lib/memory-markdown.js` / `longterm.exportMarkdown`
  - 零外部依赖 → `index.js` 顶部注释与 `package.json`（只依赖 `node:` builtins）
- 不要在描述里写 star 数、下载量或「最好/最快」之类营销词，评审明确拒收。
