# verified 验收对拍协议（2026-10-08）

目标：把 `coverage/features/<area>.json` 中 scope=baseline 的行从 `implemented` 提升为 `verified`，依据是「同版本网页/MCP 对拍证据」。本协议是各域验收代理的共同约定。

## 判定口径

依据复核文档与实施方案 D9：

- 每条 `acceptance.cases` 必须有可复现的对拍证明；**全部 case PASS 才能把该行 status 改为 verified**。
- 任何 case 失败或无法取证 → 该行保持 `implemented`，在证据文件里如实记录，不得硬改状态。
- 涉及视觉、GPU、剪贴板/平台分享、真实外部成功路径的 case **必须真实浏览器取证**，Node 冒烟不算过。

## 三种取证方法

### A. 浏览器对拍（默认方法，适用于一切可evaluate的路径）

同一份存档种子，两侧同输入比对：

1. **网页侧**：MCP 服务器 `get_runtime_capabilities`/`browser` 工具启动受管浏览器，加载仓库根 `dist/` 构建站点（与代码同版本）。种子方式照抄 `smoke-browser.mjs`（把 sample-save 副本写入页面 localStorage['state'] 再刷新）。参考值从 `page.evaluate` 取——网页把上游核心模块挂在 `window.__HSR_DEBUG`（SaveState、StatCalculator、RelicScorer、RelicAugmenter、workerPool、Metadata、Constants、RelicFilters、Renderer、Message、populateAllCharacters…），M8 另有 `window.__HSR_FULL_SYNC`。也可以读页面 UI 实际渲染出的值。
2. **MCP 侧**：stdio 起服务器（`StdioClientTransport`，`HSR_MCP_STATE_FILE`/`HSR_MCP_ARTIFACTS_DIR` 指到各自临时目录——照抄 `parity.mjs`），`load_save` 同一份存档副本，调同一工具。
3. 比对：结构化字段逐项相等（数值列用 `Object.is` 级别比较；浮点容差仅当上游本身有随机/时序差异时才允许，须注明）。

### B. 进程内直连对拍（D9 口径，optimize 类重计算可用 `dist/parityRef.js` 既有通道）

MCP stdio 结果 vs 以完全相同的规范化输入直喂上游引擎，逐行比对（`parity.mjs` 的 (b) 段模式）。仅当浏览器路径明显不可行时用，须在证据里注明 "inprocess-parity"。

### C. 冒烟引用（仅辅助）

既有冒烟断言可以佐证，但**不能单独**作为 verified 证据；只能和 A/B 并列引用。

## 环境与安全约束

- 禁止改动：`mcp/src/**`、`mcp/dist/**`（不得重建）、根 `dist/**`、`coverage/features.json`（清单）、`coverage/summary.md`、README。发现问题记录到报告里，不要自行修服务器。
- 一切持久状态（HSR_MCP_STATE_FILE、artifacts、存档副本）放 `mkdtempSync` 临时目录，结束删除。绝不写 `src/data/sample-save.json`、`profile/**`。
- 受管浏览器用完 `browser action=close`；脚本结束前清理。
- 重计算 case 控制规模（resultsLimit 小值/及早 cancel），避免与并行代理抢满 CPU；需要全量确定性结果的除外。

## 产出物（每个域）

1. `mcp/scripts/verify-<area>.mjs` —— 可重复执行的对拍脚本（stdio + 临时目录模式，输出每 case PASS/FAIL）。
2. `mcp/coverage/evidence/<area>.json` —— 结构化证据：
   ```json
   {
     "area": "warp",
     "generatedAt": "2026-10-08T...",
     "gitCommit": "<git rev-parse HEAD>",
     "cases": [
       {
         "feature": "warp.plan.simple", "case": 1, "desc": "<原文前40字>",
         "method": "browser-parity | inprocess-parity",
         "result": "PASS | FAIL | UNPROVEN",
         "detail": "<关键数值/两侧差异摘要，一行为限>",
         "script": "mcp/scripts/verify-warp.mjs"
       }
     ]
   }
   ```
3. 修改 `mcp/coverage/features/<area>.json`：全 case PASS 的行 `mcp.status` → `"verified"`，并加 `acceptance.evidence`：
   `["mcp/coverage/evidence/<area>.json#<featureId> cases <通过的编号列表> PASS 2026-10-08 (<method>)"]`
   未全过的行不动 status；若发现描述与实际行为不符（清单 bug），记录在报告里，不改 case 原文。

## 校验

改完自己的 area JSON 后跑 `node scripts/coverage-check.mjs`，**唯一允许的失败是 `coverage/summary.md is stale`**（汇总由协调者统一重生成）；其他任何 FAIL 都必须修掉。注意 schema 是 `.strict()`：不要增删字段，evidence 是 acceptance 下的字符串数组。
