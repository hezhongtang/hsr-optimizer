# MCP 可行性实测（spike）

一次性验证代码，用来把《调研报告》里的静态推断变成实测结论。不是 MCP 的正式实现，正式实现落地后可整体删除。

## 验证了什么

| 入口               | 验证点                                                                                                                                                                           |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spike.ts`         | 上游 store / service / 导入器 / 存档层能否在 Node 加载；`loadSaveData` 迁移旧存档；镜像调度跑 Engine A；DPS 评分（Engine B）；遗器评分；装备写回；`SaveState.save()`；扫描器导入 |
| `spikeParallel.ts` | 用 `node:worker_threads` 适配层驱动上游**原版** `Optimizer.optimize`，与镜像调度逐行对拍；多核吞吐与取消延迟                                                                     |

支撑文件：

- `shims.ts` — 让上游模块在 Node 加载所需的最小浏览器全局垫片（`SPIKE_SHIMS=1` 时启用）
- `engineA.ts` — Engine A 调度循环的无头镜像，只拼装上游纯函数
- `nodeWorkerAdapter.ts` + `workerThread.ts` — 把上游 `workerPool.ts` 的 `?worker` 导入换成 `worker_threads`
- `vite.spike.config.ts` — 仿 `vite.leaderboard.config.ts` 的 SSR 构建，产物在 `mcp/spike/.build/`

所有改动都在 `mcp/` 内，上游文件零改动。

## 运行

在仓库根目录执行（需要先 `npm ci`）：

```bash
npx vite build --config mcp/spike/vite.spike.config.ts --configLoader native
```

```bash
SPIKE_SHIMS=1 node mcp/spike/.build/spike.js
```

```bash
SPIKE_SHIMS=1 node mcp/spike/.build/spikeParallel.js
```

把 `SPIKE_SHIMS` 设为 `0` 可以复现"不加垫片时 store 层全部加载失败"。

## 实测结果（2026-10-05，Apple M5 / 10 核，Node v26.5.0，HEAD `b9efcdc7`）

数据为 `src/data/sample-save.json`（162 遗器 / 8 角色），目标角色 `1212b1`。

- 不加垫片：`appStore` 创建时读 `window.location.hash`，所有依赖它的 store / service 加载失败
- 加垫片后：全部阶段通过
- Engine A 单线程内联：462,672 排列 / 1.93 s，约 24 万排列/秒
- 镜像调度与上游原版 `Optimizer.optimize` 对拍：1024 行结果的 id 与排序值完全一致
- 镜像结果第 1 名经 `simulateBuild` 复算：COMBO 相对误差 1.4e-8（Float32 打包精度）
- 9 线程池：同一搜索 1.04 s；1944 件遗器库存稳态约 97 万排列/秒；取消延迟 80–180 ms，取消后保留已得结果
- DPS 评分：约 0.33 s（含升级项计算）
- 遗器评分：162 件 × (当前分 + 潜力分) 共 7 ms
- 内存：单进程约 430 MB；9 线程池满载约 2.3 GB

## 已知注意点

- `persistenceService.mergeRelics` 是**整库替换**语义：只含 1 件遗器的扫描文件导入后库存从 162 变成 1
- 上游 SSR 构建默认会复制 `public/`（约 435 MB），本配置用 `publicDir: false` 关闭
- 默认过滤条件下 1944 件遗器的搜索空间约 1.4e12，CPU 无法穷举；网页端默认用的是 WebGPU 引擎
