# v4 + asar embedding 隔离验证报告

> 日期：2026-11-08 · 环境：隔离目录 `_v4-isolation`（与 DSH profile 完全分离）

## 结论摘要

| 项 | 结果 |
|---|---|
| `@huggingface/transformers@4.3.2` 导入 | ✅ 成功 |
| 纯文本 pipeline（离线） | ✅ 成功，`dtype=q8` |
| 向量维度 | 768 |
| 语义区分能力 | ✅ 相关 0.5209 vs 无关 0.2463，差距 0.2746 |
| 进程内加载 sharp/vips | ✅ **NONE**（关键：纯文本不碰图像路径） |
| 模型文件 | `onnx/model_quantized.onnx`（103 MB，需显式 `dtype:'q8'`） |

## 与 v2 的关键差异

| | `@xenova/transformers@2.17.2`（现用） | `@huggingface/transformers@4.3.2` |
|---|---|---|
| sharp 要求 | `^0.32.0` | **`^0.35.4`** |
| 与 DSH 自带 0.35.5 | ❌ 不兼容（0.32 ≠ 0.35） | ✅ **同版本区间** |
| libvips 冲突风险 | 高（8.14.5 vs 8.18.7 同名 DLL） | 低（版本一致，不会争抢） |

**这是 v4 最重要的价值**：它的 sharp 版本要求与 DSH 内置的完全一致，
不存在「两个不同版本的同名 libvips-42.dll 在同一进程按名去重」的问题。

## 实测命令与输出（可复现）

```
cd _v4-isolation
node probe.mjs
```

关键输出：
```
=== 1. import v4 ===
  version: 4.3.2
=== 2. is sharp reachable from here? ===
  sharp NOT resolvable (this is fine for text-only): ERR_MODULE_NOT_FOUND
=== 3. can we build a feature-extraction pipeline, fully offline? ===
  pipeline created OK with dtype=q8
=== 4. embed two semantically-related but lexically-different texts ===
  dims: 768
  sim(rollback-ish, snapshot-ish) = 0.5209   <- should be HIGH
  sim(rollback-ish, lunch)        = 0.2463   <- should be LOW
  separation: 0.2746
  PASS: semantically related pair scores clearly higher
=== 5. did any sharp/vips get loaded into THIS process? ===
  sharp/vips modules loaded: NONE
```

## 未完成的验证（诚实记录）

**在 DSH 的 `nodeLinker: hoisted` 布局下能否同样安全，尚未实测生效。**
我尝试把 sharp 复制到隔离目录顶层模拟 hoisted，但复制方式不完整，
`sharp` 仍报 `ERR_MODULE_NOT_FOUND`，因此那次测试**不能作为 hoisted 场景的证据**。

真正的 hoisted 验证需要在 DSH profile 里实际安装 v4 —— 那会改动你的运行环境，
按约定必须你先确认。基于「v4 要求 sharp ^0.35.4 == DSH 自带 0.35.5」这一事实，
**预期是安全的**，但预期不等于实测。

## 建议的后续步骤（需你确认后才做）

1. 在 profile 里装 `@huggingface/transformers@4.3.2`（会拉 onnxruntime-node 约 113 MB）
2. 改 `lib/embeddings.js`：优先尝试 v4，失败回退 v2
3. 用 `tools/probe-recall*.mjs` 三套查询做 A/B，比较纯词法 vs +dense 的 MRR
4. 若 MRR 提升不足 0.05，不值得引入 113 MB 依赖和 native 风险，保持纯词法

## 相关事实（本次实测）

- 模型目录：`D:\AI agent cache\dsh\models\bge-base-zh-v1.5`
- 只有量化版权重：`onnx/model_quantized.onnx`
- 必须显式传 `dtype:'q8'`，否则默认找 `model.onnx` 而失败
- DSH 的 `app.asar` 内部含 `sharp` 主包（偏移 8388408），但普通 Node 无法 require（`MODULE_NOT_FOUND`）