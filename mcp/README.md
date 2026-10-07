# HSR Optimizer MCP Server

让 agent 在会话中通过 MCP(stdio)完成 fribbels HSR Optimizer 的核心用户功能:载入存档 → 查询角色/遗器 → 优化搜索 → 装备 → 评分,并扩展到导入(扫描器/Hoyolab/展示柜)、战斗模拟与基准、条件定义查询、纯计算器、组队展示与网页端同步桥。当前交付 **61 个工具**(M1 基础域 26 + M2/M3 扩展域 18 + M4 状态与任务域 4 + M5 角色/遗器/表单/队伍域 4 + M6 扫描器/评分/榜单/分析域 4 + M7 浏览器/渲染/诊断域 5)与 **11 个资源**(`game://` 元数据 7 项 + `site://` 站点面 4 项),覆盖方案 §7 M1–M3 的全部条目与全站覆盖计划 M4–M9 全主线:状态基础、角色/遗器/表单/队伍操作、实时导入、四配置角色评分、排行榜数据层与本地复算、遗器分析,以及受管浏览器运行环境下的图片导出、WebGPU 检验与 GPU 优化执行;M9 收尾后网站基线 175/175 全部接入(矩阵见 coverage/summary.md)。操作视角的接入文档见[使用指南](./hsr-optimizer-MCP-使用指南.md)。

- 设计与分期依据:[`hsr-optimizer-MCP-实施方案.md`](./hsr-optimizer-MCP-实施方案.md)(§6.1 规模闸门、§6.2 一致性验收、§7 验收标准)
- 可行性实测背景(spike)已删除,历史见 commit `81f0789a`(见文末「与 spike 的关系」)

上游引擎**原样**在 Node 无头运行:`Optimizer.optimize` 跑在上游原版调度器 + `node:worker_threads` 池上(网页端默认 WebGPU 引擎,本服务为 CPU 多线程版,结果一致、耗时更长)。浏览器全局垫片、文件后端 localStorage、`?worker → worker_threads` 适配层全部集中在 `src/shims.ts` 与 `src/worker/`。

## 构建 / 启动 / 测试

```bash
# 在 mcp/ 目录(或仓库根目录,mcp/scripts 均可从 mcp/ 运行)
npm install            # mcp/ 内独立依赖(@modelcontextprotocol/sdk、zod)
npm run build          # Vite SSR 构建 → mcp/dist/(index.js + 3 个 worker 入口 + parityRef.js)

npm start              # stdio 启动(供 MCP client 拉起)
```

验证(全部对着 `mcp/dist/` 跑,临时目录隔离,不写仓库文件;每个套件数十项断言,随修复持续增加):

```bash
npm run smoke          # 基础闭环:listTools → load_save → list_relics → optimize → 取消路径 → export/reset
npm run smoke:query    # 查询域:list_characters/get_character/get_form/default_form/permutations/list_relics
npm run smoke:archive  # 存档回归:载入失败保留未落盘修改、完整恢复会话、换档时缺省字段恢复默认
npm run smoke:revision # M4 变更协调器:revision 读不变/写递增、载入失败回滚修订号与脏标记
npm run smoke:state    # M4 状态域:get_state/update_state 五分支读写、baseRevision 冲突、未知键拒绝
npm run smoke:jobs     # M4 任务域:optimize/benchmark_runs 任务生命周期、进度查询、cancel_job 路由
npm run smoke:snapshot # M4 结构化快照:与写盘输出逐字段对拍、零副作用(不动护栏引用/不写文件)
npm run smoke:optimizer-generation # 优化时换档:拒绝旧结果与跨档缓存;同档取消保留部分结果
npm run smoke:form-overrides # 表单覆盖回归:get_form 内部字段与显示表单字段均正确生效
npm run smoke:form      # M5 表单域:update_form 全参数面(切换自动保存/预设/连招同步/假想配装)
npm run smoke:relics    # M5 遗器 CRUD:编辑器保存语义/装备转移/预览不落盘/删除清引用
npm run smoke:teams     # M5 队伍域:manage_team 五动作/基准快照/traces 级联/自动排序/评分队伍联动
npm run smoke:scanner      # M6 扫描器:假 Archiver ws 服务端推帧/连接/重连/事件日志/只导遗器
npm run smoke:score        # M6 评分域:score_character 四配置/临时队伍/速度基准/trace/评分资源
npm run smoke:leaderboard  # M6 排行榜:本地 fixture 五视图/过滤分页/UID 排名/失败不作空榜成功
npm run smoke:calculators  # M6 计算器:阿哈反解与底稿/EHR 概率与热图/跃迁三模式/语言/示例存档
npm run smoke:analysis     # M6 分析域:analyze_relic 三视图/优化诊断修复/resultsLimit/rowIds/套装审计
npm run smoke:equip    # 装备+评分域:equip/unequip/switch/builds/score_relics/dps_score/scoring override
                        # + 缓存世代拒绝 / fromCache 表单回写 / 缺失遗器跳过 / 奶妈评分配置解析
npm run smoke:shutdown # 关停路径:stdin EOF 干净退出(exit 0,毫秒级)+ 防抖写回不丢
npm run parity         # M1 验收对拍 harness(见下)
npm run smoke:conditionals # 条件面板 + game:// 资源:zh_CN 标签、星魂/叠影门槛、枚举与滑杆元数据、
                        # 无存档回退链、命途不符光锥警告、未知 id 拒绝
npm run smoke:simulation   # 模拟域:simulate_build(trace 归因)/ stat_simulate(确定性 + 变体差值)/
                        # analyze_build(+1 roll 升级表)/ benchmark_runs(预设批量跑分 + 取消语义)
npm run smoke:imports  # 导入 + 展示柜:union 并集语义(1+162→163)、dryRun、replace 收缩、并集反擦写、
                        # 解析错误路径;showcase 全部错误路径(离线 stub fetch)+ 内联档案导入
npm run smoke:misc     # 计算器(warp_plan/calc_aha/calc_ehr 对拍上游公式)/ teams(list/save 往返与
                        # 快照保留规则)/ 同步桥(ws 帧逐字段校验、回灌上游解析器、变更驱动重推)
npm run smoke:all      # 依次跑全部二十九份(浏览器套件在缺 Chrome/dist 的环境自动 [SKIP];视觉回归对基线 PNG 容差比对)
npm run check:packaged # M9 仓库外完整安装验收:组装便携树 → 空目录启动 → i18n/媒体渲染/GPU/重启恢复断言
```

## 质量门(须从仓库根执行)

dprint 的 glob 相对当前工作目录解析——在 `mcp/` 下执行会静默假绿,务必在仓库根:

```bash
npx dprint check "mcp/src/**/*.ts" "mcp/scripts/*.mjs" "mcp/*.ts" "mcp/*.json" "mcp/README.md" "mcp/hsr-optimizer-MCP-使用指南.md"
npx oxlint mcp/src mcp/scripts
npx tsgo --noEmit -p mcp/tsconfig.json
```

三者均须 0 报警/0 错误;类型检查也可在仓库根用 `npx tsgo --noEmit -p mcp/tsconfig.json`。

## 环境变量

| 变量                    | 默认                              | 说明                                                                                                                                                                                                                   |
| ----------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HSR_MCP_WORKERS`       | `6`                               | 优化器 worker 池大小(1–10)。池大小在首次导入 `workerPool` 时定死;9 线程满载约 2.3 GB RSS,大库存场景建议保守设置                                                                                                        |
| `HSR_MCP_STATE_FILE`    | `$HSR_MCP_HOME/localstorage.json` | localStorage 垫片的文件后端(上游 store 层的持久化通道)。测试时务必指到临时目录                                                                                                                                         |
| `HSR_MCP_HOME`          | `~/.hsr-optimizer-mcp`            | 状态目录:未显式指定 `HSR_MCP_STATE_FILE` 时,localStorage 后端文件落在此目录下                                                                                                                                          |
| `HSR_MCP_LOCALES_DIR`   | 自动定位(见说明)                  | i18n 翻译目录(`public/locales` 形状,含 `<语言>/<ns>.yaml`)的显式覆盖;缺省从构建产物位置逐级向上查找(dist→mcp→仓库根),即 dist 须留在仓库内运行——要把构建产物挪到仓库外时用本变量指向仓库的 `public/locales`             |
| `HSR_MCP_BROWSER_PATH`  | 平台自动发现                      | 受管浏览器(Chromium 系)可执行文件路径;缺省按 macOS 应用路径 → Linux chrome/chromium → Windows 常见路径发现。M7 渲染/WebGPU 工具依赖它,缺失时返回具体的中文能力报告                                                     |
| `HSR_MCP_SITE_DIST`     | `<仓库根>/dist`                   | 站点构建产物目录(受管浏览器伺服的页面与素材);仓库外运行时用本变量指向独立的 dist 副本                                                                                                                                  |
| `HSR_MCP_ARTIFACTS_DIR` | `$TMPDIR/hsr-mcp-artifacts`       | render/图片导出产物的落盘目录(运行期用户数据,不进仓库)                                                                                                                                                                 |
| `HSR_MCP_NO_BOOT_LOAD`  | 未设(=启用)                       | 设为 `1` 关闭进程启动时从 `HSR_MCP_STATE_FILE` 的 `state` 键自动恢复上次存档(默认开启,镜像网页「打开即载入」;恢复走 SaveState.load(false,false) 同链,会恢复扫描器地址——与手动 load_save 的安全语义不同,属网页启动语义) |

## 工具清单(61 个,按域)

### M1 基础域(26 个)

**存档域(archive)** — 网页端存档生命周期:

| 工具          | 功能                                                                                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------- |
| `load_save`   | 载入存档文件/内联 JSON(完整迁移链),替换当前状态                                                                     |
| `export_save` | 当前状态序列化写回磁盘(网页「导出存档」,带护栏,见下);`structured=true` 返回无写入的结构化快照(与写盘输出逐字段对拍) |
| `save_status` | 当前存档概况:来源、数量、dirty、revision/generation、最近优化缓存                                                   |
| `reset_all`   | 清空恢复默认(仅内存,写回被擦写保护拦截)                                                                             |

`load_save` 替换全部存档状态:新档没有提供的会话与设置字段恢复为默认值。载入失败时恢复调用前的内存状态,包括防抖窗口内尚未落盘的修改,原存档路径与待写回状态保持不变。

**查询域(query)** — 网页端 Characters/Optimizer 页签的只读面:

| 工具              | 功能                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------- |
| `list_characters` | 角色列表摘要(命途/属性/装备概要/评分配置),支持过滤分页                                                  |
| `get_character`   | 单角色深度信息:六槽装备明细、savedForm、已保存配装、评分元数据                                          |
| `get_form`        | 规范化后的内部优化表单(与 optimize 同一条构造路径),附字段来源标注;`expandCombo=true` 附连招矩阵展开形态 |
| `default_form`    | 任意角色全新默认表单(不依赖存档);`spdPreset` 直接取某档速度预设                                         |
| `permutations`    | 搜索空间估算 + 规模闸门预判(与 optimize 同一条估算路径)                                                 |
| `list_relics`     | 遗器库存结构化筛选(词条/roll 反解/套装/归属/排序)                                                       |

**优化域(optimizer)** — 网页端 Optimizer 页签的 Start 按钮:

| 工具          | 功能                                                                                                                               |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `optimize`    | 执行优化搜索:formOverrides 合并、5e7 排列闸门、进度通知、可取消保留部分结果、每行附 6 件遗器配装明细、附当前装备基线行 equippedRow |
| `get_results` | 翻页/排序/过滤最近一次 optimize 的缓存结果,响应附该次运行 summary(cancelled/searched/validPermutations 等)                         |

优化运行期间若调用 `load_save` 切换存档,该次优化结束时返回错误并丢弃结果。`get_results`、`equip_build` 与 `save_build` 的缓存引用均须属于当前载入的存档;切档后须重新优化。

`formOverrides` 兼容显示表单的 `statFilters` / `ratingFilters` / `setFilters` / `teammates`,也接受 `get_form` / `default_form` 返回的内部字段,如 `minSpd`、`minCr`、`teammate0`、`relicSets` / `ornamentSets`。含内部专有字段时自动按内部表单解释;只覆盖 `combatBuffs` 等两种表单共有的字段时,可显式传 `format:"internal"` 或 `format:"display"`。内部百分比用小数(如 `minCr:0.7` 表示 70%),显示表单的 `statFilters.minCr` 与 `combatBuffs` 百分比用百分数;省略格式且没有内部专有字段时保持显示表单语义。

未知覆盖字段和无效 `format` 会报错;表单中的 `characterId` 必须与调用目标一致。`get_form` / `default_form` 的完整返回表单可直接作为覆盖底稿。

**装备域(equipment)** — 网页端角色页与优化结果页的变更面:

| 工具                                                                | 功能                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `equip_build`                                                       | 装备一套遗器(relicIds 或 optimize 缓存行;遵守 Replace/Swap 设置;缓存须归属一致且不跨 load_save;fromCache 先回写表单;缺失件跳过并在 skipped 列出)                                                                                       |
| `unequip_character`                                                 | 卸下角色全部遗器                                                                                                                                                                                                                       |
| `switch_relics`                                                     | 两个角色整套互换遗器                                                                                                                                                                                                                   |
| `upsert_character`                                                  | 新建/更新角色(光锥/叠影/星魂/等级)                                                                                                                                                                                                     |
| `delete_character`                                                  | 删除角色(遗器回库存)                                                                                                                                                                                                                   |
| `set_character_rank`                                                | 调整角色优先级位置(rank 过滤影响优化);`sortBy=effectiveSubstats` 按有效词条分自动排序                                                                                                                                                  |
| `save_build` / `list_builds` / `delete_build` / `equip_saved_build` | 已保存配装的增删查装(fromCache 快照取该次运行实际表单,含 formOverrides;评分配置按角色可用模拟解析,奶妈/辅助不硬编码 DPS);`delete_build(all=true)` 清空全部配装,`equip_saved_build(applyScoringTeam=true)` 装备时同步应用配装的评分队伍 |
| `get_scoring_metadata` / `set_scoring_override`                     | 评分权重/主词条候选的查询与覆盖(默认值+覆盖 delta+有效值);`traces` 行迹级联开关(关闭节点连同全部后代,开启深层节点补全前置)                                                                                                             |

**评分域(scoring)** — 网页端遗器评分列与 DPS Score 卡片:

| 工具           | 功能                                                            |
| -------------- | --------------------------------------------------------------- |
| `score_relics` | 逐件遗器:当前分+字母评级、潜力四分位、reroll 摘要、estTBP 天数  |
| `dps_score`    | 战斗基准评分:总分/评级、四组对比、副词条/套装/主词条/队友升级表 |

### M2/M3 扩展域(18 个)

**条件域(conditionals)** — 网页端 Optimizer 页签的角色被动/光锥效果条件面板:

| 工具                    | 功能                                                                                                                                                                                                                                                                                               |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `describe_conditionals` | 角色(及光锥)全部条件开关定义:key、中文标签/描述、类型(boolean/select/slider)、默认值、枚举选项、星魂/叠影门槛与档位数值、来源;与网页端同源(zh_CN conditionals.yaml),不需要先 load_save;改值写进 optimize 的 formOverrides;`includeAbilities=true` 附连招技能枚举,`includeSets=true` 附套装条件定义 |

用法要点:必填仅 `characterId`。`eidolon` / `lightConeId` / `superimposition` 缺省时按回退链解析——显式入参 → 存档表单中该角色的当前值 → 角色配置默认光锥(叠影 1);返回的 `resolved` 段标明每项实际来源。返回的 `defaultConditionals` 可直接作为 `optimize` 的 `formOverrides.characterConditionals` / `lightConeConditionals` 底稿再改差异项。数值随星魂/叠影档位变化:不给 `eidolon` 时只能看到当前档的数值(门槛与升级档列表仍完整)。

**导入域(imports)** — 网页端「导入」页签的文件上传入口:

| 工具                  | 功能                                                                                                                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `import_scanner_json` | 导入扫描器 JSON(HSR-Scanner / Reliquary Archiver / Yas):按遗器 hash 匹配库存,reliquary 已验证件覆盖同 hash 件的副词条;`merge=union`(默认)按 hash 并集保留现有库存、`replace` 为上游原生整库替换;支持 dryRun / existingCharactersOnly |
| `import_hoyolab`      | 导入 HoYoLAB 战绩 JSON:合并语义与 import_scanner_json 完全一致;导入角色等级与光锥等级规范化为 80(与网页端一致)                                                                                                                       |

用法要点:`path`(文件)与 `inline`(内联 JSON 对象或字符串)二选一;**需先 `load_save`**(未载入存档时导入直接报错,与 `reset_all` 口径一致)。`merge` 默认 `union`(按 hash 并集保留现有库存,合成清单意外小于现有库存时拒绝落盘);`replace` 是上游原生整库替换,慎用。`dryRun=true` 只统计不写入,建议先跑一次看 `added/updated/skipped` 预估。`existingCharactersOnly=true` 只导入库存已有角色(对应网页端「仅导入现有角色」勾选),遗器不受影响。导入件已验证(reliquary)时同 hash 库存件的副词条被覆盖并置 verified;未验证(kelz/yas/hoyolab)同 hash 件仅更新佩戴者/顺序,无实质变化记 `skipped`。

**展示柜域(showcase)** — 网页端 Showcase(展示)页签:

| 工具              | 功能                                                                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fetch_showcase`  | 按 UID 拉取 enka/mihomo 展示柜档案(上游代理端点 /profile/{uid}),经 CharacterConverter 转换去重后进程内缓存(cacheId);超时/网络/HTTP/畸形响应/空档案均结构化中文错误返回,不抛异常 |
| `import_showcase` | 把缓存(或内联 json)档案按网页端同一条导入链写入存档:relics / character / all 三模式,返回预计合并统计与实际增量交叉校验                                                          |

用法要点:典型链路是 `fetch_showcase`(拉取+缓存,返回 `cacheId`)→ `import_showcase`(默认取最近一次缓存;`cacheId` 可校验一致性,不匹配报错)。进程内只保留最近一次拉取缓存。`mode`:`relics`=仅合并遗器(不建角色不穿戴)、`character`=单角色(必填 `characterId`,按表单 upsert 角色再合并穿戴)、`all`=档案内全部角色。也可经 `json` 内联传入同一格式的 showcase 响应(先走同一条转换链)。与网页端一致:遗器合并始终覆盖档案内全部角色的遗器,`mode` 只决定 upsert 哪些角色。`fetch_showcase` 的 `source` 入参是**校验一致性**——传入且与实际返回不符时报 `source_mismatch` 错误且该次结果不写缓存。

**模拟域(simulation)** — 网页端战斗引擎的只读复算面(不改存档):

| 工具             | 功能                                                                                                                                                                                                                                                                  |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `simulate_build` | 单套配装战斗模拟:战斗/面板属性归约 + COMBO 总伤与逐技能/轮次伤害;`trace=true` 加伤害类型拆分表与逐动作 Buff 快照(带 角色/光锥套装 来源归因)                                                                                                                           |
| `stat_simulate`  | Stat Simulations 页签无头版:不依赖具体遗器,按「套装 + 四件主词条 + 副词条 roll 数」批量模拟假想配装,返回各变体 COMBO、属性归约、相对基准变体差值与排名;`saved=true` 运行表单已存列表,`fromCache`/`fromRelicIds` 从优化结果行/遗器 id 导入(查重后保存为已存模拟再运行) |
| `analyze_build`  | 新旧配装对比:COMBO/治疗/护盾与逐技能伤害对比、伤害拆分表(新旧各一份)、逐副词条 +1 roll 升级表、队友位面饰品升级表                                                                                                                                                     |
| `benchmark_runs` | Benchmarks 页签无头版:按预设集(4pc 候选 × SPD 阈值)批量跑战斗基准,返回每预设 100% 基准 / 200% 极限分与排名;长任务支持 progressToken 进度与取消(保留已完成部分)                                                                                                        |

用法要点:四个工具都基于角色**已保存的优化表单**(`formOverrides` 与 `optimize` 同语义合并)。`simulate_build` 的 `relicIds` 缺省取角色当前装备;`analyze_build` 的 `newRelicIds` 必填、`oldRelicIds` 缺省取当前装备——**不支持从 optimize 结果行直接引用**(用行内 `builds` 字段的遗器 id 组装,见已知限制 #11)。`stat_simulate` 的变体字段名与上游 SimulationRequest 一致(`simRelicSet1/2`、`simBody/Feet/PlanarSphere/LinkRope`、`stats` 副词条→roll 数),上限 12 个变体,`baselineIndex` 指定差值基准。`benchmark_runs` 预设上限 16 个,`spdThreshold` 0/缺省=不限速,光锥/星魂/队友均可覆盖(缺省取评分元数据推荐队)。

**计算器域(calculators)** — 纯计算,不读写存档:

| 工具        | 功能                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------- |
| `warp_plan` | 跃迁规划器:各里程碑(E0S1…E6S5)期望抽数与达成概率(同一 calculateWarps 路径);`fromSaved=true` 改用存档底稿(需先 load_save)  |
| `calc_aha`  | 阿哈速度计算:队友战斗速度 → 阿哈提供速度(基速 80 + 按排名 1/5、1/10、1/20、1/40 分档贡献)                                 |
| `calc_ehr`  | 目标效果命中求解:给定敌方抗性/基础概率/次数/目标概率反解所需效果命中;不可达返回 achievable=false(requiredEhr=null,不是 0) |

用法要点:`warp_plan` 纯计算不读写存档;`income` 的 id 格式为 `<版本>_p<半>_<档>`(如 `4.5_p1_1`,档位 1=F2P / 2=EXPRESS / 3=BP_EXPRESS),合法值以返回体 `incomeOptions` 为准(随游戏版本由上游表维护);`fromSaved=true` 可回放存档里保存的规划底稿。`calc_aha` 的 `speeds` 传队友战斗速度数组(空槽不传)。`calc_ehr` 各入参为百分数值;目标概率不可达时返回原因列表而非 0。

**队伍域(teams)** — 网页端「组队展示」页签(#teams):

| 工具         | 功能                                                                                                                                                                                      |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `save_team`  | 队伍写入:不传 teamId 新建、传入则原地更新;槽位 1–4(null=空槽);非空 id 须在游戏元数据中;槽位变化时弃基准快照;`benchmarkSnapshot=true` 保存时现场捕获基准快照(与网页同步按钮同一条捕获路径) |
| `list_teams` | 已保存队伍列表:槽位详情(角色/命途/属性/是否在当前列表)+ 基准快照(benchmarkSnapshot)                                                                                                       |

用法要点:`save_team` 不传 `teamId` 新建(需 `name` + `characterIds`),传入则原地更新(至少提供 `name` 或 `characterIds` 之一);槽位数组 `null` 为空槽,不足 4 个自动尾部补 null;非空角色 id 须在游戏元数据中。更新时槽位变化会按网页端规则弃用基准快照。与网页端一致:不带 `benchmarkSnapshot` 的保存**不会**把缺失角色补进角色列表(网页是在「加载队伍」时补);`benchmarkSnapshot=true` 会先按默认表单补进缺失成员再现场捕获快照(因此要求成员都已装备光锥,未拥有成员会先行报错)。

**同步桥域(bridge)** — MCP→网页端单向推送(伪 Reliquary Archiver websocket 服务):

| 工具                 | 功能                                                                                                              |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `sync_bridge_start`  | 启动同步桥(默认端口 23313,仅监听 127.0.0.1);网页端「导入」页开启实时导入并连接后即收到全量数据                    |
| `sync_bridge_status` | 运行状况:监听端口/地址、在线网页端客户端数、累计与最近一次推送统计、当前可推送的遗器/角色数量                     |
| `sync_bridge_stop`   | 停止服务并断开所有网页端客户端(未启动时幂等空操作)                                                                |
| `sync_bridge_push`   | 立即全量重推(InitialScan 帧)给在线客户端;变更驱动的自动推送由存档写回触发(flushSave 钩子),本工具用于手动校准/补推 |

同步桥使用要点:

- **定位是单向推送**:MCP → 网页端的便利通道,把当前载入的存档伪装成一份 Reliquary Archiver v4 全量扫描推给网页端实时导入。**网页 → MCP 的正式回流路径是网页端导出存档文件 → `load_save`**,不承诺实时双向同步。
- **端口默认 23313**(`sync_bridge_start` 的 `port` 入参可改,仅监听 127.0.0.1)。网页端「导入」页 →「实时导入控制」→ 高级设置里的 Websocket 地址保持默认 `ws://127.0.0.1:23313/ws` 即可(本服务接受任意路径);换了端口须两边一致。端口被占(如真 Archiver 在跑)会启动失败并提示换端口。
- **需在网页端开 4 个开关**:「实时导入控制」区共 4 个开关——①「启用实时导入(推荐)」**必开**;②「启用角色已装备遗器和光锥的更新」——要同步角色及其配装才开;③「仅更新已有角色」——按需(含义同导入工具的 `existingCharactersOnly`);④「启用跃迁资源导入」——对本桥无意义(桥不推送星琼/材料),保持关闭。
- **行为**:网页端一连上(含断线重连)立即收到全量 InitialScan;此后每次存档变更自动重推全量(幂等合并);在 MCP 侧删除的遗器以 DeleteRelics 事件先于全量帧同步删除。
- **已知**:网页端开②后会把导入角色统一按 80 级/光锥 80 级落库(上游固定行为);优化器不追踪遗器锁定状态,帧内 `lock` 恒 false;退出进程前建议先 `sync_bridge_stop`(见已知限制 #10)。

### M4 状态与任务域(4 个)

**状态域(state)** — 全站覆盖计划 M4 的设置/会话/标记/扫描器配置读写:

| 工具           | 功能                                                                                                                                                                                                                                                                       |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_state`    | 按 section 读取:`revision`(修订号/世代/dirty/blockedWrite)、`settings`(六项设置当前值+定义,默认值派生自上游)、`session`(持久化 savedSession+易取的临时态)、`flags`(seenFeatures+未读派生)、`scanner`(六字段+customUrl 派生)、`showcase`(按角色的展示卡偏好,含槽位评分类型) |
| `update_state` | 按 section 写入(未知键拒绝、枚举校验);可选 `baseRevision` 乐观并发检查(不匹配报冲突,消息含双方修订号);整体走 withChange 事务,失败回滚                                                                                                                                      |

**任务域(jobs)** — 长任务统一注册表(optimize/benchmark_runs 已接入,评分与后续任务逐里程碑接入):

| 工具         | 功能                                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------- |
| `get_job`    | 无参列出全部任务(id/类型/状态/时间);带 jobId 返回详情(进度、可否取消、摘要引用——optimize 的 jobId 即返回的 cacheId) |
| `cancel_job` | 取消运行中的任务(复用既有取消路径,optimize 保留部分结果);已结束任务返回其终态而非报错                               |

### M5 角色、遗器、表单与队伍域(4 个)

**遗器 CRUD 域(relics)** — 网页端遗器编辑器与库存删除:

| 工具            | 功能                                                                                                                                                                                                                                                                         |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `upsert_relic`  | 新建/编辑遗器,走编辑器同一条保存链(部位/主词条/套装联动重置、副词条校验、规范化、主词条数值重算);`equippedBy` 传角色装备(null=卸下、不传保持,跨角色转移遵守全局 Replace/Swap);`previewUpgrade`/`previewSubstats` 预览不落盘;`dryRun` 全校验+装备变更演练;可选 `baseRevision` |
| `delete_relics` | 按 id 批量删除(已装备件同步清理 character.equipped 引用);任一 id 不存在则整体拒绝、零删除;删光库存时按网页端解除空存档写回限制                                                                                                                                               |

**表单域(form)** — 网页端 Optimizer 页签的持久化表单写路径:

| 工具          | 功能                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `update_form` | 单工具 + 具名子载荷:`characterId`(上游 switchToCharacter 语义——自动保存离开角色的表单再载入)、`patch`(部分字段更新,未知键拒绝并列合法清单)、`preset`(速度预设)/`reset=filters`、`combo`(六种编辑映射连招抽屉动作,条件改动经 handleConditionalChange 同步连招默认值)、`teammates`(+`syncFromRoster=true` 走选人联动)、`fromBuild`(已存配装载入表单)、`statSimulations`(假想配装列表增/载/覆盖/删/全清);可选 `baseRevision`;非致命校验警告独立以 `warnings` 数组返回 |

用法要点:`update_form` 写的是**持久表单**(落角色存档);`optimize` 的 `formOverrides` 仍是单次运行覆写,两者叠加关系与网页「表单 vs 临时改」一致。多子载荷可组合,按 `fromBuild → reset → preset → patch → combo → teammates → statSimulations` 固定顺序应用。

**队伍操作域(teams 扩展)** — 网页端「组队展示」页签的工作队伍与已保存队伍管理:

| 工具          | 功能                                                                                                                                                                                                                                                                                                                                                                 |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manage_team` | `action=load / delete / move / compose / sync_benchmarks / get`:已保存队伍的载入(缺失角色按网页规则补进角色列表)、删除(显式 teamId)、重排;`compose` 工作队伍编排(`op=set_slot / reorder / clear`,含未拥有角色补入与空队自动补队,槽位变更弃基准快照);`sync_benchmarks` 把工作队伍基准快照写回活动已保存队伍;`get` 只读工作态(会话级内存态,换档重置——网页刷新的对应物) |

### M6 扫描器、评分、榜单与分析域(4 个)

**扫描器域(scanner)** — 网页端「实时导入」的 ws 客户端对应物(MCP 主动外连真实扫描器):

| 工具      | 功能                                                                                                                                                                                                                                                                                                               |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scanner` | `action=connect(url?) / disconnect / status / events`:连接 Reliquary Archiver 等扫描器的 WebSocket;事件帧按网页 scannerStore 同一条链应用(InitialScan 走 union 合并、UpdateRelics 仅 5★ 落库、DeleteRelics 清引用、UpdateGachaFunds 写跃迁底稿;GachaResult 按网站行为忽略仅记录);事件日志环形缓冲可查,畸形帧不断连 |

**角色评分域(scoring 扩展)** — 展示卡模拟评分引擎的完整接入:

| 工具              | 功能                                                                                                                                                                                                                                                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `score_character` | `source=roster / build / showcase`(展示柜来源支持角色/光锥覆写);`config=auto / dps / buffer / heal / shield`(BUFFER/HEAL/SHIELD 首次接入,auto=展示卡默认评分类型,无模拟配置的角色报可操作中文错);`teammates` 临时队伍不落盘、`team=default` 强制官方队;`spdBenchmark` 临时基准速度;`deprioritizeBuffs` 覆写;`trace=true` 动作/标签增益汇总 |

**排行榜域(leaderboard)** — 只读数据层(上游 import.meta.url 定位在 headless 不可用,改为显式来源):

| 工具          | 功能                                                                                                                                                                                                                                           |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `leaderboard` | `view=characters / board / entry / timeline / my_ranks`;`source=auto / network / url`(network=上游发布地址,与网页 localhost 的 beta fallback 同源;url=自定义 base);进程内缓存带版本,返回体带 source/version/fetchedAt;**拉取失败不作空榜成功** |

**遗器分析域(relics 扩展)** — 遗器页三个分析面板:

| 工具            | 功能                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `analyze_relic` | `view=characters`(适配角色推荐+潜力分桶,与网页洞察面板同序同过滤)、`view=location`(背包定位网格)、`view=reroll`(重掷前后对比,纯计算) |

本里程碑同时落地大量既有工具扩展(全部 add-only):`optimize(validate / diagnose / applyFixes / resultsLimit≤65536)`(诊断与修复复用上游 suggestionsEngine,修复走 withChange 事务)、`get_results(rowIds=…)`(按行 id 固定取行)、`import_scanner_json/import_hoyolab(includeCharacters=false)`(只导入遗器)、`set_scoring_override(configs=… / resetAll / linkFlatAndPercent)`(评分队伍编辑/重置/同步/增益优先级)、`score_relics(scope / rollsSummary)`、`list_relics(sortBy)`、`fetch_showcase(remember=true)`(多缓存)、`calc_aha(desiredAha / save / fromSaved)`、`calc_ehr(mode=probability / grid)`、`warp_plan(applyPlannerMode / normalizeTargets / save)`、`benchmark_runs(sweep=sets)`(套装基准审计)、`update_state/get_state(session)` 扩 `language`、`load_save(sample=true)`,以及新资源 `game://metadata/scoring`(评分元数据六面板)。

### M7 浏览器、渲染与诊断域(5 个)

受管浏览器运行环境:puppeteer-core + 本机 Chromium 系浏览器(绝不下载浏览器),本地静态伺服上游站点构建产物(同版本页面/字体/素材);每个任务独立浏览器上下文,预写 `localStorage['state']` 种子(与 `SaveState.save()` 逐字节同构),浏览器侧改动不回写 MCP 存档。缺浏览器或缺 dist 时返回具体的中文能力报告(`get_runtime_capabilities`),冒烟自动 [SKIP]。

| 工具                       | 功能                                                                                                                                                                                                                                                                                                                          |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_runtime_capabilities` | `action=status / launch / close`:浏览器可执行文件与版本、站点 dist、Node、产物目录、WebGPU 适配器探测(vendor/architecture/软适配器判定)、当前 computeEngine;launch 幂等启动 + 探测,close 关停不残留进程,产物保留;status 零副作用                                                                                              |
| `render`                   | `target=character_card / saved_build / team_card / portrait / page`:走网页自己的 snapdom 导出链(点真实截图按钮,拦截 clipboard/download 分支捕获 PNG,与网页导出逐像素同构;spine 动画与肖像裁剪用 CDP 截屏);返回 image 内容块 + 产物落盘(artifactId/宽高/字节数);`page` 附可交给用户的本地 URL                                  |
| `deliver_artifact`         | `action=list / read / copy / share / delete`:产物清单/读取(内联图片)/删除;`copy` 在受管浏览器里回放网页「复制」按钮同一条链(ClipboardItem + clipboard.write——桌面 Chrome 通常即系统剪贴板,服务器环境可能无接收方,如实回报 ok 与原因);`share` 探测 Web Share 平台分支并如实报告可用性(无头环境预期不可用,不宣称任意客户端支持) |
| `debug_utility`            | `action=webgpu_tests / image_center / populate_characters / reset_showcase_colors / export_showcase_colors`:隐藏 WebGPU 测试页真跑(逐用例状态 + CPU/GPU 数值 + 公差;本机 250 条全量约 2–4 分钟)、图片中心编辑器驱动(center/zoom 调整 + 预览截图 + 配置复制)、`window.__HSR_DEBUG` 三个控制台工具的 Node 侧直调                |
| `set_portrait`             | `action=set / reset`:自定义肖像写入/清除,逐字镜像上游 showcaseOnEditPortraitOk 语义(set 对缺库角色自动补入、reset 保留角色);PNG/JPEG/WebP 尺寸嗅探纯 Node 实现(data URL 就地/远程流式截断),crop 参数与 artistName 署名齐备                                                                                                    |

本里程碑的既有工具扩展:`optimize` 新增 `engine=auto / cpu / gpu / gpu-experimental`(默认 auto=Node CPU 路径不变;GPU 路径在受管浏览器里驱动网页真实 GPU 引擎——经查上游 GPU 走主线程 gpuOptimize 而非 workerPool,UI 驱动即真实执行路径——返回 actualEngine 与 CPU 对拍 delta);`get_state/update_state` 新增 `visualDebug`(19 个视觉调试参数 + cardDebug,会话态不落盘)、`relicsTab`(excludedRelicPotentialCharacters 落盘读写 + recentRelics 只读投影)、`layout`(表单分区折叠状态落盘读写)三段。

### M9 收尾与验收(不新增工具,全部走参数扩展)

- `benchmark_runs`:`teammates[].teamRelicSet/teamOrnamentSet`(队友队伍套装)、`setConditionals`(预设套用后手动改,网页抽屉语义)、`candidateLimit`(≤50,两口径全候选行)、`includeCandidateDetails`(展开行面板/战斗属性/技能伤害)、未入库角色可跑(需显式光锥)。
- `analyze_build/simulate_build`:`fromCache={cacheId,rowId?}` 沿用那轮 optimize 实际表单;`newRelicIds` 在有 rowId 时可省。
- `list_characters`:`name` 子串(当前渲染语言的长名)+ `path/element` 多选;`list_relics`:九组筛选全多值、强化三级一档、多副词条(含预览)、`initialRolls`、`equipped` 轴。
- `dps_score`:`team=snapshot` + `snapshotTeamId` 用已保存队伍基准快照覆盖(网页同函数链,槽 0 主 C/其余副 C)。
- `leaderboard`:`view=score` 本地复算(scoreLeaderboardBuild 同维护者管线,recorded/recomputed/delta 对比);`render`:`source=leaderboard` 渲染榜单风格卡(#leaderboard?b= 共享链接路径,LEADERBOARD 语义由真实页面保证)。
- `reset_all`:`persist=true` 清空即落盘(网页语义);进程启动自动恢复上次存档(boot-load,`HSR_MCP_NO_BOOT_LOAD=1` 关闭)。
- `update_state(section=showcase)`:`color/colorMode` 写入口(STANDARD 全局联动,默认色不保存)。
- 资源:`game://metadata/characters` 增 `nameZhLong/hasSimulation/signatureLightCone`,光锥详情 `signatureOf` 反查。
- 验收基建:coverage-check 强制 implemented 行有真实冒烟链接 + 基线分母/增强项独立报告;`smoke:visual` 视觉回归(基线 PNG 容差比对,`--update-baseline` 再生成);`check:packaged` 仓库外完整安装验收;mcp 依赖补齐至全部运行时 external(14 个,便携运行自包含)。

### game:// 与 site:// 资源(11 项)

只读元数据面,与工具同进程注册(`src/resources.ts`);列表资源只带摘要,单实体详情走 URI 模板(模板不占 resources/list,经 templates/list 发现):

| URI                               | 内容                                                                                                              |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `game://metadata/characters`      | 全角色列表摘要:id、中文名、稀有度、命途/属性(规范英文值)、unreleased、preNovaflare                                |
| `game://metadata/characters/{id}` | 单角色详情:80 级基础属性、行迹树完整结构、行迹加成汇总、max_sp、中文名/长名                                       |
| `game://metadata/lightcones`      | 全光锥列表摘要:id、中文名、稀有度、命途、unreleased                                                               |
| `game://metadata/lightcones/{id}` | 单光锥详情:基础属性 + S1-S5 叠影属性表(可读属性名口径)                                                            |
| `game://metadata/sets`            | 62 项遗器/饰品套装表:id、中文名、2pc/4pc 中文效果文本、英文合并文本(附口径 note)                                  |
| `game://metadata/scoring`         | 评分元数据六面板(随版本发布的默认配置,不反映本地覆盖):substatWeights/sets/teams/combo/setPresets/leaderboardTeams |
| `game://changelog`                | Changelog 页签原文(上游仅英文,53 期约 77KB JSON)                                                                  |

site:// 站点面(M7):URL 逐条核对自上游源码,不凭记忆:

| URI                   | 内容                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------ |
| `site://pages`        | 13 个页面清单:AppPages 枚举、hash(PageToHash)、zh 标题、render(page=…) 参数值域、可交接 URL 形态 |
| `site://links`        | 站点外链:首页社区卡、侧边栏组、页眉、Enka 署名、贡献者等真实 URL                                 |
| `site://home`         | 首页能力清单:优化器版本、游戏数据版本(直接 import 上游常量)、站点能力入口摘要                    |
| `site://help/{topic}` | 导入帮助主题(模板资源):reliquary / kelz / hoyolab / live-import / scorer 的真实链接与说明        |

「行→配装」不另设 resource:optimize/get_results 已随行返回 builds 字段(每行 6 槽遗器 id),再设一个 resource 只会复制同一份缓存。

## 对拍 harness(`scripts/parity.mjs`)

M1 验收标准「同一存档同一 Form,MCP optimize 与上游引擎逐行一致」的回归测试。MCP 的 driver 本就跑上游原版 `Optimizer.optimize`,因此对拍重点是**封装层不引入漂移**:

- (a) 连续两次 stdio optimize 结果完全确定(id 序列 + 全部数值列逐一相等);
- (b) **进程内基准**:`dist/parityRef.js` 用与 optimize 完全相同的规范化产物(saved form → `computeLoadForm` → `displayToInternal`,不走 formOverrides,快照与 `flushSave` 一致)直喂 `runOptimization`,与 stdio 结果逐行比对(firstMismatch 风格),必须全等;
- (c) `formOverrides.setFilters` 套装约束轮:结果与无约束轮不同且有效排列数下降;
- (d) 大库存(~1944 件,12x 克隆)闸门:默认被拒并返回各部件计数与收紧建议;`force:true` 放行后立即取消,断言 cancelled 语义与部分结果保留;
- (e) 擦写保护:`reset_all` 后磁盘存档未被空状态覆盖;随后的「产生角色的写操作」(relics 集合萎缩到 0)同样被拦截。

基准数字(sample-save,1212b1):有效排列 462,672;top1 id=248720,COMBO=455620.9375;4pc「冰林猎人」约束后 17,280 排列、top1 COMBO=441576.84;1944 件库存默认过滤约 1.38e12 排列(闸门拒跑)。

## 持久化与安全护栏

- **防抖写回**:变更工具 `markDirty()` 后 1s 防抖,`SaveState.save()` 序列化写回载入路径。SIGINT/SIGTERM **与 stdin EOF/transport 关闭**走同一套关停:取消挂起定时器、同步 flush(存档文件 + localStorage 后端)、terminate driver worker、`exit(0)`——SDK 客户端只是关闭管道(不 SIGTERM)也能让进程与 ~2GB 引擎堆毫秒级回收,防抖窗口内已确认的变更不丢。
- **擦写保护(关键集合萎缩拦截)**:写回若把磁盘存档中非空的 `relics` 或 `characters`(任一)清零即拦截——涵盖 `reset_all` 后的任何后续写操作(如 `{relics:0, characters:1}` 覆写 162 件遗器的存档),**也包括正常操作走到同一终点**(如 `delete_character` 删到只剩最后一个角色:那次写回会把 characters 清零,同样被拦);无法解析的状态同样按擦写处理。要把刻意的清空持久化,用 `export_save`(它是刻意的、显式目标的写入,不受此拦截)。
- **上游 SaveState 防擦写护栏的参照同步**:`SaveState.save()`(上游 saveState.ts)自带第二层护栏——当前 stores 把 localStorage `state` 参照里仍非空的角色/遗器集合清为零时拒绝序列化并返回空。`load_save` 在载入后立刻把载入数据(迁移后)同步进该参照,护栏参照因此始终与当前存档一致(否则换载一份空角色存档后,参照仍停留在上一份存档,本会话所有写回会被静默吞掉)。若护栏仍拒绝序列化(如刻意清零且未走 `export_save`),写回**不会**被当成成功:dirty 保持 true、stderr 报告 blocked write-back、返回值带 `blockedWipe: true`,变更留待后续 flush/export 落盘。
- **export_save 三道护栏**:① 目标是符号链接时拒绝(`lstatSync`,不沿链接覆写);② 目标已存在但不是存档形状(同时缺 `relics` 与 `characters` 数组)时拒绝,防止覆写 `~/.zshrc` 等无关文件(刻意的空存档——数组存在但为空——是合法目标);③ 同目录 `.tmp` + `renameSync` 原子替换,中断不留半截文件。
- **optimize 缓存世代校验**:`equip_build`/`save_build` 的 `fromCache` 缓存带三重校验——cacheId 必须是最近一次运行、缓存归属角色必须与 `characterId` 一致、**缓存不得跨 `load_save` 使用**(世代计数;换档后旧缓存的遗器 id 可能与新库存撞号,直接拒绝并提示重跑 optimize)。
- **worker 不碰共享状态文件**:localStorage 文件后端的 exit hook 仅主线程注册——driver/pool worker 各自的内存视图在回收时不得覆写 `HSR_MCP_STATE_FILE`(旧行为:池 worker 30s 空闲回收时把文件写成 `{}`);`flush()` 自身也带防御:从未写过且内存为空时跳过。

## 已知限制

1. **旧存档的 `relicSets`/`ornamentSets` 在规范化时被丢弃**:上游 `internalFormToState` 只映射 `setFilters`,旧版存档里以遗留字段保存的套装约束不会进入优化请求(get_form 的 `legacyKeysDropped` 会列出它们)。agent 应用 `formOverrides.setFilters`(如 `{ fourPiece: [...] }` / `{ ornaments: [...] }`)重新加套装约束。
2. **`equip_build`/`save_build` 的 `fromCache` 只认最近一次 optimize 缓存**:进程内只保留最后一次运行的行;引用更早的 cacheId 会报错并提示当前缓存 id。缓存带归属校验与**世代校验**:`fromCache` 缓存的角色与 `characterId` 不一致时报错;`load_save` 之后旧缓存直接失效(报错提示重跑 optimize)。`save_build fromCache` 的表单快照取该次运行实际使用的表单(已合并 `formOverrides`),不是角色已保存表单。`equip_build fromCache` 装备前会把该表单回写为角色表单(网页端装备按钮同样先 `upsertCharacterFromForm`);显式 `relicIds` 分支不改动表单。
3. **装备遇库存缺失件是"跳过其余照装"而非全或无**:与上游 `equipRelicIds` 的逐件 `if (relic)` 语义一致——已保存配装引用了被删除的遗器时,其余件照常装备,缺失件在返回的 `skipped: [{part, relicId}]` 列出;仅当**全部**缺失时报错。
4. **`weightScore` 恒为 null(诚实化)**:加权分只在优化管线内部计算(对克隆遗器),主线程从不计算/刷新;存档文件可能残留网页端历史保存的 weightScore(如 sample-save 中 35/162 件),不代表任何当前角色——`list_relics`/`get_character` 输出一律 null,`sortBy` 也不再接受该键。按角色打分请用 `score_relics`。
5. **`dps_score` 的 `benchmarkSpd` 可能为 null**:部分角色的评分基准不设 SPD 目标(上游 `spdBenchmark` 为空),此时仅 `originalSpd` 有值,属合法输出而非缺数据。
6. **字母评级 `'?'` 的合法情形**(不是 bug):`score_relics` 的当前分评级在 ① 非 5★ 遗器、② 加权分为 0(该角色权重下无有效词条)、③ Body/Feet/PlanarSphere/LinkRope 主词条不在该角色评分候选内 时返回 `'?'`(低于最低档 F 亦然);`dps_score` 的评级在未满 6 件装备或无光锥时返回 `'?'`。
7. **`SEQUENTIAL_BENCHMARKS` 进程内置位**:首次调用 `dps_score` 会把该全局标志置 true 并保持到进程结束——本服务内所有最优模拟搜索都应在主线程内联执行(浏览器 worker 池未接线),这是有意的;但意味着该进程内其他依赖该标志的代码路径也会切换到串行。
8. **评分数值为 Float32 打包精度,不做四舍五入**:优化行与评分里的伤害/百分比来自引擎的 Float32Array 打包(与网页端网格显示一致),跨工具复算可能有 1e-7 量级相对误差(见 spike S5c 实测 1.4e-8)。
9. **上游 `persistenceService.mergeRelics` 本身是整库替换语义**(继承自上游):导入工具在其之上实现 hash 并集合并——`merge=union`(默认)先合成完整并集清单再走整库写入,并集清单意外小于现有库存时拒绝落盘(反擦写);`merge=replace` 保留上游原生语义,未被导入件覆盖的旧遗器会被丢弃(见方案 §2 勘误 #5)。
10. **同步桥的退出钩子已接线 `closeBridge`**(2026-10 复核修复批次):关停流程(SIGINT/SIGTERM/EOF)会关闭 ws 监听并对在线网页端客户端发干净的关闭帧;退出前显式调 `sync_bridge_stop` 仍可用于即时停止(不必等进程退出)。
11. **`analyze_build` 不支持从 optimize 结果行引用配装**:M1 的 `fromCache` 机制不在此工具上(`equipment.ts` 的 `resolveCachedBuild` 未导出)。agent 需用 `optimize`/`get_results` 行内 `builds` 字段的遗器 id 自行组装 `newRelicIds`。
12. **`benchmark_runs` 的取消只在预设之间生效**:上游 orchestrator 内部无取消信号,已开始的预设会跑完(单个预设内联约 0.3–2s),取消后返回已完成部分。
13. **中文标签的三处上游现状**(原样透出,与网页端一致):①个别旧条件文件(如 Pearl)标签为上游硬编码英文;②角色名册个别新角色/光锥 zh_CN 缺译,返回 `null` 而不回显 key;③`game://changelog` 为上游英文原文,且条目 `title` 多为空串、以 `date` 标识(仅首条带版本标题)。
14. **工具异常消息中英混杂**:M1 基础域(archive/query/optimizer/equipment/scoring)的 `throw` 异常消息为英文,M2/M3 扩展域(imports/showcase/simulation/conditionals/calculators/teams/bridge)全中文——`mcp/src` 127 处 `throw` 中 33 处为纯英文(含内部对拍入口 `parityRef.ts` 1 处)。结构化字段不受影响,仅同一会话内报错语言不一致;统一语言属文案级重构,登记暂不处理。
15. **`analyze_build` 的 `statUpgrades` 是 12 副词条全量**:升级表与网页端同源(`calculateStatUpgrades` 遍历全部 SubStats),对每个上游副词条各 +1 roll——**包括该配装不存在/不适用的词条**;`pct` 字段为百分数口径(已乘 100,如 `12.3` 表示 12.3%)。agent 需要「只看已有词条」的视图时,按 `builds` 内遗器的副词条自行过滤。
16. **浏览器工具的平台条件**(M7,如实登记):`deliver_artifact(copy)` 写入的是受管无头浏览器的剪贴板(桌面 Chrome 通常即系统剪贴板,服务器环境可能无接收方);`share` 依赖 Web Share 平台分支,无头环境预期不可用并如实返回原因——不宣称任意 MCP 客户端都支持系统分享。`debug_utility(action=webgpu_tests)` 全量真跑约 2–4 分钟(250 条);GPU 可用性取决于设备(软适配器会在探测里标明)。CDP 剪贴板授权经实测**反而**会让 headless 拒写(Chrome 154),故不授权——详见 browserManager 源码注释。
17. **`render(target=portrait, animation=true)` 的 L2D 帧是就绪后截取的当帧**:spine 画布 `preserveDrawingBuffer:false`,snapdom 无法捕获,用 CDP 截屏(与上游截图链对静态图的替换策略一致);spine 渲染循环在页面失焦时暂停,无头下偶发静止帧属平台现状。
18. **eidolon 术语统一为「星魂」**:工具文案中的 eidolon 规范写作「星魂」(2026-10 复核批次已清理 showcase/simulation/equipment 等全部旧写法「魂影」,现 `mcp/src` 内零残留)。入参字段名(`characterEidolon`/`eidolon`)与取值不变。

## P3 登记(已知但暂不修)

- **`dps_score` 并发无锁**:两个并发的 `dps_score` 会同时读写 `SEQUENTIAL_BENCHMARKS` 相关全局与 store,结果可能交叉污染。M1 语义按网页端单用户串行使用设计;若 M2 需要并发安全,加一个进程内互斥即可。
- **`scoreRelicsThread` 为 M2 预留、无 M1 消费方**:`score_relics` 在主线程同步计算(162 件约 7ms),worker 入口仅在构建期接线(见 `src/worker/scoreRelicsThread.ts` 头注释)。
- **错误路径覆盖待补**:smoke 断言集中在 happy path 与少数关键错误(unknown id、缓存归属/世代、重名、擦写保护);其余错误分支(坏 JSON、越界分页之外的畸形输入等)依赖 zod 校验,专项断言待 M2 补齐。
- **恒真断言已清理**:曾存在的 `JSON.parse(JSON.stringify(x)) != null` 类恒真断言已替换为具体字段类型检查(dps_score round-trip 断言)。

## M2/M3 已交付登记(方案 §7)

原「M2 待办」清单已全部交付,纳入上方「M2/M3 扩展域」:

- `import_scanner_json`(kelz v4 / reliquary v4 / yas v3)与 `import_hoyolab`——按 hash 并集合并包装 `mergeRelics` 并支持 `existingCharactersOnly`(方案 §2 勘误 #5 / §9 D1)✅
- `describe_conditionals` + i18n Node 引导(读 `public/locales/zh_CN/*.yaml` 注册 i18next,条件选项带中文标签枚举)✅
- `stat_simulate`(假想配装模拟)/ `simulate_build`(单套复算,`trace` 逐动作伤害拆分 + buff 归因)/ `analyze_build`(新旧对比、+1 roll 升级表)✅
- `benchmark_runs`(Benchmarks 页签复刻)✅
- `warp_plan` / `calc_aha` / `calc_ehr`(纯计算器)✅
- `fetch_showcase` / `import_showcase`(enka/mihomo 档案)✅
- teams 数据面(`save_team`/`list_teams`)✅
- stats 归约器(`ComputedStatsContainer → JSON`,随 simulate_build/stat_simulate 返回)✅;套装效果描述面(`game://metadata/sets`)✅;「行→配装」按方案有意折叠进 optimize/get_results 的行内 builds 字段,不另设 resource
- 全部工具的 outputSchema 声明(§9 D7)✅(61 个工具全覆盖;11 个 `game://`+`site://` 资源不适用——SDK 的资源配置无 outputSchema 参数,见方案 §10 D12)
- 追加交付:同步桥 `sync_bridge_start/status/stop/push`(MCP→网页端单向推送,变更驱动自动重推)与 6 项 `game://` 元数据资源

留尾巴(未做成/未覆盖,如实登记):

- ~~`closeBridge` 未接进 `index.ts` 的退出钩子~~(已由 2026-10 复核修复批次接线,见已知限制 #10)。
- `fetch_showcase` 的**成功路径**冒烟未覆盖(真实外网拉取→cacheId→`import_showcase` 走缓存的链路);错误路径 7 分支全覆盖(离线 stub),导入缓存路径经内联 json 间接验证。
- 导入 union 防擦写守卫的 `throw` 分支从工具输入数学上不可达(每个导入件最多消耗一个 hash 桶条目,并集清单恒 ≥ 现有库存),冒烟以「严格子集 union 导入保库存」断言实际防护效果;守卫分支本身需注入式单测(如模拟桶配对 bug)覆盖。
- 同步桥未做真实网页端浏览器端到端联调:帧形状/反向映射/count-step 编码经静态对拍与 ws 冒烟校验,真实浏览器回环留待联调阶段。
- reliquary(verified)导入件同 hash 覆盖副词条/置真/id 改链的 `mergeRelics` verified 分支未在冒烟中单独覆盖(任务断言清单未列)。

## 与 spike 的关系

`mcp/spike/`(spike.ts / spikeParallel.ts / engineA.ts 等)是方案阶段的一次性可行性验证代码,其结论(垫片、worker 适配层、对拍方法)已全部提升进 `mcp/src/`,对拍方法也已沉淀为常规回归 `scripts/parity.mjs`。**M1/M2/M3 验收通过后已整体删除**;历史完整保留在 commit `81f0789a`,需要时 `git checkout 81f0789a -- mcp/spike` 即可恢复。
