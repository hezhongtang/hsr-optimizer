# MCP docs — 配队工作流调研与增量更新设计

> 2026-10-11。基于一次真实运行（run `dwfrun-6514b7da-41f6-4ca6-8fc3-3c70cc24ac90`：6 体系 × 双逻辑配队方案，2h 00m / 37.3M tokens / 40 节点 / 46 次驱动调用）的完整调研。
> 运行产物与原始证据在 `.zcode/team-plan-out/`（不入库）；本目录收录的是可入库的研究分析。

## 后续进展(2026-10-13)

下面三份文档是 2026-10-11 那次运行的调研快照,正文里的数字(61 个工具、185 features 等)保持当时的口径。此后落地的部分:

- 03 的路线图 ① ②:`team_audit` / `plan_diff` 两个工具(默认策略后来改为按强化等级分两遍搜的 tiered)。
- 03 的路线图 ③ Mode A:`npm run plan-refresh -- --plan <plan.json>`,用 `plan_diff` 找出过期的队、只对它们重跑 `team_audit`、重写报告,全程没有 LLM。Mode B 的工作流改造与 `team_score` 未做。
- 当前口径:64 个工具、191 个功能条目(网站基线 175 项全部实现,156 项 verified),权威状态见 `mcp/coverage/summary.md`。verified 不再手工标注:由 `coverage/evidence/` 里的对拍记录决定,`npm run coverage:flip` 对齐、`npm run coverage:check` 核对(规则见 `mcp/coverage/evidence/PROTOCOL.md`)。全部证据于 2026-10-13 在 macOS(Apple GPU)上用 `npm run verify:all` 重新生成。
- 这次按证据对齐后有三行变动:`preview.scoring.spdBenchmark` 升为 verified;`optimizer.run.cancel` 与 `preview.customize.display` 退回 implemented——两行此前标着 verified,但证据里各有一条用例一直是 FAIL。
- 基线里还没 verified 的 19 项,按原因分六类(尚未逐项复现的标注为初判):
  - 环境构造不出来(2 项):`optimizer.engine.select`、`webgpu.tests.run` 各有一条用例要求「没有 WebGPU 的浏览器」,受管浏览器起不出这种环境。
  - 验收脚本的网页一侧驱动失败或超时,服务端行为未见问题(初判,11 项):`showcase.profile.fetch` / `showcase.card.read` / `showcase.import` / `showcase.simulate.override` / `showcase.sidebar.toggle`、`preview.customize.display`(展示柜页的 UID 开关那条,记在 showcase 证据里)、`preview.debug.visualPanel`、`relics.upsert`、`relics.locator`、`optimizer.statSim.importResult`、`metadata.imageCenter.edit`。
  - 验收脚本自身报错(1 项):`optimizer.run.cancel`——取消后读结果时 `get_results` 报「缓存结果属于上一次载入的存档」,用例没有走到比对。
  - 对拍已能跑通但数值没对齐,尚未判定是哪一侧(1 项):`preview.analysis.buffs`——此前一直超时是因为脚本里的正则转义被模板字符串吃掉;修正后 12 行属性合计里 9 行一致,剩下的是 DMG Boost 的归并口径(网页 112,MCP 92 且没有 Ice DMG Boost 的汇总行)。
  - 真实的行为差异(3 项):`benchmarks.generate` 与 `metadata.setAuditor.run` 的「中途取消」用例——内联引擎占满单线程,取消请求读不进来(后者另有两条网页侧抓取为空的用例);`metadata.colorGrid.view`——`render` 不消费 visualDebug。
  - 需要先定口径(1 项):`global.language.switch`——服务端渲染语言按设计固定 zh_CN,`update_state(language)` 只写偏好键;用例要求标签随语言切换。要么让服务端真的切语言,要么把用例改成当前口径。

## 文档导引

| 文档                                         | 内容                                                                                         | 一句话结论                                                                   |
| -------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [01-工作流复盘.md](01-工作流复盘.md)         | 本次 16 子代理工作流的全过程复盘：运行数据、成本分布、复核战果、踩坑记录                     | 数字层全部可复现，成本大头是 6 名设计师各自摸索驱动与标定（19.3M tokens）    |
| [02-能力盘点与缺口.md](02-能力盘点与缺口.md) | 61 个 MCP 工具中与配队分析相关的能力面、实测性能基线、缺口清单                               | 引擎侧积木齐全（整队评分/诊断建议/对比分析都有），缺的是把它们组装成一等工具 |
| [03-增量更新设计.md](03-增量更新设计.md)     | 增量更新方案：程序化 vs LLM 边界判定、Mode A/B 双模式、`team_audit` 工具规格、三步实施路线图 | 日常迭代可做成零 LLM 的纯程序刷新；LLM 只在"队伍该不该换人"时上场            |

## 核心结论（TL;DR）

1. **本次方案是静态快照，但产出它的整条流水线是可复用资产**：`driver.cjs`、标定手册（`.zcode/team-plan-out/mcp-notes.md`）、`tools.json`、`extract.cjs` 均与数据无关，直接服务下一轮迭代。
2. **90% 的日常迭代（刷遗器/换装/抽到角色）不需要 LLM 参与设计**——只需要"固定队伍名单，重新打分"。LLM 仅在版本更新或新角色入手（"队伍该不该换人"）时需要。
3. **最值得做的 MCP 新工具是 `team_audit`**：把"permutations → 自动收紧 → optimize → dps_score → 零成本换装检测"压成一次调用（本次每个设计师要做 5~11 次驱动调用），并消除每次调用约数秒的冷启动与 LLM 现场标定的不确定性。
4. **关键实测口径**：`formOverrides.teammates` 对 COMBO 影响达 4.2 倍，全流程必须统一；`enhance` 默认下限是 9（库存 2355 件里 1922 件是 +0）；`get_form`/`default_form` 整表里的空 `relicSets`/`ornamentSets` 内部别名会反向覆盖 display 格式的 `setFilters`。
5. **复核员战果证明独立复核的价值**：6 份复核全部数字对上，抓到的全是"描述与证据不一致"（46/50 写成"全部"、E0 写成实为 E1）——数字对账可以完全程序化，语义合理性才需要人/LLM。

## 相关文档（仓库既有）

- `mcp/README.md` — MCP 服务器使用入口
- `hsr-optimizer-MCP-调研报告.md` / `hsr-optimizer-MCP-实施方案.md` / `hsr-optimizer-MCP-契约冻结.md` — 建设期文档（M1-M9，本目录内）
- `mcp/coverage/` — 验收协议：features JSON + 15 个取证脚本 verify-*.mjs + coverage-check 门禁（191 features / 基线 175 项中 156 项 verified）
