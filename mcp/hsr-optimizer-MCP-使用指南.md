# HSR Optimizer MCP 使用指南

面向 agent 与集成方:怎么装、怎么连、能做什么、样例怎么写、报错怎么读。工具参数的权威定义在工具自身的 `.describe()` 与 `mcp/README.md`;本文是操作视角的入口文档。

## 1. 版本兼容表

| 项             | 当前值                           | 说明                                                                                |
| -------------- | -------------------------------- | ----------------------------------------------------------------------------------- |
| 上游优化器版本 | v4.6.5                           | `src/lib/constants/constants.ts` CURRENT_OPTIMIZER_VERSION                          |
| 游戏数据版本   | 4.6v5                            | CURRENT_DATA_VERSION;`game://changelog` 首条同源                                    |
| MCP server     | 0.1.0                            | `mcp/package.json`;引擎原样复用上游代码,优化结果与网页一致(CPU 多线程,网页默认 GPU) |
| Node           | ≥ 26                             | `mcp/package.json` engines;实测 26.5                                                |
| npm            | ≥ 11                             | 同上                                                                                |
| 受管浏览器     | Chromium 系(实测 Chrome 154)     | M7 渲染/WebGPU 需要;puppeteer-core 25 驱动,**绝不下载浏览器**                       |
| MCP SDK        | @modelcontextprotocol/sdk 1.32.x | stdio 传输                                                                          |

上游 `src/**` 变更时以 `mcp/coverage/` 冻结清单为准(`npm run coverage:check` 会校验普查漂移)。

## 2. 环境要求与安装

```bash
npm install            # 仓库根(mcp 依赖会随 workspace 安装)
npm run build          # 构建站点(受管浏览器伺服的页面与素材,~440MB dist/)
npm --prefix mcp run build   # 构建 MCP server → mcp/dist/
```

- 纯 Node 工具面(查询/优化/装备/评分/导入/计算器/队伍/状态):不需要浏览器。
- 浏览器工具面(render/deliver_artifact/debug_utility 的 webgpu_tests 与 image_center/optimize(engine=gpu)):需要本机 Chromium 系浏览器 + 站点构建产物;缺失时工具返回具体的中文能力报告(不是笼统失败),冒烟自动 [SKIP]。
- 仓库外运行:见 §6。

### 环境变量

| 变量                    | 默认                              | 作用                                                                                                                                                                                      |
| ----------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HSR_MCP_STATE_FILE`    | `$HSR_MCP_HOME/localstorage.json` | localStorage 垫片文件后端(上游 store 层持久化通道)。**进程重启后会自动从其中的 `state` 键恢复上次存档**(网页「打开即载入」同语义);`HSR_MCP_NO_BOOT_LOAD=1` 显式关闭。测试务必指向临时文件 |
| `HSR_MCP_HOME`          | `~/.hsr-optimizer-mcp`            | 状态目录                                                                                                                                                                                  |
| `HSR_MCP_WORKERS`       | `6`                               | 优化器 worker 池(1–10)                                                                                                                                                                    |
| `HSR_MCP_LOCALES_DIR`   | 自动定位                          | i18n 翻译目录;仓库外运行时显式指定                                                                                                                                                        |
| `HSR_MCP_BROWSER_PATH`  | 平台自动发现                      | 受管浏览器可执行文件                                                                                                                                                                      |
| `HSR_MCP_SITE_DIST`     | `<仓库根>/dist`                   | 站点构建产物目录(受管浏览器伺服)                                                                                                                                                          |
| `HSR_MCP_ARTIFACTS_DIR` | `$TMPDIR/hsr-mcp-artifacts`       | render 产物落盘目录                                                                                                                                                                       |
| `HSR_MCP_NO_BOOT_LOAD`  | 未设                              | 设为 `1` 关闭启动自动恢复                                                                                                                                                                 |

## 3. 客户端接入(stdio)

```json
{
  "mcpServers": {
    "hsr-optimizer": {
      "command": "node",
      "args": ["/absolute/path/to/hsr-optimizer/mcp/dist/index.js"],
      "env": { "HSR_MCP_STATE_FILE": "/absolute/path/to/state.json" }
    }
  }
}
```

冒烟脚本(`mcp/scripts/smoke-*.mjs`)即此协议的参考实现。

## 4. 能力总览

**61 个工具 / 11 个资源**(矩阵权威状态见 `mcp/coverage/summary.md`,网站基线 175/175 已接入):

| 域     | 工具                                                                                | 一句话                                                                        |
| ------ | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 存档   | load_save / export_save / save_status / reset_all                                   | 载入(文件/内联/示例)、结构化导出、修订与落盘状态、清空(persist=true 落盘)     |
| 查询   | list_characters / get_character / list_relics / permutations                        | 筛选与网页筛选条同语义(中文名子串+命途/属性多选;强化分档/多副词条/初始词条数) |
| 优化器 | optimize / get_results / get_form / default_form / update_form                      | CPU 搜索(engine=gpu 走受管浏览器)、诊断与一键修复、表单全量读写               |
| 装备   | equip_build / unequip / switch_relics / save_build / … / equip_saved_build          | 装备与配装管理,fromCache 沿用那轮优化结果                                     |
| 评分   | score_character / dps_score / score_relics / set_scoring_override                   | 四配置评分(含队伍快照覆盖 team=snapshot)、遗器潜力、评分配置编辑              |
| 导入   | import_scanner_json / import_hoyolab / fetch_showcase / import_showcase / scanner   | 文件导入(union/replace)、展示柜拉取、实时扫描器 ws 客户端                     |
| 分析   | analyze_build / simulate_build / analyze_relic / stat_simulate / benchmark_runs     | 伤害拆解/假想属性/遗器洞察/基准(全候选行+详情,未入库角色可跑)                 |
| 计算   | warp_plan / calc_aha / calc_ehr                                                     | 跃迁规划、阿哈、效果命中反算                                                  |
| 队伍   | list_teams / save_team / manage_team                                                | 队伍管理与基准快照                                                            |
| 状态   | get_state / update_state / get_job / cancel_job                                     | 八段状态域读写、任务查询与取消                                                |
| 浏览器 | get_runtime_capabilities / render / deliver_artifact / debug_utility / set_portrait | 受管浏览器生命周期、五类渲染目标、产物交付、WebGPU 检验/图片中心、自定义肖像  |
| 条件   | describe_conditionals                                                               | 条件面板元数据                                                                |

资源:`game://metadata/characters|lightcones|sets|scoring`(+详情模板)、`game://changelog`、`site://pages|links|home|help/{topic}`。

## 5. Agent 操作样例

**旅程 A —— 优化并装备最优配装**:
`load_save(path=…)` → `permutations(characterId, …)` 估算规模 → `optimize(characterId, resultsLimit=1024)` → `get_results(sortBy=COMBO, limit=5)` 看头部 → 满意后 `equip_build(characterId, fromCache=…, rowId=…)`(表单与装备一步落位) → `score_character(characterId)` 复核评分 → 想给用户看图就 `render(target=character_card, characterId=…)`(返回 image 块 + artifactId,`deliver_artifact(action=copy)` 可复制)。

**旅程 B —— 接入实时扫描器**:
`get_state(section=scanner)` 看配置 → `scanner(action=connect, url=…)` → `scanner(action=events)` 轮询事件 → `get_state(section=relicsTab)` 的 recentRelics 看最近入库 → `update_state(section=scanner, patch={ingest:true})` 开导入(已连接时自动重放)。

**旅程 C —— 跃迁规划**:`warp_plan(jades=…, targets=[{characterId, targetEidolonLevel}], applyPlannerMode=true)` 复刻网页 simple 目标转换,再 `warp_plan(save=true)` 存底稿。

**旅程 D —— 榜单研究**:`leaderboard(view=board)` 找条目 → `leaderboard(view=entry, buildId=…)` 读配装 → `leaderboard(view=score, buildId=…)` 本地复算(与榜单记录值对比) → `render(target=character_card, source=leaderboard, buildId=…)` 渲染榜单风格卡。

## 6. 仓库外(便携)运行

MCP 可以脱离仓库运行,需要三件东西:①`mcp/dist` + `mcp/node_modules` + `mcp/package.json`(npm 依赖已完整声明全部运行时 external);②站点构建产物(`HSR_MCP_SITE_DIST` 指向);③翻译目录(`HSR_MCP_LOCALES_DIR` 指向站点产物内的 `locales`)。`node scripts/check-packaged.mjs` 就是这套组装+四断言(i18n/媒体渲染/GPU/重启恢复)的自动验收。

## 7. 常见错误速查

- `No save loaded — call load_save…`:只读工具要求先载入存档;或检查 `HSR_MCP_STATE_FILE` 是否指向了新文件(boot-load 只在文件里已有 `state` 键时恢复)。
- `受管浏览器…请先…`/能力报告:缺 Chrome 或站点 dist;按错误内的 env 变量指引补齐,或 `get_runtime_capabilities(action=launch)` 看完整探测。
- `baseRevision 冲突`:并发写入时的乐观锁拦截——重读状态后重试,或显式不带 baseRevision 串行执行。
- `Cached optimize run … belongs to a previous save load`:`load_save` 换档后旧优化缓存失效,重跑 optimize。
- clipboard/share 的平台条件:copy 写受管浏览器的剪贴板(桌面 Chrome 通常即系统剪贴板),share 在无头环境预期不可用——返回体都会如实报告原因。
