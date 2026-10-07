# HSR Optimizer MCP 契约冻结

日期：2026-10-06。基线：`feat/mcp-server` / `c6d97011`。地位：全站覆盖计划 §5 S0 交付物——把 M1–M3 已交付面与 S0 候选的命名、参数、数值口径、错误结构、资源布局和兼容规则冻结成文。此后对任一冻结项的修改都按 §8 兼容策略执行并更新本文。

## 1. 工具命名

- 语法：`^[a-z][a-z0-9_]*$`（允许数字，如 `benchmark_top100` 类命名必须可注册且被覆盖校验看见）。`coverage-check.mjs` 的注册扫描与此语法一致。
- 风格：动词_域或域_动词（`load_save`、`equip_build`、`score_relics`），一条用户动作一个工具。
- 合并式域工具：当一族动作天然属于同一域且参数同构时，用单工具 + 枚举切子域参数——已落地的 `section` 形态（`get_state(section=…)`/`update_state(section=…)`，M5 扩 `showcase` 枚举值）与已落地的 `action` 形态（`manage_team(action=load|delete|move|compose|sync_benchmarks|get)`）同构；`update_form` 采用「单工具 + 具名子载荷参数」（`patch`/`preset`/`reset`/`combo`/`teammates`/`statSimulations`/`fromBuild`/`characterId`）而非 action 枚举，因各子载荷形状异构；候选 `scanner(action=…)`、`debug_utility` 沿用 action 形态。新增子域优先扩枚举值或子载荷参数而非新工具。
- 已冻结：56 个已注册工具名（`coverage/summary.md` 工具面段落为权威清单）与 4 个候选名。新候选入册必须先落 `coverage/features/*.json` 的 `candidates` 字段，`toolBudget=70` 由 `coverage-check.mjs` 强制（当前 56+4=60）。

## 2. 参数格式

- 命名 camelCase，zod schema 校验，`.describe()` 中文说明。
- 通用参数约定：分页 `offset`/`limit`（`list_*` 系）；`dryRun` 显式布尔用于导入类与写路径的只读演练（`import_scanner_json(dryRun)`、`upsert_relic(dryRun)`——语义同为「完整校验+计算变更但不写入」）；破坏性操作用显式布尔（`overwrite`）而非默认放行。
- 覆盖已注册工具的能力扩展用可选参数表达，在清单里写成 `tool(param=...)` 形式（如 `export_save(structured=true)`、`permutations(applyFixes=true)`），不新开同名替代工具。
- ID 口径：`characterId`、`lightConeId` 等一律用上游游戏内 id 字符串；套装/词条名用上游内部英文名（如 `Musketeer of Wild Wheat`、`CRIT DMG`）——与 `serializeRelic`、套装注册表（`SetsRelicsNames`/`SetsOrnamentsNames`）及 `list_relics`/`score_relics` 既有筛选口径一致（自冻结起实现即为此口径，2026-10-07 勘误：原文「zh_CN 显示名」与代码不符）。zh_CN 显示名由 `game://metadata/sets` 的 `nameZh` 及各资源的中文名字段提供。

## 3. 返回结构

- 双通道（`src/toolResult.ts`，全工具强制）：`content` 一段中文文本摘要 + `structuredContent` 完整机器载荷；56 个工具全部声明 `outputSchema`，新增工具必须带。
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

- 已注册 56 工具的参数名、类型与默认值冻结：新行为走可选参数、显式模式（如 `warp_plan(applyPlannerMode=true)` 复刻网页 simple 行为而不改默认计算）或新工具，绝不静默改旧默认值。
- 输出只加字段不删不改语义；确需破坏性变更时新开工具名，旧工具标注弃用期。
- 网页行为与 MCP 行为存在合理分歧时（如 save_build 的 overwrite 宽松语义），登记在对应 feature 行 `gaps`，不为复刻 UI 容错放宽 API 校验（全站覆盖计划 §4.1）。

## 8. 冻结变更流程

修改任一冻结项须同步四处并过全部门禁：①`coverage/features/*.json`（候选/参数/状态）→ ②`README.md` 工具清单 → ③本文（记录变更）→ ④`coverage-check` + 四门禁 + smoke 全绿。

## 9. 变更记录

- **2026-10-06 M4**：注册 4 个新工具 `get_state`/`update_state`/`get_job`/`cancel_job`（44→48）；`export_save` 落地冻结时登记的候选参数 `structured=true`（只读结构化快照）；候选清单 16→12（四个 get_state 系与 get_job/cancel_job 转正、export_save(structured) 已落地移除、site://settings 改由 update_state 的 settings 分支承接后从候选移除）；§1 补 `section` 枚举先例。`save_status` 输出加 `revision`/`generation` 字段（只加字段）。
- **2026-10-07 M5**：注册 4 个新工具 `upsert_relic`/`delete_relics`/`update_form`/`manage_team`（48→52），候选清单 12→8（四个候选名转正）。落地候选参数：`get_form(expandCombo=true)`、`default_form(spdPreset=…)`、`describe_conditionals(includeAbilities=true, includeSets=true)`、`stat_simulate(saved=true|fromCache=…|fromRelicIds=…)`（`simulations` 转 optional）、`save_team(benchmarkSnapshot=true)`、`delete_build(all=true)`、`equip_saved_build(applyScoringTeam=true)`、`set_character_rank(sortBy=effectiveSubstats)`、`set_scoring_override(traces=…)`、`update_state/get_state` 扩 `section=showcase`。§1 记录 `update_form` 的具名子载荷形态与 `manage_team` 的 action 枚举先例；manage_team 额外提供只读 `action=get`。清单 41 行转 implemented（44→85），遗留候选参数 `optimize(resultsLimit=65536)` 仍挂 `optimizer.form.target` 行。
- **2026-10-07 M6 复核修复**（五回只读复核 + 探针实证后落盘；分析路复核超时未回，其面由契约/冒烟两路部分覆盖）：①`scanner` 跃迁同步补全为 useWarpScannerSync 三条全链——UpdateMaterials→专票折算（专票+floor(未熄星芒/20)）、GachaResult→垫抽/必中（AddPity 累加、ResetPity 重置+guarantee，按卡池类型分字段）、InitialScan→gacha/materials 资源同步（emitScannerEvents 对应物），门=ingest∧ingestWarpResources；原「GachaResult 按网站行为忽略」表述纠正为「抽卡历史不落库（网站同款），跃迁同步真实存在」；②`update_state(section=scanner)` 打开开关时按上游 setter 重放语义执行（scannerStore.ts:164-228）：已连接时开 ingest/角色开关→buildFullScanData 重放完整导入、开 ingestWarpResources→重发资源；输出加 `replayed` 字段；③`score_character/dps_score` 补 resolveEffectiveDeprioritizeBuffs（副 C 默认角色在无真输出位队友的队伍里按主 C 评分，回显生效值）；④score_relics rangePotential 四指标独立取最大（对齐 potentialAllAll 列口径，bestCharacterId 仅标 bestPct 归属）；⑤set_scoring_override：configs 的 deprioritizeBuffs 支持校验移到任何写入之前（修复 buffer+editTeammate+deprioritizeBuffs 组合先写后抛）、editTeammate 省略套装字段保留该槽位现有套装（显式 null 才清除）；⑥warp_plan(normalizeTargets) 仅光锥行不再隐式带 E6 星魂目标（addLcGoal 语义，期望抽数不再虚增 ~10 倍）；⑦leaderboard：search 匹配域=当前渲染语言角色名+characterId（中文可搜，id 命中为显式补充）、characters Map 按清单序插入（平局名次确定）、timeline 瞬时失败不缓存（可重试）、board 报错文案改为 MCP 自身语义、my_ranks 按 mergedCharacterIds 过滤、entry 畸形 fetchedAt 守卫；⑧calc_ehr 的 effectRes/debuffRes 收紧到网页下拉枚举域；⑨optimize(applyFixes) 的表单装载移入 withChange 作用域（冲突/失败不再泄漏 request store）；⑩load_save 对齐网页手动载入安全语义——不恢复存档携带的 customUrl 扫描地址（import.save.load 的 gaps 承诺兑现）；⑪fetch_showcase.uid 放宽为 nullable 记为内联路径例外；⑫杂项文案勘误（dps_score 自定义队伍入口、build+teammates 优先级、linkFlatAndPercent 非联动差异、excludedRelicPotentialCharacters 持久性、showcase 缓存清单）。冒烟：smoke-scanner 补跃迁同步/重放/竞态 settle（DeleteLightCones 帧统计 ~50% 假失败修复）、smoke-score syncTeam 逐位读回、smoke-leaderboard 去重可证伪 fixture+中文搜索、smoke-calculators 光锥行里程碑、smoke-archive 手动载入不应用 customUrl。
- **2026-10-07 M6**：注册 4 个新工具 `scanner`（action=connect|disconnect|status|events，MCP 作为 ws 客户端外连真实扫描器，事件按 scannerStore 同链应用，GachaResult 按网站行为忽略）、`score_character`（source=roster|build|showcase 四配置 DPS/BUFFER/HEAL/SHIELD，临时队伍/速度基准/deprioritizeBuffs/trace 增益汇总）、`leaderboard`（view=characters|board|entry|timeline|my_ranks，显式数据来源+缓存版本，失败不作空榜成功）、`analyze_relic`（view=characters|location|reroll）（52→56），候选清单 8→4（render/deliver_artifact/get_runtime_capabilities/debug_utility 留 M7+）。新资源 `game://metadata/scoring`（评分元数据六面板）。落地候选参数：`import_scanner_json/import_hoyolab(includeCharacters=false)`、`set_scoring_override(configs=…/resetAll=true/linkFlatAndPercent=true)`、`score_relics(scope=…/rollsSummary=true)`、`list_relics(sortBy=…)`、`fetch_showcase(remember=true)`、`calc_aha(desiredAha=…/save=true/fromSaved=true)`、`calc_ehr(mode=probability|grid)`、`warp_plan(applyPlannerMode/normalizeTargets/save=true)`、`optimize(validate/diagnose/applyFixes/resultsLimit≤65536)`、`get_results(rowIds=…)`、`benchmark_runs(sweep=sets)`、`update_state/get_state(session)` 扩 `language` 字段（ephemeral 块，写 i18next 检测器同款缓存键）、`load_save(sample=true)`。清单 60 行转 implemented/收窄（详见 summary.md），`optimizer.engine.select`/`leaderboard.entry.read` 留 partial（GPU 执行与榜单卡渲染属 M7）。smoke:all 扩到 24 套（新增 smoke-scanner/score/leaderboard/calculators/analysis）。
- **2026-10-07 M5 六路复核修复**（read-only 复核 + 探针实证后落盘）：①`update_form` 步骤①按会话指针播种 `useOptimizerDisplayStore.statSimulations`——修复切换角色时离开角色已存假想配装列表被 display store 陈旧/空列表整体抹掉并落盘的 P0；②队友换光锥改经上游 `updateTeammate` 换锥分支（条件重置为新锥默认，旧条件键不再残留）；③`patch.weights` 旧键 `topPercent` 由「警告但照写」改为真正剥离；④`combo.edits` 的 `index`/`partitionIndex` 增上界校验（防越界写出稀疏数组后 `get_form(expandCombo)` 永久报错），矩阵序列化对存量 null 洞截断容错；⑤`save_team` 整体入 `withChange` + 可选 `baseRevision`，未拥有成员带 `benchmarkSnapshot` 时先行报错（不再「失败却补进幽灵角色」），内容零变化不再递增 revision；⑥`manage_team` 的 load/delete/move 预校验与队伍表读取移入作用域内（同批交错不再读到陈旧表/内部 TypeError），set_slot 的 roster 差值改在 body 内计算；⑦`save_build` 按上游 `buildService` 读取按角色展示偏好 `showcasePreferences.scoringType`（与 `update_state(section=showcase)` 同一落盘键）；⑧`set_scoring_override` 的 `reset` 与 `weights`/`parts` 互斥（与 traces 同款）；⑨`export_save` 写入载入路径后复位 `dirty`/`blockedWrite`（刻意的空库存持久化后 `save_status` 不再持续报警）；⑩`upsert_relic`：预览副词条数值 0 按 upstream 有效行为拒绝、存量「部位×套装类型」错配数据未触碰部位时报错而非静默换套装、`dryRun` 新建 id 不保留写入描述。§2 勘误两处（套装/词条名口径为上游内部英文名；`dryRun` 扩及写路径演练）。
