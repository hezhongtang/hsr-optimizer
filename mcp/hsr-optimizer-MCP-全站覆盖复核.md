# HSR Optimizer MCP 全站覆盖计划：源码复核记录

日期：2026-10-06。基线：`feat/mcp-server` / `3f101eec`。

结论：两轮复核均发现具体漏项和能力归类错误。第二轮补出了文件“只导入遗器”、假想配装生命周期、表单条件联动和分析视图等动作，并纠正已有覆盖/重命名/导出能力和状态持久化边界。已修订[实施计划](./hsr-optimizer-MCP-全站覆盖计划.md)。本次只修改规划文档，没有实现或修复业务代码。

本次通过已建立的 CodeGraph CLI 核对导航、overlays、网页业务入口和 MCP handlers，并补读被输出截断的具体代码段。会话没有可调用的 CodeGraph MCP 工具，未将 CLI 查询称作 MCP 调用。复核是源码审查；尚未完成真实浏览器的全站逐项盘点，不能据此宣称“已证明绝无遗漏”。

## 1. 第一轮发现及第二轮校正

| 项目 | 核对结果 | 计划中的修订及验收点 | 代码依据 |
| --- | --- | --- | --- |
| 效果命中计算 | 网页同时算应用概率和所需命中；`calc_ehr` 只有所需命中反算，上一版“正算已覆盖”错误 | 补单次/累计成功概率、热图窗口与网格数据；正反算分别验收 | [EhrPanel](../src/lib/tabs/tabCalculators/EhrPanel.tsx#L23)、[MCP calc_ehr](./src/domains/calculators.ts#L278)、[EhrGrid](../src/lib/tabs/tabCalculators/ehrViz/EhrGrid.tsx#L202) |
| 评分模式 | 网站有 DPS、BUFFER、HEAL、SHIELD；`dps_score` 固定使用 DPS | 三种额外模式独立列项；各模式升级分析按实际可用范围输出，保留现有 DPS 默认调用 | [评分配置注册](../src/lib/scoring/scoringConfig.ts)、[MCP DPS handler](./src/domains/scoring.ts#L285) |
| 自定义评分队伍 | 自定义配置与当前 default/custom 选择是两种状态；后者按角色/配置保存在运行期 store，不在 SaveState 输出中。优化器表单队友不是完整替代 | 接入配置级编辑和临时选择，禁止把选择自动变为永久字段；修正 `dps_score` 描述中“set_scoring_override 可改队友”的错误，实际 schema 只有 weights/parts/reset | [展示柜状态](../src/lib/tabs/tabShowcase/useShowcaseTabStore.ts#L81)、[存档序列化](../src/lib/state/saveState.ts#L72)、[评分覆盖 schema](./src/domains/equipment.ts#L912) |
| 评分全部重置 | 评分弹窗有“所有角色重置”，不只是单角色 reset | 清除全体覆盖的实际作用域和落盘副作用独立验收；保留权重录入联动规则 | [ResetAllCharactersButton](../src/lib/overlays/modals/ScoringModal.tsx#L93) |
| 行迹树 | 选中会激活祖先和后代；取消会关闭后代；保存 deactivated 列表 | 行迹查询、级联开关、保存与评分失效独立列项 | [StatTracesDrawer](../src/lib/overlays/drawers/StatTracesDrawer.tsx#L148) |
| 有效词条自动排序 | 网页按装备遗器 currentPct 总和排序；手动 rank 不能表达这一动作 | 自动排序、置顶、手动顺序分别登记 | [sortByEffectiveSubstats](../src/lib/tabs/tabCharacters/characterTabController.ts#L82) |
| 保存配装生命周期 | “载入优化器”合并表单和配装快照，不等于装备；清空全部配装待补；同名覆盖已有 save_build(overwrite=true) | 区分查看、载入、装备、覆盖、单删、全清及截图；覆盖复用现有入口，不凭“编辑”虚增任意重命名功能 | [buildService](../src/lib/services/buildService.ts#L113)、[BuildsModal](../src/lib/overlays/modals/BuildsModal.tsx#L116)、[save_build](./src/domains/equipment.ts#L663) |
| 保存配装装备副作用 | 网页有三个非空队友时写入 DPS 评分队伍并切到 custom；现 MCP handler 只装备遗器 | 加入行为差异清单与专门对拍；不擅自扩大到其他评分模式 | [网页 handleEquip](../src/lib/overlays/modals/BuildsModal.tsx#L138)、[MCP equip_saved_build](./src/domains/equipment.ts#L805) |
| 未导入展示柜模拟 | 网页可直接替换缓存角色/光锥、应用假想预设并评分；当前 MCP 评分要求角色在已载入库存 | 缓存引用/独立输入评分和模拟，保留原始数据与当前覆写语义；不先导入库存才能使用 | [展示柜控制器](../src/lib/tabs/tabShowcase/showcaseTabController.ts#L121)、[覆写动作](../src/lib/tabs/tabShowcase/showcaseTabStoreActions.ts#L11)、[MCP DPS handler](./src/domains/scoring.ts#L285) |
| 展示柜导入 | 网页有 relics、singleCharacter、multiCharacter 三种模式；模拟允许多槽重复角色 | 按实际角色写入和遗器合并范围验收每种模式，不推断“单角导入只合并该角色遗器” | [importShowcaseCharacters](../src/lib/tabs/tabShowcase/showcaseTabController.ts#L145) |
| 组队工作状态 | 选人可补入库存；空队首位可自动补队；原子重排、清空与评分偏好有各自作用域；重命名已有 save_team(teamId, name) | 工作槽位、删除/移动/加载及基准同步独立列项；重命名复用已有工具；避免连续 setSlot 重排丢角色 | [useTeamShowcase](../src/lib/tabs/tabTeamShowcase/useTeamShowcase.ts)、[useSavedTeams](../src/lib/tabs/tabTeamShowcase/savedTeams/useSavedTeams.ts)、[save_team](./src/domains/teams.ts#L169) |
| 队伍基准同步 | 同步从当前选中角色/装备捕获快照；缺光锥不成功；命中活动保存队伍时更新该队快照 | 对拍同步资格、活动队匹配、工作/保存队伍写入，以及槽位改变导致的快照保留/失效 | [syncBenchmarkTeams](../src/lib/tabs/tabTeamShowcase/useTeamShowcase.ts#L221)、[applyBenchmarkSnapshot](../src/lib/tabs/tabTeamShowcase/savedTeams/useSavedTeams.ts#L120) |
| 扫描器事件与限制 | 有遗器、角色、光锥、材料、抽卡资源和删除事件；GachaResult 明确不存；实时导入禁用遗器新增/删除，单件编辑条件不同 | 明确事件类型、重掷分支、忽略行为和禁用条件；不虚增抽卡历史记录或笼统禁用全部编辑 | [事件分发](../src/lib/tabs/tabImport/ScannerWebsocketClient.tsx)、[遗器工具栏](../src/lib/tabs/tabRelics/bottomDock/BottomToolbar.tsx#L75) |
| Metadata 隐藏页 | 上一版只点名套装审计/图片中心，未逐项列出九个面板 | 全量列九面板，包含颜色网格、模拟队伍/连招、条件预设、权重、排行榜队伍及各自可调预览 | [MetadataTab](../src/lib/tabs/tabMetadata/MetadataTab.tsx#L49) |
| 图片中心编辑语义 | 静态/Spine/光锥/背景参数用于预览、复制配置和重置；有临时内存粘贴 | 暴露预览和配置产物；不宣称已经具有修改游戏元数据源码的保存功能 | [ImageCenterEditor](../src/lib/tabs/tabMetadata/ImageCenterEditor.tsx) |
| 入门示例存档 | 帮助抽屉不仅显示说明，还有加载 sample-save 并保存的动作 | 示例存档作为正式动作列入，覆盖替换与持久化；首页 UID 搜索和外链保留入口 | [tryItOutClicked](../src/lib/overlays/drawers/GettingStartedDrawer.tsx#L25)、[HomeTab](../src/lib/tabs/tabHome/HomeTab.tsx#L81) |

其他已保留且需要 S0 展开的领域包括：优化器全部筛选/敌人/增益/条件/连招/结果操作、假想属性模拟与基准、遗器推荐范围与排除、定位与重掷、排行榜过滤与 UID/配装/时间线、展示定制与动画、WebGPU 计算/诊断、文件导入/导出、设置和导航。领域已经列入不等于每个按钮和字段已经枚举完毕。

## 2. 防止曲解目标的修订

| 上一版表述或隐含假设 | 修订后的边界 |
| --- | --- |
| M8 完整双向同步是全站完成的前置条件 | 当前网站的全部行为为必做主线；新增网页与 MCP 协同协议独立作为可选增强。现有扫描桥仍需对齐 |
| 所有工作状态都应随快照重启恢复 | 逐项登记持久化、临时状态、派生缓存、外部数据；按原有生命周期恢复，不把 EHR 输入和工作队伍永久保存 |
| 多次运行历史和任务跨重启续跑属于网页覆盖要求 | 它们属于新增能力；主线先对齐现有结果生命周期、进度和取消行为 |
| 分类清空、任意图表图片导出是现有功能 | 未确认对应网站动作，列为增强项；网站全量清空、已有截图和图表数据/参数继续必做 |
| 独立组队页 | 更正为角色页的组队面板及 `#teams` 入口；组队能力仍全部纳入 |
| 所有 MCP 客户端都能复制/系统分享 | 文件产物和资源必须可取；主机复制/分享按平台能力验收。网页 Clipboard 在移动端走可用的 navigator.share 分支 |
| 单件装备完全未覆盖 | `equip_build` 接受单件，无需为了工具数量重造同一操作；逐件卸下和编辑仍需补齐 |
| 删除遗器应清理所有保存配装引用 | 复用上游实际规则：卸下并删除，保存配装可保留失效 ID；清理策略变化作为单独行为变更 |
| 统一推广所有评分队伍副作用更合理 | 先对齐网页目前固定 DPS 的保存配装装备行为；跨评分模式推广需另立修改说明和验证 |

依据：[清空菜单](../src/lib/tabs/tabImport/ClearDataSubmenu.tsx#L21)、[遗器删除](../src/lib/services/equipmentService.ts#L150)、[截图复制/分享](../src/lib/utils/screenshotUtils.ts#L660)、[单件装备入口](./src/domains/equipment.ts#L377)、[导航定义](../src/lib/tabs/navigation/constants.ts)、[组队工作状态](../src/lib/tabs/tabTeamShowcase/useTeamShowcase.ts)。

第一轮曾拆分旧估计：主线 15–25 人日、可选 M8 3–5 人日。第二轮进一步增加动作与条件，已撤下这些数字作为当前排期，仅保留历史背景；S0 冻结清单和环境后重新估算。

## 3. “无遗漏”的验证方式

S0 的 features.json 应对每项动作登记以下字段：

- 网站页面/overlay 和入口；上游符号；参数、默认值、限制与规范化。
- 模式、平台、禁用条件和用户意图；读取结果、产物及所有写入副作用。
- 状态所有者、生命周期、缓存失效、运行环境和外部依赖。
- MCP 入口、兼容要求、验收 fixture/用例、当前实现/验证状态。
- 范围类型：网站基线、技术基础、可选增强；明确覆盖率分母。

按三个方向核对：

1. 从导航、页面、全部菜单/弹窗/抽屉走到动作和字段，检查每个分支都有清单行。
2. 从业务 action/store 写入/计算/渲染产物反查页面入口，补出快捷动作和隐藏功能。
3. 从每项清单反查可发现的 MCP 入口及实际验收记录，检查已有工具的默认值与副作用差异。

每个“已验证”条目须有同版本网页/MCP 对拍证据。涉及视觉、GPU、剪贴板/平台分享和真实外部成功路径的条目，不能只靠 Node 冒烟标记通过。代码后续新增网站功能时，清单同步更新。

当前尚未生成并冻结完整 features.json，也未执行浏览器全站逐项验收。这两项已明确列为 S0 与 M9 交付，避免把计划写得完整误当成实现和验收已经完整。

## 4. 本次验证与仓库状态

两轮仅修改实施计划、此复核记录及 HTML 计划页。未重跑业务测试，未新增依赖，未提交 commit。此前 12 套回归 / 519 项 PASS 是原工具基线记录，不能用于证明新增规划中的能力已经完成。

用户此前授权生成的 `.codegraph/` 索引仍是未跟踪文件，本次没有将索引或计划文档加入 Git 暂存区。

## 5. 第二轮反向复核：动作、状态和产物

本轮从共享 action、状态写入、序列化和分析/媒体产物反查原计划与已有 handler。以下是确证的补充和归类修正；“计划补齐”不代表业务实现已经完成。

| 项目 | 源码结论 | 修订及验收点 | 代码依据 |
| --- | --- | --- | --- |
| 文件只导入遗器 | 网页 mergeRelicsConfirmed 传空角色列表；MCP runImportTool 总会规范化并处理 parsed.characters，existingCharactersOnly 只能限制已有角色，无法表达不处理角色 | 新增显式 target/includeCharacters，保留旧默认值；分别验收只遗器/角色+遗器/仅现有角色、union/replace 及 dryRun。原有警告继续复用 | [网页只遗器](../src/lib/tabs/tabImport/ScannerImportSubmenu.tsx#L182)、[角色导入分支](../src/lib/tabs/tabImport/ScannerImportSubmenu.tsx#L195)、[MCP 导入](./src/domains/imports.ts#L351) |
| 同名配装覆盖已有 | save_build 已有 overwrite 参数，并支持 fromCache 的运行表单快照 | 从缺口中移除；继续复用、对拍，不新增同义工具 | [save_build schema](./src/domains/equipment.ts#L663) |
| 队伍重命名已有 | save_team 更新时允许只传 teamId/name，保留槽位及适用基准快照 | 从缺口中移除；候选 rename_team 不再单独要求 | [更新分支](./src/domains/teams.ts#L169) |
| 文件导出与结果处理已有 | export_save 已可原子写文件；get_results 已支持列排序、数值过滤、offset/limit | 文件导出与排序/过滤/分页复用旧入口；新增工作是纯快照读取与网站结果上下文/视图联动 | [export_save](./src/domains/archive.ts#L153)、[get_results](./src/domains/optimizer.ts#L271) |
| 假想配装生命周期 | 网页有新增/载入/覆盖/单删/全清/重算/优化行导入；选择载入将零词条转 null、切模式并同步结果行。新增/覆盖有重复 hash 检查，覆盖生成新 key，导入拒绝假想行。stat_simulate 只有计算入口 | 不再用“配置保存/恢复”概括；逐动作登记请求、选中项、key、表单写回和 autosave；计算继续复用 | [statSimulationController](../src/lib/simulations/statSimulationController.ts#L35)、[选择载入](../src/lib/tabs/tabOptimizer/optimizerForm/components/SimulatedBuildsGrid.tsx#L39)、[覆盖](../src/lib/simulations/statSimulationController.ts#L108)、[导入优化行](../src/lib/simulations/statSimulationController.ts#L201)、[stat_simulate](./src/domains/simulation.ts#L420) |
| 表单切换与条件联动 | 切角色先保存离开角色，再载入新表单和假想列表、清选择；条件编辑 patchComboConditionalDefault 只改首 activation/partition，保留逐回合值。MCP formOverrides 仅深合并 | 新增网站动作契约；保留原始覆盖 API；独立验收切换/保存/重置、条件联动、目标/权重错误与光锥路径/队友警告 | [切换动作](../src/lib/tabs/tabOptimizer/optimizerForm/optimizerFormActions.ts#L342)、[条件动作](../src/lib/tabs/tabOptimizer/optimizerForm/optimizerFormActions.ts#L78)、[连招默认值](../src/lib/stores/optimizerForm/optimizerFormConversions.ts#L420)、[原始覆盖](./src/permutations.ts#L127) |
| 结果分析上下文 | 展开分析优先使用运行时缓存表单，检查角色匹配，区分装备行/真实行/假想行；analyze_build 默认取角色当前表单，不能直接等同于选中优化行分析 | 增加缓存引用/行选择/运行快照来源，覆盖基础/战斗/忆灵列映射和比较基准；内部表单缓存不计作用户多运行历史 | [展开分析](../src/lib/tabs/tabOptimizer/analysis/ExpandedDataPanel.tsx#L35)、[结果行分支](../src/lib/tabs/tabOptimizer/optimizerTabController.ts#L121)、[现有分析](./src/domains/simulation.ts#L617) |
| 增益分析视图 | 已有 trace 返回原始动作增益，但网页另有动作/回合、伤害标签筛选、汇总贡献、忆灵/输出分组、命中缩放/暴击/击破/韧性和敌人参数。无筛选汇总仅取通用增益 | 不把基础拆分/升级/比较误列为全部缺失；补齐派生视图、筛选规则、字段/标签/单位，并复用现有计算 | [筛选界面](../src/lib/characterPreview/buildAnalysis/BuffsAnalysisDisplay.tsx#L80)、[汇总规则](../src/lib/characterPreview/buffsAnalysis/StatSummary.tsx#L42)、[命中参数](../src/lib/characterPreview/buffsAnalysis/HitDefinitionDisplay.tsx#L73)、[现有模拟](./src/domains/simulation.ts) |
| 评分展示不止四种 | 模拟配置过滤后另追加 SUBSTAT_SCORE/NONE；指定不可用模式回退，来源优先级有注入/配装/存储分支 | 四种模拟评分与两种非模拟展示分别登记，保留可用列表、来源和回退 | [评分顺序](../src/lib/characterPreview/scoring/showcaseScoringOrder.ts#L32)、[模式回退](../src/lib/characterPreview/scoring/showcaseScoringOrder.ts#L74) |
| 持久化边界再次校正 | showcaseTeamPreferenceByConfig 和临时速度基准不在 SaveState 输出；角色评分选择/颜色偏好与全局 savedSession 会保存。store 调用 delayedSave 不能证明其每个字段落盘 | 以序列化/恢复路径建白名单，分开自定义队伍配置、当前选择与临时基准；纠正第一轮“选择保存”的歧义 | [状态定义](../src/lib/tabs/tabShowcase/useShowcaseTabStore.ts#L81)、[实际序列化字段](../src/lib/state/saveState.ts#L72) |
| 展示定制作用域 | SPD 精度、深色、预设、UID、动画有全局作用域；SPD 权重有角色作用域，deprioritizeBuffs 仅 DPS，基准临时。STANDARD 属全局，编辑颜色模式会同步全局开关；有上下文可见/禁用条件 | 全局/角色/配置/临时参数分别操作，验收联动和侧栏隐藏条件，不承诺每张卡完全独立 | [评分定制](../src/lib/characterPreview/customization/ShowcaseCustomizationSidebar.tsx#L159)、[展示定制](../src/lib/characterPreview/customization/ShowcaseCustomizationSidebar.tsx#L311)、[全局联动](../src/lib/characterPreview/customization/showcaseCustomizationController.ts#L22)、[STANDARD 解析](../src/lib/characterPreview/color/showcaseColorService.ts#L41) |
| 肖像保存的写入 | 保存自定义肖像时，未在库存中的角色会先 upsert；删除肖像保留角色。纯评分/渲染没有该写入要求 | 保留 set/reset、署名、裁剪参数及隐式角色创建；缩小“不强制导入”的表述到纯评分/渲染 | [肖像确认动作](../src/lib/characterPreview/characterPreviewController.tsx#L254) |
| 遗器编辑器细项 | 默认品级/强化值、部位联动主词条/套装、主词条显示计算、低中高升级预览和 previewSubstats 有各自规则；校验主副冲突/重复/范围，区分正式与预览词条 | 补选项与派生预览入口；预览不写库存；保留百分比/SPD/平值精度及正式编辑装备引用规则 | [主词条计算](../src/lib/overlays/modals/relicModal/relicModalController.ts#L97)、[部位联动](../src/lib/overlays/modals/relicModal/relicModalController.ts#L130)、[校验](../src/lib/overlays/modals/relicModal/relicModalController.ts#L205)、[升级预览](../src/lib/overlays/modals/relicModal/relicModalController.ts#L332) |
| 无结果建议可以执行 | 零排列组合与零结果有不同 root cause；界面按钮调用 applyFix，不只是显示文案；优先级修复改变角色顺序，全部重置有 STAT_VIEW 特例 | 分别登记诊断与应用动作，返回修复差异及副作用，避免与现有规模限制 constraintSuggestions 混同 | [建议与修复按钮](../src/lib/tabs/tabOptimizer/OptimizerSuggestionsModal.tsx#L36) |
| 隐藏视觉调试 | CARD_DEBUG 启用后可调背景滤镜、阴影、内光、OKLCH、标签混合/文字阴影及预设；debugVisualConfigStore 运行期状态不落盘 | 纳入隐藏功能基线，登记启用条件、参数、预设和预览，不把调试参数写入永久存档 | [调试入口条件](../src/lib/characterPreview/CharacterPreview.tsx#L300)、[参数组](../src/lib/characterPreview/debugPanelConfig.ts#L108)、[调试 store](../src/lib/characterPreview/debugVisualConfigStore.ts#L163) |
| 兼容与工期矛盾 | “保留旧调用”与直接修正 warp/simple、保存配装装备副作用可能冲突；reset_settings 先写可选又列主线候选；旧估计未反映新增细项 | 采用新增网站动作/显式可选模式，旧参数/默认值不静默改变；reset_settings 仅增强；旧工期撤下当前排期，S0 后重估 | [修订计划：技术路线](./hsr-optimizer-MCP-全站覆盖计划.md)、[warp_plan](./src/domains/calculators.ts) |

第二轮没有新增业务代码或执行业务回归。文档和页面校验只证明文件、链接与渲染有效，不证明规划功能已实现。冻结完整 features.json、实际浏览器逐项盘点及最终网页/MCP 对拍仍是明确的后续交付。
