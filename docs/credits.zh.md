# 用 WorkBuddy 和 Trae 的积分跑 DSH

这两个插件是**模型供应商**，不是自动化通道。它们让你在 DSH 会话里直接消耗 WorkBuddy、Trae 桌面端已经付过费的
积分，于是同一个 Agent 可以在 DeepSeek 自有账号、WorkBuddy 积分、Trae 积分之间切换，而不用离开 DSH。

它们是独立包，**不在 `dsh-session-suite` 里**：

```bash
dsh plugin --profile desktop install dsh-workbuddy-connect@0.7.9
dsh plugin --profile desktop install dsh-connect-trae
```

## 它们到底做了什么

| 插件 | 给 DSH 增加什么 | 前提 |
|---|---|---|
| `dsh-workbuddy-connect` | 模型选择器里的 WorkBuddy 分组 | 已安装并登录 WorkBuddy 桌面端 |
| `dsh-connect-trae` | Trae 的三个分组（CN / 企业 / 国际） | 已安装并登录 Trae 桌面端 |

两者都复用桌面端**已有的登录状态**，不复制 API Key，应用本身仍然掌握自己的账号；在应用里切换账号会被自动识别。

## WorkBuddy

本机安装在 `D:\AI app\Workbuddy` 并已登录。插件能发现它、读到账号，并发布模型目录；实测列出了 16 个模型，
包括 100 万上下文的 `DeepSeek-V4.1-Flash`、`GLM-5.3`、`Hy4 preview`，每个都带积分费率。

几点说明：

* 插件的默认查找路径是 `%LOCALAPPDATA%\Programs\WorkBuddy\WorkBuddy.exe`；装在别处通常也能用，因为它同时读应用
  自己的心跳与存储；个别机器布局异常时，可在插件配置里把 `authFile` 指到应用的认证文件；
* 模型目录缓存位于 `~/.dsh/.workbuddy-catalog.json`；
* 积分由应用自己的计费体系扣除，DSH 只显示费率。

## Trae

插件读取 Trae 的 `storage.json`（CN 版在 `%APPDATA%\Trae CN\User\globalStorage\storage.json`），其中带有
`iCubeAuthInfo` 条目，并据此暴露账号下的模型和积分概览。

## 它不是调度器

这两个插件不会把 DSH 变成这两个 App 的调度中枢：它们不向 Trae 下发任务、不驱动 WorkBuddy 的界面、也读不到它们的
对话历史，只是把**模型**接进 DSH。若要做「DSH 指挥 Trae / WorkBuddy 执行任务」，需要 MCP 服务或终端自动化桥接，
属于另一类集成，不在本仓库范围内。

## 版本兼容

`dsh-workbuddy-connect@0.7.9` 把 `@deepseek-ai/dsh-*` 依赖精确钉在 `0.2.1-rc.2`，而这里的桌面端是 `0.2.1-rc.5`，
安装需要显式的精确版本豁免。它能跑，但请把它当作已接受的风险：DSH 升级时这对版本要一起钉住。

`dsh-connect-trae` 用的是区间依赖（`>=0.1.7-rc.1 <0.3.0-0`），无需豁免即可安装。
