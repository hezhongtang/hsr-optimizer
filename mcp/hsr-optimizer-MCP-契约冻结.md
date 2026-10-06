# HSR Optimizer MCP 契约冻结

日期：2026-10-06。基线：`feat/mcp-server` / `c6d97011`。地位：全站覆盖计划 §5 S0 交付物——把 M1–M3 已交付面与 S0 候选的命名、参数、数值口径、错误结构、资源布局和兼容规则冻结成文。此后对任一冻结项的修改都按 §8 兼容策略执行并更新本文。

## 1. 工具命名

- 语法：`^[a-z][a-z0-9_]*$`（允许数字，如 `benchmark_top100` 类命名必须可注册且被覆盖校验看见）。`coverage-check.mjs` 的注册扫描与此语法一致。
- 风格：动词_域或域_动词（`load_save`、`equip_build`、`score_relics`），一条用户动作一个工具。
- 合并式域工具：当一族动作天然属于同一域且参数同构时，用单工具 + 枚举切子域参数——已落地的 `section` 形态（`get_state(section=…)`/`update_state(section=…)`）与候选 `action` 形态（`scanner(action=connect|disconnect|status|events)`、`manage_team`、`update_form`、`debug_utility`）同构；新增子域优先扩枚举值而非新工具。
- 已冻结：48 个已注册工具名（`coverage/summary.md` 工具面段落为权威清单）与 12 个候选名。新候选入册必须先落 `coverage/features/*.json` 的 `candidates` 字段，`toolBudget=70` 由 `coverage-check.mjs` 强制（当前 48+12=60）。

## 2. 参数格式

- 命名 camelCase，zod schema 校验，`.describe()` 中文说明。
- 通用参数约定：分页 `offset`/`limit`（`list_*` 系）；`dryRun` 显式布尔只用于导入类；破坏性操作用显式布尔（`overwrite`）而非默认放行。
- 覆盖已注册工具的能力扩展用可选参数表达，在清单里写成 `tool(param=...)` 形式（如 `export_save(structured=true)`、`permutations(applyFixes=true)`），不新开同名替代工具。
- ID 口径：`characterId`、`lightConeId` 等一律用上游游戏内 id 字符串；套装/词条名用 zh_CN 显示名（与 `game://metadata` 资源一致）。

## 3. 返回结构

- 双通道（`src/toolResult.ts`，全工具强制）：`content` 一段中文文本摘要 + `structuredContent` 完整机器载荷；48 个工具全部声明 `outputSchema`，新增工具必须带。
- 载荷顶层是平铺字段（`total`/`rows`/`score`…），大结果用分页或引用，不一次塞满响应。

## 4. 数值与百分比口径

- 百分比类一律小数 0–1：评分权重 `min(0).max(1)`（`equipment.ts` set_scoring_override）；模拟评分 `percent` 以 1.0=基准线（`serializers/scoring.ts`）。
- 引擎 stats 原样透出不四舍五入：键复用上游 Stats 名（`'HP%'`、`'CRIT Rate'`），值按引擎 Float32/Float64 精度（`serializers/stats.ts`：0.05 即 5%）。显示层百分比换算由调用方做。
- 排列组合数等大整数按 number 透出（引擎口径），不用字符串。

## 5. 错误结构

- 工具内 `throw new Error(message)` → SDK 返回 `isError: true` + 消息文本；消息为可操作中文，含来源、期望与实际（如 `Invalid save data from …: expected … (got …)`，`archive.ts` parseSave）。
- 结构化载荷不嵌 error 字段；业务性拒绝用显式布尔/对象标志：`overwrote: false`（save_build 对不存在名称的宽松覆盖）、`blockedWipe`/`save_status.blockedWrite`（防擦写护栏）、`skipped` 数组（装备缺失跳过）。
- 参数校验错误由 zod/SDK 生成，不自行包装。

## 6. 资源布局

- `game://` 一律游戏数据：`game://metadata/characters|lightcones|sets`、`game://changelog`，详情模板 `game://metadata/characters/{id}`、`game://metadata/lightcones/{id}`；候选 `game://metadata/scoring`。
- `site://` 一律站点内容（待建）：`site://home|links|pages|settings|help/{topic}|capabilities`。
- 资源只读；可变状态走工具。

## 7. 兼容策略

- 已注册 48 工具的参数名、类型与默认值冻结：新行为走可选参数、显式模式（如 `warp_plan(applyPlannerMode=true)` 复刻网页 simple 行为而不改默认计算）或新工具，绝不静默改旧默认值。
- 输出只加字段不删不改语义；确需破坏性变更时新开工具名，旧工具标注弃用期。
- 网页行为与 MCP 行为存在合理分歧时（如 save_build 的 overwrite 宽松语义），登记在对应 feature 行 `gaps`，不为复刻 UI 容错放宽 API 校验（全站覆盖计划 §4.1）。

## 8. 冻结变更流程

修改任一冻结项须同步四处并过全部门禁：①`coverage/features/*.json`（候选/参数/状态）→ ②`README.md` 工具清单 → ③本文（记录变更）→ ④`coverage-check` + 四门禁 + smoke 全绿。

## 9. 变更记录

- **2026-10-06 M4**：注册 4 个新工具 `get_state`/`update_state`/`get_job`/`cancel_job`（44→48）；`export_save` 落地冻结时登记的候选参数 `structured=true`（只读结构化快照）；候选清单 16→12（四个 get_state 系与 get_job/cancel_job 转正、export_save(structured) 已落地移除、site://settings 改由 update_state 的 settings 分支承接后从候选移除）；§1 补 `section` 枚举先例。`save_status` 输出加 `revision`/`generation` 字段（只加字段）。
