# HSR Optimizer MCP 化调研报告

- **日期**：2026-10-05
- **调研对象**：本地克隆 `H:\02_GAME\01-1-Star-rail-computing\hsr-optimizer`（fork：hezhongtang/hsr-optimizer ← upstream：fribbels/hsr-optimizer，HEAD `76cff129`，2026-10-03，工作树干净）
- **目标**：为"后台统管 MCP 接口（不操作网页端、网页端自动同步、覆盖程序全部功能）"做可行性调研与方案设计
- **方法**：互联网外部方案盘点 + 4 个并行探索 agents（引擎内核 / 状态与存档 / 游戏元数据 / 工程化与程序化调用路径）

---

## 一、结论摘要

1. **外部无现成方案**：目前不存在针对 Fribbels HSR Optimizer 的 MCP server、公开 API 或 CLI。官方仓库是纯前端应用，issues 中无任何相关讨论。最接近的公开项目是一个清华 Rust 课程 Demo（借 Fribbels 源码做遗器强化决策），不属于完全操控方案。
2. **本地引擎高度可后台化**：计算内核是纯函数（不吃 store、不碰 DOM），UI 耦集只在外层编排器；仓库内已有一条**生产级纯 Node 跑引擎的先例**（leaderboard 管线），打包方式、内联调用技巧、Node API 边界全部现成。
3. **状态层可在 React 外驱动**：Zustand vanilla store 支持命令式 `getState().action()` 调用；导入去重、装备写回、遗器评分都是现成服务函数。
4. **网页端自动同步有零改动通道**：应用自带 Live Import websocket 客户端（主动连 `ws://127.0.0.1:23313/ws`）。MCP server 伪装成 Reliquary Archiver 在该端口 listen，即可把后台的库存/配装变更实时推给网页端——上游代码一行不用改。
5. **需要新写的代码量很小**：主要是 Engine A 的 headless 调度循环（约 100 行，复刻 `optimizer.ts:314-435`，全部积木为现成纯函数）+ MCP server 本身。

---

## 二、外部调研：现成方案盘点

### 2.1 官方现状（fribbels/hsr-optimizer，⭐707）

- 纯前端 React 19 + Vite 8 应用，优化引擎**未发布到 npm**（npm 上无 `hsr-optimizer` 包）。
- 无公开 API / CLI / headless 入口；issues 与 discussions 中无 MCP 或程序化访问讨论。
- 仓库内唯一自动化是自用 Playwright E2E（[PR #64](https://github.com/fribbels/hsr-optimizer/pull/64)），且现有 4 个 spec 都只测 UI 交互，**没有任何 spec 跑过一次优化**。

### 2.2 最接近的外部项目

| 项目 | 是什么 | 与"agent 操控 optimizer"的关系 |
|---|---|---|
| [chenxizhao-cs/hsr-relic-agent](https://github.com/chenxizhao-cs/hsr-relic-agent) ⭐2 | 清华 Rust 课程 Demo：遗器强化决策 Agent | **最接近**。固定上游 commit（`df630a0`）、`npm ci` 构建官方源码、外套薄 Adapter，Rust 决策引擎推荐强化 Continue/Hold/Stop。但最终强化仍由人在页面点击，非完全操控 |
| [hsr-assistant/hsr-assistant-driver](https://github.com/hsr-assistant/hsr-assistant-driver) ⭐5 | 真 MCP server（Python，2026-04 更新） | 暴露的是**游戏客户端自动化**（集成 Auto_Simulated Universe + March7thAssistant），与遗器优化器无关 |
| [ReZeroE/StarRail](https://github.com/ReZeroE/StarRail) ⭐298 | 游戏客户端 CLI 自动化包 | 操控游戏本体，非优化器 |
| [IceDynamix/reliquary-archiver](https://github.com/IceDynamix/reliquary-archiver) ⭐439 / [kel-z/HSR-Scanner](https://github.com/kel-z/HSR-Scanner) ⭐205 | 抓包/OCR 导出账号遗器 JSON | agent 化的**数据输入端** |
| [orexis](https://github.com/hessiser/orexis) ⭐4 + [orexis-extension](https://github.com/NightKoneko/orexis-extension) ⭐3 | 装在 fribbels 网站上的浏览器扩展（配装插件） | 证明"向官方网页注入扩展"可行，但与 LLM/agent 无关 |

GitHub 搜 `relic optimizer mcp` 结果为 **0**。另有一个 Reddit r/ClaudeAI 帖子（GitHub Actions + Claude 自动化 HSR damage optimizer）被反爬拦截无法核实，存疑。

---

## 三、本地代码库深度探索

> 所有路径相对 `hsr-optimizer/`（仓库根即前端应用，**无 `frontend/` 子目录**）。

### 3.1 架构现状（修正旧认知）

- **状态管理是 Zustand 5**（2023-12 从 Redux 迁移），无 redux/localforage/dexie/IndexedDB。
- **持久化是 `localStorage['state']`**（单键全量 JSON，防抖 5s 保存，`beforeunload` 强制 flush）。导出的 `fribbels-optimizer-save.json` 即该键原样内容（`HsrOptimizerSaveFormat`，类型定义 `src/types/store.ts:91-120`）。
- Node ≥ 26（`.nvmrc`；本机 v26.7.0 满足），npm ≥ 11，纯 ESM，TS strict，路径别名 `* → ./src/*`。

### 3.2 双引擎架构

**Engine A —— 遗器库穷举搜索（配装优化器）**

| 环节 | 位置 | 说明 |
|---|---|---|
| UI 入口 | `src/lib/tabs/tabOptimizer/optimizerForm/optimizerFormActions.ts:401-444` | `startOptimization()`：校验 → 存 form 到角色 → `optimizationId = uuid()` → `Optimizer.optimize(form)` |
| 编排器 | `src/lib/optimization/optimizer.ts:187-436` | **UI 耦合**（zustand grid stores、Mantine 弹窗、i18next、WebGPU 分支），headless 需绕开，自写调度循环复刻 `optimizer.ts:314-435` |
| 遗器筛选 | `optimizer.ts:159-185` + `src/lib/optimization/relicFilters.ts` | 从 `getRelics()`（zustand relic store）取库存后过滤 |
| 套装求解 | `src/lib/optimization/relicSetSolver.ts`（:24/:90/:164/:239） | 纯函数 `generateRelicSetSolutions` / `generateOrnamentSetSolutions` / 半连接约减 |
| 上下文构建 | `src/lib/optimization/context/calculateContext.ts:24` | `generateContext(request)` 纯函数（元数据初始化后） |
| 计算内核 | `src/lib/worker/optimizerWorker.ts`（526 行） | **纯计算**，无 store/DOM import；分块 `THREAD_BUFFER_LENGTH=150000` 排列，顶部 N 队列 |
| 结果编码 | `src/lib/optimization/bufferPacker.ts`（SIZE=77 :13） | Float32 行 → `OptimizerDisplayData`（`extractCharacter`/`extractArrayToResults`）；行 `id` = 排列索引 |
| build 反解 | `src/lib/tabs/tabOptimizer/optimizerTabController.ts:295-306` | `calculateRelicIdsFromId(id)` 混合进制反解出 6 件遗器 ID |

- **Worker 输入** `OptimizerWorkerInput`（`optimizerWorker.ts:62-83`）：`{ workerType, relics{6槽}, request: Form, context, buffer, relicSetSolutions, ornamentSetSolutions, permutations, WIDTH, skip }` —— 全部是数据，遗器库在 worker 边界已物化为消息。
- **Worker 输出**：`{ rows: [], buffer }`，尾部 `self.postMessage`（`optimizerWorker.ts:322-325`）—— Node 无 `self`，需一行 shim 或内联调用。
- **Form 请求结构**（`src/types/form.ts:47-130`）：角色（id/魂/等级）、光锥（id/叠影）、敌人参数、conditionals（角色/光锥/套装）、遗器过滤（强化/星级/rank/排除/主词条/套装约束/`includeEquippedRelics`）、权重 `weights`、显示、队友 `teammate0/1/2`、连招 `comboStateJson`、`resultSort`/`resultsLimit`(默认 1024)/`resultMinFilter` 等。
- WebGPU 版（`src/lib/gpu/webgpuOptimizer.ts:44`）浏览器限定，headless 强制 CPU 路径。

**Engine B —— 最优副词条模拟搜索（DPS 分数基准）**

- 入口 `computeOptimalSimulationWorker`（`src/lib/worker/computeOptimalSimulationWorker.ts:35`），副词条 roll 搜索树 `src/lib/worker/maxima/tree/searchTree.ts`。
- **已有生产级纯 Node 路径**：`npm run leaderboard` → `vite build --config vite.leaderboard.config.ts` → `node .leaderboard-build/runLeaderboard.js`；`src/leaderboard/workers/profileWorkerThread.ts:30-31` 的引导序列 `Metadata.initialize()` + `globalThis.SEQUENTIAL_BENCHMARKS = true` 即全部所需。
- 内联技巧：`src/lib/worker/computeOptimalSimulationWorkerRunner.ts:57-67` `runComputeOptimalSimulationInline(input)` 伪造 `{data: input}` MessageEvent 直接调用 worker 函数取同步返回——**这是官方自带的"绕过 Web Worker"开关**。

### 3.3 状态与持久化层

**核心 Zustand stores（`src/lib/stores/`）**

| Store | 文件 | 内容 |
|---|---|---|
| `useRelicStore` | `relic/relicStore.ts:28` | `relics[]`，actions `setRelics/upsertRelic/batchUpsertRelics/deleteRelic`，命令式 `getRelics()` |
| `useCharacterStore` | `character/characterStore.ts:31` | `characters[]`（`{id, equipped: 6槽→relicId, form, builds}`） |
| `useOptimizerRequestStore` | `optimizerForm/useOptimizerRequestStore.ts:101` | 完整 Form 状态（过滤/权重/conditionals/队友/连招）+ `loadForm(form)` |
| `useOptimizerDisplayStore` | `optimizerUI/useOptimizerDisplayStore.ts:85` | 运行态：`optimizationId`、进度、context、选中行 |
| `useGlobalStore` / `useScoringStore` 等 | `app/appStore.ts` / `scoring/scoringStore.ts` | 设置 / 评分覆盖 |

所有 store 为 vanilla 实现，`store.getState().action()` 在 Node 中可直接调用（React 只负责渲染）。

**持久化链路**

- 加载：`src/index.tsx:102-103` → `Metadata.initialize()` + `SaveState.load()` → `persistenceService.loadSaveData()`（`src/lib/services/persistenceService.ts:77-221`，含迁移、`relic.equippedBy ↔ character.equipped` 重新互链）→ 两个 store 水合。
- 保存：`src/lib/state/saveState.ts:34-119`，键 `'state'`。
- 工作区 `profile/fribbels-optimizer-save.json` 是用户导出的外部备份（程序不自动读它）。

**导入管线（`src/lib/importer/`）**

- Kelz 格式统一解析器 `kelzFormatParser.tsx` 覆盖 HSR-Scanner v4 / Reliquary Archiver v4 / Yas v3（配置 `importConfig.ts:55`）；HoyoLab 格式独立解析器 `hoyoLabFormatParser.tsx`。
- 真正合入：`persistenceService.mergeRelics(relics, characters)`（`persistenceService.ts:236-398`）——按 hash 去重、verified 导入覆写、装备互链、双穿清理、回写 store。**幂等，可重复导入**。

**装备写回（`src/lib/services/equipmentService.ts:76-110`）**

`equipRelicIds` / `equipRelic` 双向写 `character.equipped[part] = relicId` 与 `relic.equippedBy = characterId`，处理前任持有者换装。

### 3.4 静态游戏数据层

**数据文件（`src/data/`）**：`game_data.json`（357KB：108 角色/170 光锥/62 套装，含基础属性+行迹树）、`relic_main_affixes.json`、`relic_sub_affixes.json`。手工 PR 更新（无生成脚本），当前版本 `4.6v5`。

**运行时装配**：`Metadata.initialize()`（`src/lib/state/metadataInitializer.ts:84-123`）纯函数，产出单例 `DBMetadata`；LC 叠影属性名→Stats 转换、角色 scoring 注入（来自 conditionals 注册表）都在这里。

**Conditionals 系统**：角色 103 个 + 光锥 170 个 TS 文件（`src/lib/conditionals/character|lightcone/**`），经 `import.meta.glob` eager 注册（`resolver/characterConfigRegistry.ts:3-7`）→ `(characterId, eidolon) → controller` 解析。**技能倍率/魂韵数值编码在 TS 里而非 JSON**——后台必须走 TS 运行时/打包，不能当数据文件读。

**评分体系**：

- 遗器评分（套装盲）：`src/lib/relics/scoring/`——当前分 `currentScore.ts`、潜力 `potentialScore.ts`（current/best/average/worst%）、字母分级 `scoreFormatting.ts`（F→AEON）、批量 `scoreRelicsBatch.ts`。
- 权重来源：每角色 conditional 文件里的 `scoring()` 工厂（如 `character/1000/Kafka.ts:71-115`），运行时经 `scoringStore.getScoringMetadata(id)` 合并用户覆盖。
- DPS 分数（Engine B）：基准搜索 + 分段归一化（`src/lib/scoring/dpsScore.ts`）。

**本地化**：`public/locales/<locale>/gameData.yaml`（17 语言含 zh_CN），按游戏 ID 键控；英文名在 `game_data.json` 内兜底。

**Node 后端数据加载清单（globs）**：3 个 JSON + `conditionals/**`、`sets/**`、`state/metadataInitializer.ts`、`constants/constants.ts`、`importer/characterConverter.ts`、`relics/scoring/**`、`relics/estTbp/**`、`scoring/**`、`public/locales/*/gameData.yaml`。

### 3.5 工程化与程序化调用先例

- **Leaderboard Node 管线**（最有价值）：`vite.leaderboard.config.ts` 构建 3 个 SSR Node 入口（`runLeaderboard`、`runPreFilterAnalysis`、`workers/profileWorkerThread`）；`src/leaderboard/shared/nodeFacade.ts` 是刻意的 Node API 边界（fs/worker_threads/node:sqlite/zlib）。**证明 `import.meta.glob`、路径别名、JSON import attributes 在 Node 打包产物中全部可解。**
- **Vitest**：`environment: 'node'`（`vite.config.ts:102-107`），106 个测试文件中引擎侧全部纯 Node 跑通完整伤害管线（如 `simulations/tests/statSim/statSimTestUtils.ts:116-135`：`generateFullDefaultForm` → `generateContext` → `runStatSimulations`）。
- **Headless Form 工厂**：`generateFullDefaultForm(characterId, lightCone, e, s)`（`src/lib/simulations/utils/benchmarkForm.ts:18-66`）——只给 ID 就能产出全默认 Form。
- **浏览器内调试面**（备选路线 B）：`window.__HSR_DEBUG`（`src/index.tsx:79-101`）暴露 workerPool/SaveState/RelicScorer/startOptimization 等，Playwright `page.evaluate` 可直接调；save 注入用 storageState 模式（`tests/global.setup.ts:6-24`）。
- **Playwright 现状**：4 个 spec 全是 UI 断言，无优化运行、无 page.evaluate —— 网页自动化路线需要从零写，但配料齐全。

### 3.6 Node 运行阻塞点与解法

| 阻塞点 | 位置 | 解法 |
|---|---|---|
| `import.meta.glob`（1000+ 模块） | conditionals 两个注册表 | 照 leaderboard 走 Vite SSR 打包（已验证可行） |
| `?worker` 导入后缀 | `workerPool.ts:1` | 不用 workerPool，内联调用 worker 函数 |
| `self.postMessage` | `optimizerWorker.ts:322` | 复刻 `SEQUENTIAL_BENCHMARKS` 内联返回模式，或 shim `globalThis.self` |
| JSON import attributes | `metadataInitializer.ts:1-3` | Node ≥ 26 原生支持；SSR 打包亦解 |
| 路径别名 `lib/* → src/lib/*` | `tsconfig.json:23-25` | Vite 构建解析 |
| `beforeunload` 注册 | `saveState.ts:27` | 不 import SaveState，或提供 window shim |
| i18next | 仅编排层用 | 内核无 i18n 依赖；headless 不走 `Optimizer.optimize` 即不触发 |
| WebGPU 分支 | `optimizer.ts:283-312` | 强制 CPU 路径 |

---

## 四、MCP 统管接口设计蓝图

### 4.1 架构

```
LLM / ZCode（MCP client）
   ↕  stdio（MCP 协议）
hsr-mcp-server（Node 26 进程，Vite SSR 打包，直接 import 上游 src/）
   ├─ 数据层    save 文件（磁盘真源）↔ Zustand stores（内存工作集）
   ├─ Engine A  headless 调度器（新写 ~100 行，复刻 optimizer.ts:314-435）
   │            + optimizerWorker 内联调用 + BufferPacker 解码 + calculateRelicIdsFromId
   ├─ Engine B  DPS 评分（runComputeOptimalSimulationInline，现成）
   ├─ 服务层    mergeRelics / equipRelicIds / RelicAugmenter / RelicScorer（现成）
   └─ 同步桥    伪 Archiver ws server（:23313）→ 推 UpdateRelics / UpdateCharacters
                     ↕  应用主动连上来（网页开 Live Import 开关即生效，零改动）
                网页端
```

### 4.2 工具清单（覆盖网页端核心功能）

| 类别 | MCP tools | 底层实现 |
|---|---|---|
| 存档 | `load_save` / `save_status` / `export_save` / `import_scanner_json`（4 种格式） | SaveState 格式读写 + `mergeRelics` |
| 查询 | `list_characters` / `get_character` / `list_relics`（筛选）/ `get_game_metadata`（zh_CN 名单） | store 命令式读取 + i18n YAML |
| 优化 | `optimize(characterId, overrides?)` → 候选列表 + 每名 6 件遗器明细；`simulate_build` | Engine A 调度器 / `simulateBuild.ts` |
| 装备 | `equip_build(rank)` / `equip_relics` / `unequip` → 自动触发网页同步 | `equipmentService.equipRelicIds` |
| 评分 | `score_relics(characterId?)`（字母+潜力）/ `dps_score(characterId)` | `RelicScorer` / Engine B |

### 4.3 网页端自动同步

- **后端 → 网页（零改动）**：应用 Live Import 的 websocket 客户端主动连 `ws://127.0.0.1:23313/ws`（`src/lib/tabs/tabImport/ScannerWebsocketClient.tsx:70`），事件协议 `InitialScan / UpdateRelics / UpdateCharacters / UpdateLightCones / DeleteRelics / ...`（`scannerStore.ts:413-422`），处理逻辑自动规范化→upsert→保存（`scannerStore.ts:489-602`）。MCP server 在该端口 listen 并按协议推送，网页端即实时收到后台的库存与配装变更。
- **网页 → 后端**：现状无任何监听（localStorage 写而不察、无 BroadcastChannel）。一期接受"网页手动改动后需 `load_save` 重载"（或从浏览器导出 save 再喂给 MCP）；二期可加 20 行油猴/扩展把 save POST 给 MCP。
- **端口冲突**：与真 Reliquary Archiver 互斥 23313——抓包导入时同步桥让位（检测端口占用），或把两者做成同一进程的代理转发。

### 4.4 复用 vs 新建

**直接复用（不改一行）**：计算内核 `optimizerWorker.ts`；`generateContext` / `relicSetSolver` / `relicFilters` / `bufferPacker`；Engine B 全链路；`Metadata.initialize`；`generateFullDefaultForm`；`mergeRelics` / `equipmentService` / `RelicAugmenter` / `RelicScorer` / estTbp；leaderboard 的 vite SSR 构建配置与 nodeFacade 模式；伪 Archiver 所需的整个 websocket 接收端。

**需要新写**：① Engine A headless 调度器（复刻分块循环 + 顶部 N 队列 + 内联 worker 调用，约 100 行）；② MCP server 入口与工具定义（官方 `@modelcontextprotocol/sdk`，TS 生态一致）；③ save 文件 ↔ store 水合的小适配层；④ 伪 Archiver ws 服务端（事件格式照 `scannerStore.ts:413-422` 抄）。

### 4.5 风险与对策

| 风险 | 等级 | 对策 |
|---|---|---|
| Engine A 单线程慢（2059 遗器全库穷举） | 中 | `node:worker_threads` 池（leaderboard `profileWorkerThread` 有先例）；或限套装/主词条约束缩小解空间 |
| 调度器新代码与官方结果不一致 | 中 | 验收标准：同一存档同一 Form，MCP 结果与网页端 topN 完全一致 |
| 23313 端口互斥 | 低 | 占用检测/让位逻辑 |
| 上游更新需重新打包 | 低 | 挂 `npm run build:mcp` 脚本，锁 commit（hsr-relic-agent 同款做法） |
| `Optimizer.optimize` 未来重构导致内核变化 | 低 | 锁 fork commit + 定期 rebase |

### 4.6 实施分期

1. **一期（核心 MCP）**：SSR 打包入口 + headless 调度器 + 存档加载/优化/装备/评分工具，用真实存档（2059 遗器/60 角色）对拍网页端结果。
2. **二期（自动同步）**：伪 Archiver ws 桥，后台装备变更实时反映到网页。
3. **三期（可选）**：网页→后端回传、`node:worker_threads` 并行加速、ZCode 插件化封装。

---

## 五、关键文件索引（开工速查）

```
hsr-optimizer/
├─ package.json                                  # scripts: start/build/test/leaderboard; engines node>=26
├─ vite.leaderboard.config.ts                    # Node SSR 打包模板（照抄给 MCP 入口）
├─ src/leaderboard/
│  ├─ runLeaderboard.ts                          # Node 入口范例
│  ├─ workers/profileWorkerThread.ts:26-31       # Metadata.initialize + SEQUENTIAL_BENCHMARKS 引导
│  └─ shared/nodeFacade.ts                       # Node API 边界（fs/worker_threads/sqlite/zlib）
├─ src/lib/optimization/
│  ├─ optimizer.ts:187-436                       # Engine A 编排（UI 耦合；314-435 为调度循环蓝本）
│  ├─ optimizer.ts:159-185                       # 遗器筛选链
│  ├─ context/calculateContext.ts:24             # generateContext(request)
│  ├─ relicSetSolver.ts                          # 套装约束纯函数
│  └─ bufferPacker.ts                            # 77-float 行编解码 + OptimizerDisplayData
├─ src/lib/worker/
│  ├─ optimizerWorker.ts:62-83,322-325           # Engine A 内核（输入类型/输出 postMessage）
│  ├─ computeOptimalSimulationWorkerRunner.ts:57-75  # 内联调用 worker 的官方技巧
│  └─ workerUtils.ts:1-5                         # WorkerType 枚举
├─ src/lib/simulations/utils/benchmarkForm.ts:18-66  # generateFullDefaultForm（headless Form 工厂）
├─ src/lib/state/metadataInitializer.ts:84-123   # Metadata.initialize()
├─ src/lib/services/
│  ├─ persistenceService.ts:236-398              # mergeRelics（导入合入）
│  └─ equipmentService.ts:76-110                 # equipRelicIds（装备写回）
├─ src/lib/tabs/tabImport/
│  ├─ scannerStore.ts:413-422,489-602            # ws 事件协议 + 处理器（伪 Archiver 依据）
│  └─ ScannerWebsocketClient.tsx:70              # ws://127.0.0.1:23313/ws 客户端
├─ src/lib/relics/scoring/                       # RelicScorer / potential / estTbp
├─ src/data/game_data.json (+2 个 affix JSON)    # 静态游戏数据
├─ public/locales/zh_CN/gameData.yaml            # 中文名单
└─ tests/global.setup.ts:6-24                    # save 注入模式（浏览器路线备用）
```

外部工作区：`profile/fribbels-optimizer-save.json`（真实存档，验证用）。
