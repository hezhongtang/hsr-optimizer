# HSR Optimizer MCP 实施方案

- **日期**:2026-10-05
- **输入**:《MCP 化调研报告》(b9efcdc7)、可行性实测 spike(81f0789a,本分支)、三份全库探索报告(功能盘点 / 数据面盘点 / 浏览器耦合与同步通道审计,2026-10-05 重做)
- **目标**:一个 MCP server,让 agent 在会话中通过对话完成 optimizer 的**全部用户功能**,并拿到**完整数据**——既包括程序计算的输出,也包括留给 agent 自己计算、分析、搭配方案所需的原始输入。

---

## 1. 总判定

**可行,且比调研报告预估的更省事。** 两个关键前提已由实测(而非静态推断)证实:

1. 上游代码可以**原样**在 Node 无头运行:约 10 行浏览器全局垫片后,store / service / 导入器 / 存档层全部加载成功(spike S1–S4、S7–S9,16/16 阶段通过)。
2. **不需要重写 Engine A 调度器**:上游原版 `Optimizer.optimize` 经 `?worker → node:worker_threads` 适配层即可无头运行,与手工镜像逐行对拍 1024 行结果完全一致(spike P1)。调研报告设想的"新写 ~100 行调度循环"仅留作参考实现。

新写代码的真正大头是:**MCP 工具层 + 结果序列化器 + i18n Node 引导**,而不是引擎。

---

## 2. 调研报告勘误与补强

实测与探索对报告做如下修正(报告的文件定位与架构结论全部有效):

| # | 报告原结论                                             | 实测/探索修正                                                                                                                                                                                                                                                               |
| - | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 | "store 为 vanilla 实现,Node 中可直接调用"              | **不成立**。`appStore` 创建链读 `window.location.hash`、`localStorage`、`window.history`(navigation/constants.ts:90-92、parseHash.ts),不加垫片整个 store/service 层导入即崩。垫片约 10 行,已沉淀在 `mcp/spike/shims.ts`                                                     |
| 2 | 需要新写 Engine A headless 调度器(~100 行)             | **不必**。原版 `Optimizer.optimize` 可无头运行且结果与镜像 100% 一致;镜像(`mcp/spike/engineA.ts`)降级为对拍工具                                                                                                                                                             |
| 3 | (未提及)性能是产品级边界                               | 9 线程稳态约 **97 万排列/秒**(1944 遗器库存);默认过滤下搜索空间约 **1.4e12**,CPU 穷举不现实。网页端默认引擎是 **WebGPU**,报告未提。MCP 必须靠约束收敛 + 进度 + 取消管理预期                                                                                                 |
| 4 | "websocket 零改动通道可推库存/配装变更"                | **高估**。增量 `UpdateRelics`/`DeleteRelics` **只处理 5★**;需用户开 4 个开关;严格单向;`InitialScan` 是**整库替换**且角色强制 80 级/LC 80 级;断线重连后客户端清空缓冲,服务端必须重发全量(详见 §6.3)                                                                          |
| 5 | (未提及)mergeRelics 语义                               | `persistenceService.mergeRelics` 是**整库替换**:导入只含 1 件遗器的扫描文件,库存从 162 变 1(spike S9 实测)。MCP 导入工具必须包装出真"合并"语义或显式警告                                                                                                                    |
| 6 | "conditionals 技能数值编码在 TS 里,后台须走 TS 运行时" | 正确,且更好:`src/lib/conditionals/**` 与 `src/lib/sets/**` **零 React 依赖**,`content()`/`defaults()` 是纯数据,条件选项**完全可枚举序列化**;唯一缺口是 labels 走 i18next(见 #7)                                                                                             |
| 7 | (未提及)i18n                                           | 引擎路径从不执行 `src/lib/i18n/i18n.ts`(statsConfig 对它只有 type-only import);leaderboard 以 `withContent=false` 空串模式跑。**带中文标签**枚举条件/套装/角色名需要 MCP 自建 i18next 资源:用 js-yaml 直接读 `public/locales/zh_CN/*.yaml` 注册进 i18next,绕开 http-backend |
| 8 | (未提及)worker 面                                      | 全库只有 3 处 `?worker` 导入:`baseWorker`(适配层已验证)、`scoreRelicsWorker`(同样模式适配)、`colorExtractionWorker`(OffscreenCanvas,UI-only,**排除**)。`workerPool` 池大小在单例构造时读 `navigator.hardwareConcurrency` → 必须在首次导入前垫 `os.availableParallelism()`   |
| 9 | (未提及)结果可序列化性                                 | `OptimizerDisplayData` 行本身是纯数值(可 JSON);但 `SimulationScore`/`ComputedStatsContainer` 内嵌 `Float64Array`/闭包,需要自写归约器(§4.3)                                                                                                                                  |

---

## 3. 功能覆盖:web 功能 → MCP 工具面

探索盘点了全部 13 个 tab(含隐藏的 WebGPU/Metadata 测试页)与全部 overlay 工作流。除下文"排除清单"外,**所有功能的核心逻辑都是 store action / service / 纯函数**,可无头调用。工具面按域组织(约 30 个工具 + 2 类 resource):

### 3.1 存档与导入

| 工具                                                   | 底层                                                                                          | 备注                                                                                         |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `load_save`(路径或 JSON)                               | `persistenceService.loadSaveData`(含全部迁移链:novaflare、main-stat 迁移、build 迁移、重互链) | 磁盘 save 文件为真源;直调绕开 localStorage                                                   |
| `export_save`(→ 文件/JSON)                             | `SaveState.save()` 返回字符串                                                                 | 文件后端持久化 shim(§5.4)                                                                    |
| `reset_all`                                            | `persistenceService.resetAll`                                                                 |                                                                                              |
| `import_scanner_json`(kelz v4 / reliquary v4 / yas v3) | 解析器纯函数 + `mergeRelics`                                                                  | **必须包装合并语义**:按 hash 并集合并,非整库替换(勘误 #5);支持 `existingCharactersOnly` 选项 |
| `import_hoyolab`                                       | `hoyolabParser`                                                                               |                                                                                              |

### 3.2 查询(输入数据面)

| 工具                                                              | 底层                                          | 备注                                                                                                          |
| ----------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `list_characters` / `get_character`                               | characterStore                                | 含 equipped、form、saved builds、评分覆盖                                                                     |
| `list_relics`(结构化筛选:部件/套装/词条/强化/星级/归属)           | relicStore + 遗器筛选                         | 每件附带 roll 反解(`RelicRollGrader`,存档不落盘、加载时重算)                                                  |
| `describe_conditionals(characterId, eidolon \| lcId, s)`          | resolver `withContent=true`                   | **agent 自主填条件的关键**:返回开关/滑条/下拉的完整定义(枚举值、默认值、e 阶门槛);需 §5.5 i18n 引导出中文标签 |
| `get_form(characterId)` / `default_form(characterId, lcId, e, s)` | `computeLoadForm` / `generateFullDefaultForm` | agent 组请求的起点                                                                                            |
| `permutations(form)`                                              | `getFilteredRelicCounts` + set solver         | 搜索前估算,配 `optimize` 的规模闸门(§6.1)                                                                     |

### 3.3 优化与模拟(核心计算面)

| 工具                                         | 底层                                                                                   | 备注                                                                                                                                                                                                                    |
| -------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `optimize(form overrides)`                   | 原版 `Optimizer.optimize` + worker_threads 池(spike 适配层)                            | 进度通知(progressToken)+ 取消(AbortSignal → CANCEL flag,实测延迟 80–180ms,取消保留已得结果);返回 top-N 行 + 每行的 6 件遗器明细(row id 混合进制反解);自动附带"当前装备行"(`calculateCurrentlyEquippedRow` 的纯计算部分) |
| `stat_simulate(hypothetical builds)`         | `runStatSimulations`(纯同步,无 worker)                                                 | **agent 分析空间的核心**:任意假想配装(主词条/套装/副词条 roll 数)直接模拟,与真实搜索同口径                                                                                                                              |
| `simulate_build(build, trace?)`              | `simulateBuild(trace)`                                                                 | 单套配装复算;`trace=true` 给出逐动作伤害拆分 + buff 快照(带 `BuffSource` 来源归因:角色/光锥/套装/行迹/魂)                                                                                                               |
| `analyze_build(characterId, buildA, buildB)` | `generateAnalysisData` / `calculateStatUpgrades` / `damageSplitsExtractor`(全部纯函数) | 复刻"展开数据面板":新旧对比、伤害拆分表、逐副词条 +1 roll 升级表、队友套装升级表                                                                                                                                        |
| `benchmark_runs(form, sets×spd 预设)`        | `runCustomBenchmarkOrchestrator`(带缓存)                                               | 复刻 Benchmarks tab                                                                                                                                                                                                     |
| `dps_score(characterId, team?)`              | `prepareOrchestrator`/`executeOrchestrator`/`executeUpgradeOrchestrator`               | 实测 0.33s;返回 `SimulationScore` 归约结果(等级、百分比、基准对比、副词条/主词条/队友升级项)                                                                                                                            |
| `score_relics(characterId?, scope)`          | `scoreRelicsBatch`(纯)+ `scoreTbp`(纯,estTbp 绕开 worker 直调)                         | 当前分/潜力分(best/avg/worst)/字母等级/estTBP;实测 162 件 7ms                                                                                                                                                           |

### 3.4 装备与角色管理

| 工具                                                                | 底层                                                     |
| ------------------------------------------------------------------- | -------------------------------------------------------- |
| `equip_build(characterId, relicIds \| optimizerRowId)`              | `equipmentService.equipRelicIds`(尊重 Replace/Swap 设置) |
| `unequip` / `switch_relics(charA, charB)`                           | `unequipCharacter` / `switchRelics`                      |
| `upsert_character` / `delete_character` / `set_rank`(优先级排序)    | characterStore + `insertCharacter`                       |
| `save_build` / `list_builds` / `delete_build` / `equip_saved_build` | buildService(纯 store+持久化)                            |
| `set_scoring_override(characterId, weights/parts)`                  | scoringStore(`getScoringMetadata` 合并链)                |

### 3.5 外部数据与计算器

| 工具                    | 底层                                         | 备注                     |
| ----------------------- | -------------------------------------------- | ------------------------ |
| `fetch_showcase(uid)`   | showcaseApi(纯 fetch)+ CharacterConverter    | enka/mihomo 拉档案       |
| `import_showcase(mode)` | showcaseTabController 的导入动作             | relics / 单角色 / 多角色 |
| `warp_plan(request)`    | `calculateWarps` 全纯数学                    | 抽卡规划                 |
| `calc_aha` / `calc_ehr` | `calculateAhaSpeed` / `calculateRequiredEhr` | 纯函数                   |

### 3.6 Resources(静态面,读多改少)

- `game://metadata/characters|lightcones|sets`(含 zh_CN 名称、基础属性、行迹树、套装效果文本)
- `game://changelog`

### 3.7 明确排除(UI-only,不进 MCP)

网格渲染/渐变/分页交互、全部 modal/drawer 的呈现层、主题、截图导出、肖像裁剪(L2D/canvas/OffscreenCanvas)、spine 动画、WebGPU 测试页、团队页拖拽交互(槽位**数据**仍可经 `save_team`/`list_teams` 暴露)、home 营销内容。toasts/确认弹窗一律转为工具返回值与错误。

---

## 4. 数据面设计(agent 的分析与计算空间)

目标是"数据齐全":agent 不仅能拿到结论,还能拿到**重算与归因所需的一切**。

### 4.1 输入面(agent 可读的原始数据)

- **遗器全量**:`Relic` 完整 schema(types/relic.ts:19-40)+ 增强值(`augmentedStats`)+ roll 反解(`{high,mid,low}` 分布、`addedRolls`、`initialRolls` 3/4 条判断)。
- **角色全量**:equipped 六槽、完整 Form(含 conditionals/队友/连招 `comboStateJson`,版本 1.1)、saved builds(含条件快照)、评分覆盖。
- **存档全键**:`HsrOptimizerSaveFormat`(types/store.ts:91-120)全部 14 个键。
- **游戏元数据**:`DBMetadata` 全量——角色基础属性/行迹树/光锥叠影数值表(已转换为 Stats 键)/套装表/主副词条表 + zh_CN 名称。
- **条件系统**:全部 103 角色 + 170 光锥的条件定义(类型、枚举、默认值、e/s 门槛)。
- **连招模型**:`AbilityKind`(21 种)、`TurnAbilityName`、`HitDefinition`(倍率、dot/break/heal/shield 定义)——伤害公式的"可读形态"。

### 4.2 输出面(计算结果的全量字段)

- **优化行**:`OptimizerDisplayData` 77 列**全字段**(基础/战斗/memosprite 双口径属性、EHP/逐技能伤害/DOT/BREAK/COMBO、套装索引、WEIGHT),不是只给 COMBO 一列。
- **行→配装**:id 混合进制反解(槽位基数序 h,g,b,f,p,l)+ 六件遗器完整明细。
- **伤害拆分**:`simulateBuild(trace)` 的 `RotationDamageStep[]`(逐动作)+ `Buff[]` 快照(带 `BuffSource` 归因)。
- **评分全量**:`SimulationScore` 四组模拟对比(original/baseline/benchmark/maximum)、升级项数组、等级标尺(F→AEON);遗器当前分/潜力四分位/reroll 变体;estTBP 天数。

### 4.3 需要新写的序列化器(上游没有现成导出)

1. `describeConditionals`——resolver `withContent=true` + Node i18n 引导(见 §5.5)。
2. `ComputedStatsContainer → JSON` 归约器——属性数组(`x.a` 键名表)、动作/全局寄存器、buff 轨迹(`RunStatSimulationsResult` 内嵌 `Float64Array`/`Float32Array` 全部拍平)。
3. 行→配装序列化器——`extractCharacter` + `calculateRelicIdsFromId` + 遗器查找 + 套装名反解(`relicIndexToSetConfig`)的组合。
4. save 文件导入/导出端点(绕开 localStorage)。
5. worker 池适配层(spike 模板 + `scoreRelicsWorker` 第二个 `?worker` 别名)。
6. estTbp 直调入口(绕开 workerPool)。
7. 套装效果描述面——`game_data.json.relics[].skills` / zh_CN YAML 文本 + `gpuBasic` 结构化条目合并;其余效果数值只能经执行获得(套装 2pc/4pc 数值在 TS 函数体内,勘误 #6)。
8. buffs 分析数据面——`simulateBuild(trace)` + `context.rotationActions[].hits` 已可无头取得,仅缺 #2 的归约器。

---

## 5. 技术架构

### 5.1 构建与运行时

- **构建**:Vite SSR 模式,仿 `vite.leaderboard.config.ts` 与 `mcp/spike/vite.spike.config.ts`(`ssr: true`、`tsconfigPaths`、`publicDir: false`);插件把 2 个 `?worker` 说明符别名到 `node:worker_threads` 适配层。产物 `mcp/dist/`。挂 `npm run build:mcp`。
- **运行时**:Node ≥ 26(仓库 engines 已要求);SDK 用 **`@modelcontextprotocol/sdk` 1.32.x**(node≥18,zod 3 生态最广;2.x 尚新,暂不追)。stdio transport。
- **并行**:worker_threads 池,`min(10, os.availableParallelism()-1)`(注意:必须在首次导入 `workerPool.ts` **之前**垫 `navigator.hardwareConcurrency`,池大小在单例构造时定死)。实测 9 线程满载 RSS 约 2.3 GB,池大小默认保守(4–6)并允许配置。

### 5.2 分层

```
stdio MCP server(@modelcontextprotocol/sdk)
 ├─ 工具层     §3 工具定义(zod inputSchema + outputSchema/structuredContent)
 ├─ 序列化层   §4.3 的 8 个序列化器/适配器
 ├─ 上游服务层 mergeRelics(包装) / equipmentService / buildService / scoringStore …
 ├─ 上游引擎层 Optimizer.optimize(worker_threads 池) / simulateBuild / runStatSimulations
 │              / orchestrators / scoreRelicsBatch / scoreTbp / calculateWarps
 ├─ 上游状态层 Zustand stores(vanilla getState()) + loadSaveData / SaveState.save
 └─ 垫片层     shims(spike 沉淀)+ 文件后端 localStorage + Node i18n 引导
```

### 5.3 垫片清单(实测最小集)

`window`(含 `location.hash/href/pathname/search/origin`、`addEventListener` no-op)、`self`、`postMessage`、`history`、`matchMedia`、`requestAnimationFrame`(setImmediate 即可)、内存 `localStorage`、`navigator.hardwareConcurrency`。全部集中在入口最先执行。

### 5.4 持久化

- **真源是磁盘 save 文件**(`fribbels-optimizer-save.json` 格式)。启动时若指定 `--save <path>` 则 `loadSaveData` 载入;`export_save`/每次变更后防抖写回文件(文件后端 localStorage shim,进程重启不丢)。
- 不引入 IndexedDB(全库无使用);不与浏览器实例的 localStorage 共享——回流走 §6.3。

### 5.5 i18n Node 引导

用 js-yaml 读 `public/locales/{zh_CN,en}/` 各 namespace,`i18next.init({ resources })` 直注册,绕开 `i18next-http-backend`;此后的 `wrappedFixedT(true)` 即产出真实中文标签,`describe_conditionals`、套装描述、错误消息全部中文化。注意 SSR 配置 `publicDir: false` 不复制 locales——从仓库 checkout 路径读取(构建时把所需 YAML 作为资产带上)。

### 5.6 长任务协议

- **进度**:`ctx.mcpReq._meta.progressToken` + `ctx.mcpReq.notify('notifications/progress')`,按块汇报已搜排列数/总量与速率。
- **取消**:`extra.signal`(AbortSignal)→ `Optimizer.CANCEL` 置位 → 80–180ms 内停止并**保留已得 top-N 结果**返回(实测行为)。
- **大结果**:top-N 默认 1024 行时单次返回过大 → `optimize` 默认返回前 50 行摘要 + `totalMatched`,配 `get_results(offset, sort, filter)` 翻页取全量;行明细走 resource link 模式可选。

---

## 6. 关键决策与风险

### 6.1 性能与规模闸门(最大产品风险)

- CPU 引擎天花板约 1e6 排列/秒(9 线程)。`optimize` 工具流程:先 `permutations()` 估算 → 有效排列 **> 5e7** 时默认拒跑并返回诊断(哪些过滤在放大约束:主词条、套装、优先级、排除),要求 agent 显式收紧或 `force: true`;搜索中持续进度;随时可取消拿部分结果。
- 明确告知 agent:网页端默认 WebGPU,Node 侧为 CPU 多线程——结果**一致**(对拍已证),耗时更长。
- 套装求解器/半连接约减在计数阶段自动生效(上游现成)。

### 6.2 与网页端的一致性验收

同一存档同一 Form:MCP `optimize` 的 top-N 与网页端 CPU 引擎逐行一致(行 id 与排序值)——spike 已建立对拍方法(P1 `firstMismatch=-1`),作为每版回归测试保留。

### 6.3 网页同步桥(二期,可选,降级定位)

实测协议细节(全部有代码依据):

- 服务端在 23313 监听,推 `{"event","data"}` JSON 帧;`InitialScan` 必须 `source==='reliquary_archiver' && version===4` 否则客户端解析直接抛错;断线重连后客户端**清空缓冲**,必须重发全量。
- 增量 `UpdateRelics`/`DeleteRelics` **只认 5★**;角色更新需 `ingestCharacters` 开;`InitialScan` 整库替换 + 角色强制 80 级;严格单向。
- 用户需在网页开 4 个开关(Enable Live Import / 更新角色装备 / 仅已有角色 / 可选抽卡资源),端口冲突靠可配置 `websocketUrl` 让位真 Archiver。

**建议**:同步桥仅作为"后台→网页"的便利推送(装备变更后推一次全量 InitialScan,天然幂等且绕开 5★ 限制);**"网页→后台"的正式回流路径定为"网页导出 save 文件 → MCP `load_save`"**,不承诺实时。报告的"网页端自动同步"期望值按此调低。

### 6.4 其余风险

| 风险                          | 对策                                                                             |
| ----------------------------- | -------------------------------------------------------------------------------- |
| 上游更新破坏构建/垫片         | 锁 fork commit;`npm run build:mcp` + spike 全阶段 + 对拍作为升级门禁;定期 rebase |
| `Optimizer.optimize` 未来重构 | 对拍测试会立刻暴露;镜像调度器(engineA.ts)留作 fallback 蓝本                      |
| 内存(9 线程 2.3GB)            | 默认池 4–6;`--workers` 可配;大库存场景提示                                       |
| 假 5★/未实装内容              | 元数据 `unreleased` 标记透出给 agent                                             |
| 工具面过大稀释 agent 注意力   | 按域分组命名 + 每工具 description 写清与网页功能的对应关系                       |

---

## 7. 分期计划

**M1 —— 核心 MCP(可用闭环)**

构建骨架(SSR 配置 + SDK server + 垫片 + 文件持久化)、存档域、查询域(`list_characters/get_character/list_relics/get_form/default_form/permutations`)、`optimize`(进度/取消/翻页/规模闸门)、装备域、`score_relics`/`dps_score`。验收:真实存档对拍网页端一致;对话内完成"载入→查询→优化→装备→评分"闭环。

**M2 —— 数据面完整 + 分析能力**

§4.3 序列化器全量(`describe_conditionals` + i18n 引导、stats 归约器、行→配装、套装描述面);`stat_simulate`/`simulate_build(trace)`/`analyze_build`/`benchmark_runs`;warp/aha/ehr;`fetch_showcase`/`import_showcase`;teams 数据面。验收:agent 能自主完成"为什么这套比那套高 3%→逐动作伤害拆分→+1 roll 升级表→假想配装验证"的分析链。

**M3 —— 同步桥(可选)**

伪 Archiver ws server(§6.3 定位),装备/库存变更后向网页推全量。

**工作量粗估**:M1 ≈ 4–5 人日,M2 ≈ 3–5 人日,M3 ≈ 1 人日(spike 已把最不确定的部分清零)。

---

## 8. 落地顺序的第一步

1. 把 spike 的适配层/垫片提升为 `mcp/src/` 正式模块(spike 保留至 M1 验收后删除);
2. 搭 SSR 构建出 `mcp/dist/server.js`,先注册 3 个工具(`load_save`/`list_relics`/`optimize`)打通 stdio 全链路;
3. 以 sample-save.json 跑通后立即接真实存档对拍(§6.2),此后每加一个计算工具都带对拍。

---

## 9. 落地偏差登记(2026-10-06)

M1 已落地、评审(6 路独立复核)通过,并完成两批修复(批次一:P0+7×P1;批次二:6×P2+健壮性小修+P3 快修)。以下登记实施与原文的偏差——原文保持不动,便于追溯;编号沿用评审口径:

- **D1 导入工具顺延 M2**:§3.1 的 `import_scanner_json` / `import_hoyolab` 未随 M1 交付,顺延至 M2。落地时必须满足勘误 #5 的要求——对 `persistenceService.mergeRelics` 的整库替换语义做"按 hash 并集合并"的包装,并支持 `existingCharactersOnly` 选项。
- **D3 §5.6 大结果语义落地**:没有 `totalMatched`。`optimize` 的 `resultsLimit`(默认 50、上限 1024)**同时决定保留与返回**——引擎只保留前 N 行,返回即该保留集;`get_results(offset/limit/sortBy/filters)` 的翻页与过滤都只在这份保留集内进行。
- **D4 无 `--save` 启动参数**:§5.4 设想的启动载入通道未实现;跨进程重启的恢复通道是 `HSR_MCP_STATE_FILE`(localStorage 垫片的文件后端,上游 store 层的持久化)。这与会话内"磁盘 save 文件为真源"的语义并行:载入/换档一律走 `load_save`。
- **D5 构建入口**:为 `mcp/package.json` 的 `build` 脚本(vite SSR → `mcp/dist/index.js`),不是原文设想的根 `build:mcp` → `dist/server.js`。
- **D6 终名登记**:§3.4 的 `unequip` 落地为 `unequip_character`、`set_rank` 落地为 `set_character_rank`;`permutations` 收 `(characterId, formOverrides)` 而非完整 form;`export_save` 仅支持写文件(无 JSON 返回形态,结构化数据本就由各 get_* 工具透出)。
- **D7 outputSchema 顺延 M2**:M1 仅返回 `structuredContent`(工具面稳定后再补 zod outputSchema 声明)。
- **D9 §6.2 对拍口径**:常规回归基准是"**进程内直连同一引擎**"——`scripts/parity.mjs` 用 `dist/parityRef.js` 以与 optimize 完全相同的规范化产物直喂 `runOptimization`,逐行比对 stdio 结果,验证**封装层零漂移**;与网页端/镜像调度器的一次性对拍是 spike P1 的历史结论,不进常规回归。
- **D10 垫片为 §5.3 清单超集**:实际落地另含文件后端 localStorage(`HSR_MCP_STATE_FILE` / `HSR_MCP_HOME`)、console → stderr 重定向(stdout 专属协议帧)、`document.getElementById` 极简 stub 等,全部集中在 `src/shims.ts` 与 `src/worker/`。

M1 评审(6 路复核)与上述两批修复均已完成;已知限制与 P3 事项登记见 `README.md` 相应章节。

---

## 10. M2/M3 落地偏差登记(2026-10)

M2/M3 已落地并通过门禁(tsgo / oxlint / dprint / build / 九份冒烟套件全绿)。以下登记与 §3–§7 原文的偏差——原文保持不动,便于追溯;编号接续 §9:

- **D11 导入合并语义的实际包装(D1 / 勘误 #5)**:没有给 `mergeRelics` 打补丁。`union`(默认)在调用前按 `hashRelic` 把现有库存分桶,导入件逐件消耗命中桶,把「导入件 + 未被覆盖的旧件」合成完整并集清单后**走同一个上游 `mergeRelics`**(角色/装备/builds 引用改链全部复用上游);`replace` 是裸调用。并集清单意外小于现有库存时拒绝落盘(导入层防擦写守卫,`flushSave` 的护栏仍是第二层)。hash 命中语义照上游:verified 导入件覆盖同 hash 件副词条/置真/id 改链,未验证件仅 `equippedBy`/`ageIndex` 可变,无实质变化记 `skipped`。两工具成功后 `markDirty`(防抖写回)。**未载入存档时导入直接报错**(与 `reset_all` 口径一致;§3.1 未设想空库导入,若产品要允许需接线员确认后删一行 `requireSave`)。
- **D12 outputSchema 的最终取舍(D7)**:**44 个工具全覆盖、无一跳过**;跳过的只有 6 个 `game://` 资源——SDK 1.32.1 的资源配置(`{title, description, mimeType}`)没有 outputSchema 参数,`resources/read` 也不做 schema 校验,无从声明。实现约束:SDK 顶层只接受对象形状,`z.union` 无 `.shape` 会使校验 TypeError,多形状返回(optimize 的 rejected/completed/cancelled、fetch_showcase 的 ok/error、calc_ehr 的可达/不可达、sync_bridge_start 的幂等/新启动)一律改为「恒有字段 + 分支字段 `.optional()`」扁平整形;SDK 校验只检不回写(unknown 键剥离不生效),schema 不会截断输出。一处实测偏差按实际返回放宽:编排器产出的 `SimulationRequest.stats` 对不适用词条(如 DEF%)填 null,请求回显 schema 用 `union([number, null])` 而非上游类型声明的 `Record<string, number>`。
- **D13 行→配装不另设 resource(§3.6 / §4.3 #3)**:方案 §4.3 的行→配装序列化器落在 `optimize`/`get_results` 的**行内 `builds` 字段**(每行 6 槽遗器 id 与明细),未按 §3.6 另设独立 resource——再设一个只会复制同一份缓存。混合进制行 id 反解保留在 optimize 实现内部;`analyze_build` 改为显式 `relicIds` 输入(见 D14),不经过行 id。
- **D14 同步桥自动推送的接线点与尾巴(§6.3 / M3)**:§6.3 设想的「装备变更后推全量」没有在各个装备工具里逐个埋点,而是收敛为单一钩子——`mcp/src/context.ts` 的 `flushSave` 成功写回后调 `bridgeNotifyChange()`(try/catch 非阻塞,未启动/无客户端时幂等空操作),任何走 `markDirty` → 防抖写回的变更都自动触发。协议行为按 §6.3 实测结论落地:连接即推全量、变更重推全量、重连重发;删除走「先 DeleteRelics 后 InitialScan」的按客户端差量。尾巴:`mcp/src/index.ts` 的退出钩子未接线 `closeBridge`(静态发现,退出时若桥在监听可能拖住退出/占住端口;退出前显式 `sync_bridge_stop` 可规避,修复为一行接线)。
- **D15 工具命名与入参对 §3 原文的差异**:①`describe_conditionals` 是单工具收 `characterId + 可选 eidolon/lightConeId/superimposition`(回退链:显式 → 存档表单 → 角色默认光锥 s1),不是 §3.2 的 `(characterId, eidolon | lcId, s)` 双入口;②`analyze_build` 收 `newRelicIds/oldRelicIds`(显式遗器 id,old 缺省取当前装备),不是 `(characterId, buildA, buildB)`,且**不支持从 optimize 结果行引用**(agent 用行内 builds 的遗器 id 组装);③`benchmark_runs` 的预设为 `presets[]` 显式传入(`relicSet1/2/ornamentSet/spdThreshold`,上限 16),光锥/魂影/队友缺省取评分元数据推荐队;④`fetch_showcase` 另有 `source`(校验一致性,不匹配报错且不写缓存)/`includeRaw`/`timeoutMs`;⑤`import_showcase` 的 `mode` 三值为 `relics/character/all`,映射上游内部的 `relics/singleCharacter/multiCharacter`;⑥§3.6 的 3 类 resource 落地为 **6 项**(characters、lightcones 列表 + `{id}` 详情模板、sets 全量单资源、changelog);⑦§3.3 的 `dps_score(characterId, team?)` 已随 M1 交付;team 不接受显式队员列表,仅 `default`/`custom` 开关(`z.enum(['default','custom'])`:default=官方推荐队、custom=自定义覆盖队,评分元数据自带推荐队)。
- **D16 条件门槛为探测推导而非上游元数据(§3.2 / §4.3 #1)**:星魂/叠影门槛与数值升级档**没有上游元数据可查**,实现用 e0–e6 / s1–s5 逐档重跑条件 resolver 探测:disabled 变化 → `requiresEidolon`/`requiresSuperimposition`,签名 diff → `eidolonValueUpgrades`/`superimpositionValueUpgrades`。后者语义是「该档起数值或描述变化」(与 E3/E5 升级档一致,但含纯文案变化),非上游显式声明。
- **D17 缺席或降级的功能**(其余全部按 §7 交付):①`benchmark_runs` 取消仅在预设间生效(orchestrator 内部无取消信号),预设串行执行;②`fetch_showcase` 的上游 `API_ENDPOINT` 常量未导出,mcp 侧复制字面量并注明出处(上游改域名需同步);③同步桥受上游协议限制:同一角色的强化版与原版(1004b1/1004)不能同帧表达,帧内 `lock`/跃迁资源恒 false/空;④`game://changelog` 为英文原文(上游无中文翻译面),resources 的 path/element 保持规范英文值(上游无 PathName 中文翻译面);⑤i18n 构建期不自包含——dist 运行期依赖仓库 `public/locales`(`HSR_MCP_LOCALES_DIR` 可指到仓库外,§5.5「构建时把 YAML 作为资产带上」未做);⑥`save_team` 不自动把缺失角色补进 roster(网页是「加载队伍」时补,非保存时);⑦`warp_plan` 的版本收入表随游戏版本手工维护(现役 4.5/4.6,新版本需上游表先更新,MCP 报错与 incomeOptions 自动跟随)。

### 复核修复登记(2026-10)

M2/M3 复核(静态发现 + 冒烟走查)产出的一批修复,按处置方登记;并行条目以「由并行修复批次处置」记,细节见各文件与 `README.md` 已知限制:

- **由并行修复批次处置**:P1-A 写回透出;P1-B equipped 过滤;P2 blockedWipe 不推桥、setSave 取消定时器、load 失败回滚、closeBridge 接线(对应 D14 尾巴与 README 已知限制 #10)。
- **本批处置的口径与文案项(Fixer C)**:①冒烟断言治理——`scripts/smoke-misc.mjs` 删除恒真断言「chosen port is not 23313」(不变量已由 `randomPort()` 的重试循环保证)与 `calc_ehr` 盲测断言中数学上恒假的 `=== ehr1` 冗余分支(保留镜像公式 oracle,断言仍可失败);②`scripts/smoke-simulation.mjs` 注释漂移修正——头部与 TARGET 注释的「ATK% 变体 / Jingliu scales on ATK / ATK-scaling DPS」改为与实际 fixture 一致的「HP% 变体 / HP scaler(1212b1)」;③`src/domains/imports.ts` 的 `importWouldChange` 补比 `augmentedStats`——上游 verified 分支覆盖写 substats/previewSubstats/augmentedStats 三项,跳过统计至此与实际落盘口径全量对齐;④`src/domains/showcase.ts` UID 校验文案如实化(比网页端更严:仅接受 9 位数字,网页端只校验长度)、「魂影」改「星魂」;⑤`README.md` 已知限制补登 #14–#16(异常消息中英混杂、`statUpgrades` 12 副词条全量与 `pct` 百分数口径、eidolon 术语统一),并将 #10 的「拖住退出/占住端口」收敛为「客户端非正常断连」;⑥本节 D15 ⑦ 的 team 表述修正。

## 11. M4–M9 交付登记(2026-10-07)

本方案 §9/§10 登记 M1–M3 偏差;M4 起的逐里程碑交付与偏差登记移至[契约冻结](./hsr-optimizer-MCP-契约冻结.md) §9 变更记录(冻结流程要求四处同步,该处为权威)。此处只记收口结论:

- **交付状态**:S0 → M4 → M5 → M6 → M7 → M9 主线全部完成;61 工具 / 11 资源 / 预算 61/70;29 套冒烟 + 仓库外安装检查全绿。
- **覆盖收口**:网站基线 175/175 implemented(矩阵见 `coverage/summary.md`,enhancement 7 项独立报告不计分母)。§10 D17 的遗留项(§5.5 构建期翻译资产、取消粒度等)已随 M4–M9 各批次处置或转登 README 已知限制。
- **验收四件套**:coverage-check 强制 implemented⇒真实冒烟链接;视觉回归(基线 PNG 容差比对);`check:packaged` 仓库外完整安装断言(i18n/媒体/GPU/重启恢复);使用指南(版本兼容表/环境要求/样例/排错)入册。
