# 功能覆盖矩阵摘要

本文件由 `npm run coverage:check -- --write` 生成，请勿手改。条目定义见 [README](../README.md)。

基线：`6280c61c`（src 树 `838f222f2f33`）。

## 按域与状态

| 域 | 功能条目 | missing | partial | implemented | verified | 机制项 |
| --- | --- | --- | --- | --- | --- | --- |
| global | 15 | 11 | 3 | 1 | 0 | 4 |
| home | 2 | 1 | 0 | 1 | 0 | 0 |
| changelog | 1 | 0 | 0 | 1 | 0 | 0 |
| import | 13 | 6 | 3 | 4 | 0 | 0 |
| characters | 22 | 5 | 8 | 9 | 0 | 0 |
| preview | 21 | 14 | 5 | 2 | 0 | 4 |
| teams | 13 | 9 | 2 | 2 | 0 | 2 |
| relics | 12 | 5 | 4 | 3 | 0 | 0 |
| optimizer | 43 | 11 | 22 | 10 | 0 | 5 |
| showcase | 5 | 2 | 2 | 1 | 0 | 1 |
| warp | 5 | 1 | 3 | 1 | 0 | 0 |
| benchmarks | 7 | 0 | 4 | 3 | 0 | 0 |
| calculators | 7 | 5 | 0 | 2 | 0 | 0 |
| leaderboard | 7 | 7 | 0 | 0 | 0 | 0 |
| webgpu | 1 | 1 | 0 | 0 | 0 | 0 |
| metadata | 9 | 2 | 7 | 0 | 0 | 2 |
| shared | 2 | 0 | 2 | 0 | 0 | 3 |
| **合计** | 185 | 80 | 65 | 40 | 0 | 21 |

网站基线条目 175 个，其中已验证 0 个。

## 分布

- **范围**：baseline 175 · foundation 3 · enhancement 7
- **运行环境**：node 171 · browser 13 · host 1
- **是否需要动上游**：none 142 · mirror 38 · export 5 · extract 0
- **类型**：read 34 · write 85 · compute 27 · artifact 5 · external 8 · navigate 4 · view 22
- **状态生命周期**：persisted 91 · session 42 · ephemeral 16 · derived 25 · external 4 · none 7

## 工具面与预算

- 已注册工具 44 个（被条目引用 44 个），已注册资源 6 个。
- 候选新工具 16 个：`analyze_relic`、`cancel_job`、`debug_utility`、`delete_relics`、`deliver_artifact`、`get_job`、`get_runtime_capabilities`、`get_state`、`leaderboard`、`manage_team`、`render`、`scanner`、`score_character`、`update_form`、`update_state`、`upsert_relic`。
- 候选新资源 7 个：`game://metadata/scoring`、`site://capabilities`、`site://help/{topic}`、`site://home`、`site://links`、`site://pages`、`site://settings`。
- 需扩展参数的现有工具 29 个：`analyze_build`、`benchmark_runs`、`calc_aha`、`calc_ehr`、`default_form`、`delete_build`、`describe_conditionals`、`equip_saved_build`、`export_save`、`fetch_showcase`、`get_form`、`get_results`、`import_hoyolab`、`import_scanner_json`、`list_characters`、`list_relics`、`load_save`、`optimize`、`permutations`、`reset_all`、`save_team`、`score_relics`、`set_character_rank`、`set_scoring_override`、`simulate_build`、`stat_simulate`、`sync_bridge_start`、`upsert_character`、`warp_plan`。
- 全部建成后工具数 60，预算 70。

## 普查对照

| 普查项 | 总数 | 精确对应 | 整文件对应 | 仅机制项 | 未覆盖 |
| --- | --- | --- | --- | --- | --- |
| controls | 546 | 518 | 0 | 28 | 0 |
| storeActions | 179 | 150 | 20 | 9 | 0 |
| exports | 155 | 129 | 0 | 26 | 0 |
| interactions | 146 | 129 | 0 | 17 | 0 |
| persistence | 81 | 81 | 0 | 0 | 0 |

## 机制项

普查扫到、但本身不构成功能的实现管道。逐条列出它服务于哪些功能、为何不需要独立入口。

| id | 名称 | 服务于 | 说明 |
| --- | --- | --- | --- |
| global.mech.overlayOpenClose | 弹层开合状态 | global.settings.update、global.gettingStarted.loadSample、global.changelog.whatsNew、global.sidebar.collapse | 记录 15 个抽屉与弹窗各自是否打开的通用开关。打开弹层本身不产生数据，它露出的内容和其中的动作都已按功能逐条登记；MCP 工具直接带参数调用，不存在「先打开」这一步。 |
| global.mech.scrollLock | 弹层打开时锁定页面滚动 | — | 纯页面表现：带引用计数地冻结背景滚动并记住偏移量，其中 _resetForTesting 与 _getLockCount 是测试钩子。不读写任何业务数据，浏览器运行环境直接运行原网页时原样生效。 |
| global.mech.confirmDialog | 通用确认框 | global.gettingStarted.loadSample | 破坏性操作前的二次确认容器。哪些操作需要确认已写在各功能条目的 conditions 里；MCP 侧由契约统一规定破坏性工具的显式确认参数与 dryRun。 |
| global.mech.themeSeed | 主题主色（未接线） | — | useThemeStore 的主色经 zustand persist 存在 localStorage['theme-store-v1']，但当前源码里没有任何界面或代码调用 setSeedColor，主色恒为默认 #1668DC（或浏览器里的历史值）。上游接线后转为功能条目。 |
| preview.mech.paletteExtraction | 肖像取色 | preview.customize.color、preview.screenshot | 展示卡挂载时在 worker 里下载肖像并提取调色板，结果只存在会话里，供 AUTO 配色和取色器色板使用。它没有用户入口，是配色功能的计算步骤；渲染展示卡时在浏览器里照常执行。 |
| preview.mech.spineFallback | 动态立绘不可用时回退为静态肖像 | preview.customize.display | LoadingBlurredSpine 报告当前环境不支持时的回调，只负责把这张卡切回静态肖像。条件已记在 preview.customize.display 里，不是独立的用户操作。 |
| preview.mech.spineRuntime | Spine 动画渲染运行时 | preview.card.read、preview.customize.display、preview.portrait.set、preview.character.edit、metadata.imageCenter.edit | 动态立绘的渲染底盘：模糊占位加载、onReady/onUnsupported 生命周期、WebGL 上下文丢失监听、页面不可见或失焦时自动暂停动画（展示卡、肖像编辑、元数据图片中心的动态立绘取景都走它）。开关与回退已登记在 preview.customize.display 和 preview.mech.spineFallback；渲染本身没有用户动作，在 M7 浏览器运行环境里照原样执行。 |
| preview.mech.scoringRuntime | 模拟评分引擎的请求与缓存生命周期 | preview.simScore.read、preview.scoring.typeSwitch、preview.team.select、preview.team.editTeammate、preview.team.reset、preview.team.sync、preview.scoring.buffPriority、preview.scoring.spdWeight、preview.scoring.spdPrecision、preview.scoring.spdBenchmark | 角色卡 SimScoring 面板背后的评分请求层：按缓存键去重、引用计数式申请/释放 orchestrator 与 preview、超过重试上限后停止重算。评分读取、类型切换、队伍编辑与速度/增益参数调整都经它触发重算。MCP 侧由 dps_score 等入口直接调用计算层，不走这套 UI 驱动的请求生命周期。 |
| teams.mech.cardOptionsReveal | 卡片选项的显示与隐藏 | teams.working.setSlot、teams.slot.scoringType | 鼠标悬停、聚焦或触摸点击卡片时显示「更换角色、基准、移除」这组选项，移开后隐藏。它只决定按钮何时可见，按钮本身的功能已各有条目。 |
| teams.mech.dragSensors | 槽位拖拽的手势识别 | teams.working.reorder、teams.saved.move | 把指针与触摸手势转成「从哪个位置拖到哪个位置」，并在拖拽刚结束时抑制一次误触发的点击。产出的排列就是两个排序条目的参数。 |
| optimizer.mech.comboDrawerLifecycle | 连招抽屉的状态往返 | optimizer.combo.activations、optimizer.combo.sets、optimizer.combo.definition | 打开抽屉时把表单里的连招数据展开成矩阵状态，关闭后清掉，getComboState 再把它收拢成可序列化的对象。只是同一份数据在表单与抽屉之间的往返，读写都已有条目。 |
| optimizer.mech.contextCache | 优化上下文缓存 | optimizer.form.conditionals、optimizer.grid.display、optimizer.analysis.read | 缓存由当前表单生成的优化上下文（角色有哪些技能、有没有忆灵等），供界面决定显示哪些列和控件。上下文完全由表单推导，MCP 每次调用时自行生成。 |
| optimizer.mech.runFormCache | 按运行缓存当时的表单 | optimizer.analysis.read、optimizer.results.select | 按运行 id 记住那一轮搜索用的表单（最多 50 份），让事后查看结果时用的还是当时的参数。MCP 的结果缓存里同样带着那一轮的表单。 |
| optimizer.mech.gridPlumbing | 结果表格的数据通道 | optimizer.results.read、optimizer.results.select、optimizer.results.filter、relics.grid.read | 把引擎产出的结果行和各部位遗器表交给表格、算每列的最大最小值用于着色、在数据变化后刷新或滚动到表格。gridStore 只是保存两张表格（优化结果与遗器库存）的句柄。它们搬运的数据都已由结果读取、选中和筛选这几个条目覆盖。 |
| optimizer.mech.workerPool | 后台计算线程池 | optimizer.run.start、optimizer.run.cancel、preview.simScore.read、relics.insights.read | 管理浏览器里的后台线程：按需创建、排队派发任务、收消息、取消时丢弃排队任务。优化搜索、模拟评分和遗器潜力估算都经它执行；MCP 在 Node 里用自己的 worker_threads 驱动同一套引擎。 |
| showcase.mech.urlSync | 地址栏与展示柜状态同步 | showcase.profile.fetch、global.navigate.page | 每次切回展示柜页时把已加载的 UID 重新写进地址栏参数，让链接可以分享；既没有链接参数也没有上次的 UID 时退回首页。它只是让地址栏跟着已有状态走，拉取与导航本身都已有条目。 |
| metadata.mech.accordion | 元数据页的面板展开与收起 | metadata.setAuditor.run、metadata.colorGrid.view、metadata.imageCenter.edit、metadata.simulation.sets、metadata.simulation.teams、metadata.simulation.combo、metadata.setPresets.read、metadata.substatWeights.read、metadata.leaderboardTeams.read | 九个面板默认全部收起，展开时才渲染内容，展开状态不保存。MCP 按面板分别提供入口，直接读取或执行对应内容，不存在展开这一步。 |
| metadata.mech.gridHover | 元数据表格的行列高亮 | metadata.simulation.sets、metadata.simulation.teams、metadata.simulation.combo、metadata.setPresets.read、metadata.substatWeights.read | 鼠标移到格子上时高亮所在行和列，只是帮人眼对齐大表格，不改变任何数据。MCP 返回的是带角色和套装标识的结构化数据，不需要这种辅助。 |
| shared.mech.formWidgets | 通用表单控件 | optimizer.form.mainStats、optimizer.form.setFilters、optimizer.form.resultFilters、optimizer.form.weights、optimizer.form.conditionals、optimizer.combo.definition、optimizer.statSim.run、relics.grid.filter、warp.resources.set、benchmarks.configure.settings、benchmarks.configure.sets、calculators.aha.form、calculators.aha.solve、metadata.imageCenter.edit、preview.relic.addOrEdit | 被优化器表单、遗器筛选、基准配置、跃迁设置、阿哈面板等大量复用的输入控件：级联选择、带下拉的数字输入、多选标签组、可搜索下拉、悬浮说明（serves 列出已确认的直接消费方，非穷尽）。每个具体字段的读写和默认值已按所属功能行登记；MCP 用结构化参数直接表达这些字段，不存在「操作控件」这一步。 |
| shared.mech.infoLinks | 着色外链与带说明的标题 | home.content.read、changelog.entries.read、global.changelog.whatsNew、import.help.read、characters.scoring.weights、characters.scoring.resetAll、preview.simScore.read | 带图标的外链和带信息浮层的着色标题组件，散布在首页社区卡片、更新日志、导入说明、通知、评分弹窗、跃迁页等处（serves 列出已确认的直接消费方，非穷尽）。链接指向的资源已记在各功能行；组件本身是展示管道，不是用户功能。 |
| shared.mech.unmountedHeroHeader | 未挂载的首页头部组件 | — | 上游 #1818（navigation）引入的首页头部与 UID 搜索条，当前没有被任何页面导入，用户不可达；真正生效的首页搜索在 HomeTab 的 HeroSection（已登记为 home.search.uid）。源码清点如实列出它；若上游日后挂载，须转为 home 区域的功能行并并入 home.search.uid 的验收。 |
