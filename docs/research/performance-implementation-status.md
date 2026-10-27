# TouchAI 性能优化实施状态

- 基线：`origin/main@34b3ce93`（桌面 1.2.2 + DeepSeek 搜索 provider）
- 分支：`codex/perf-raycast-plan`（worktree：`.worktrees/perf-raycast-plan`）
- 方案来源：`docs/research/performance-improvement-plan-main.md`（52 项）
- 最近验证：`vitest` 437 文件 / 5414 用例全过、`vue-tsc --noEmit` 通过、改动文件 ESLint 0 error
- **Rust 侧验证**：`cargo check --all-targets` 全部通过；按约定 `cargo test` 交由 CI 执行
- 未做性能基线/前后对比（按约定，待用户验收后另行补基线）

## 已完成（44 项）

| 编号 | 内容 | 关键提交 |
| --- | --- | --- |
| 01 | 启动三阶段：先挂载外壳，工具/Bash/元数据转后台能力 + 请求级就绪门 | `dc5f69fa` |
| 02 | provider driverCatalog 拆分，设置页不再拉全部 adapter | `6b191bd0` |
| 03 | 设置批量读取（`getSettingValues`） | `4ab7ddbb` |
| 06 | 字体成功路径不重复 fetch | `d90cf0ac` |
| 07 | 发布合并（微任务）+ 未变消息跨发布复用对象身份，一次发布只构建一份快照 | `bd1260ac` |
| 08 | 发布给 UI 的展示快照剔除 runtime checkpoint / prompt 快照 | `3a500549` |
| 10 | 消息级有界挂载、高度缓存、spacer 占位、跳转消息按累计高度定位 | `828ae276` |
| 09 | Markdown 流式解析合并窗口 + 静态/流式 parser 分离 | `e9c8afc9` |
| 11 | 收起 reasoning 卸载 Markdown + bounded preview | `bb9659d6` |
| 12 | 长代码块在流式阶段降级为纯文本 pre，终态恢复增强渲染 | `b9a3757e` |
| 13 | 会话滚动改尾部 revision，移除 deep watch | `295290ed` |
| 15 | Widget 脚本资源作用域回收 | `b6df37af` |
| 16 | Widget 参数草稿去重 + 节流 | `ea49a55c` |
| 17 | 隐藏期暂停展示型定时器 | `de197043` |
| 19 | `messages(session_id, id)` 索引 | `05106850` |
| 20 | sessions 活动时间表达式索引 + 轮次复合索引 | `9f9a701a` |
| 21 | 历史搜索 120ms 防抖 | `465cb164` |
| 25 | 未变化边界不重写 parts / 不重算会话摘要 | `ed50d9ea` |
| 26 | 工具日志轻量投影 + 展开时取详情 | `5f5e6cf0` |
| 28 | 快搜翻页 generation 校验 | `321e022d` |
| 29 | 高亮分段按 (name, tokens) 缓存，渲染不再重复分词 | `fcd55ba9` |
| 30 | 资源缓存按字节 LRU | `531d7a48` |
| 31 | 快捷方式回写走 `path_norm → 下标` 索引，全局写锁内不再线性扫描 | `72780c93` |
| 32 | 窗口状态独立探针并行下发（最大化 + 高度模式） | `41a5b0fd` |
| 33 | tauriFetch 背压/取消 | `88770fa1` |
| 35 | 同批次附件按源路径去重，只读一次文件/base64 | `87312765` |
| 36 | WebFetch 单次 HTML 解析（图片/标题/正文共用 DOM，Readability 用克隆副本）+ 同步解析前后取消检查 | `09a75f0d` / `89636048` |
| 37 | MCP 客户端 map 锁不再跨 RPC 持有（附回归测试） | `306da1ea` |
| 38 | 复用浏览器端点 HTTP Client + 有界并行端口发现 | `09cbabfb` |
| 39 | 日志 callsite 过滤 + 有界队列 | `99945d2b` |
| 40 | 轻量 perf trace + 三条热路径埋点 | `073fd728` |
| N01 | 数学检测预筛 | `1c6ede5b` |
| N02 | 仅未闭合数学边界回退全量解析 | `e9c8afc9` |
| N04 | FTS 触发器收窄 | `e306e89d` |
| N05 | 多三元组候选（detail=none 限制） | `2e7a58aa` |
| N06 | 工具日志 JSON 字段生成列 + 复合索引 | `9da1cdd8` |
| N07 | 输出片段用 revision 判定变化，不再逐边界 stringify 全量 | `c3002e38` |
| N08 | 内置快照 seed 独立入口，轻入口不再解析 1.6MB 快照 | `61677b6e` |
| N09 | Settings 串行 idle 预热 + hover 优先 | `52014a40` |
| N10 | Bash 流式输出内存保留有界首尾，超出部分仅流式回调 | `20f699fc` |
| N11 | 0004 全库迁移夹具（1 万消息 + 旧工具日志/附件/孤儿）+ 耗时记录 | `a4783843` |
| N12 | SSE 行预筛 | `e4dc4c99` |
| N03 | Markdown 渲染器绑定外层滚动 owner 的 markstream 虚拟适配（provide/inject） | `749401b1` |
| 05 | popup show 冷/热启动耗时埋点（保温预算的测量输入） | `85db60fc` |
| 04 | 启动契约维护 | 无新增任务；Settings 不重同步已由启动测试覆盖 |

## 部分完成（5 项）

| 编号 | 已完成 | 未完成 |
| --- | --- | --- |
| 14 | 缩略图生成（可见时才解码、按显示宽度×DPR 缩小、WebP、40 张 LRU、失败回退原图）+ `decoding="async"` / `loading="lazy"`（`53cd07b1`） | Rust 端按 hash/尺寸的磁盘级缩略图缓存；原图缓存隔离（需真实附件场景） |
| 18 | 光标三个标记共享一次文档查询；自动换行布局测量按帧合并（`bdfe3a2b`） | docChanged/selectionChanged 分类更新；宽度变化触发重算 |
| 22 | 会话历史改为**一次读全量**（`loadCompleteSessionHistory`）+ 高度估算/首次测量补偿；移除了数据层分页、滚动触底加载、加载提示行（`ab41d9a6` 之后） | — |
| 23 | turn 内 `SessionReadModel`：附件预检与 transport 重建共享一次查询（`815071ab`） | 展示 bootstrap/分页与 transport 跨阶段复用 |
| 27 | 点击统计并行预取（`567f3d4c`） | 后续排序/写回合并 |
| 34 | auto-paste 先原子预留授权/新鲜度/去重，再做重任务；外链图片解析 3 并发 + 10s 总预算；结果按 snapshotId 校验（`3498b760`） | 两阶段 API（文本先回、附件 placeholder 补齐）与草稿 generation 缓存 |
| 10 | 消息级窗口化（消息 > 40 启用）+ 高度估/测量/补偿 + 跳转钉住 + 用户意图驱动的跟随（`828ae276`、`749401b1`、`ab41d9a6`） | part 级有界挂载、图片后加载/回滚回归、跨虚拟项选区策略需真机验收 |

## 待实施（1 项）

| 编号 | 摘要 | 备注 |
| --- | --- | --- |
| 29 | 快捷项网格虚拟化 | 已做高亮缓存；网格为 flex-wrap 88px 固定项、上限 60 条，虚拟化收益需实测后再决定 |

### 需真机/真实数据验收

- `10` 剩余：part 级有界挂载、图片后加载/回滚/时间轴与键盘翻页回归、跨虚拟项选区策略。
- `22`：已改为全量读 + 前端窗口化渲染（分页会造成滚动条失真与位置跳动），无需再验证分页合并语义。
- `34` 剩余：两阶段 API（文本先回、附件 placeholder 补齐）与草稿 generation 缓存。
- `14` 剩余：Rust 侧磁盘级缩略图缓存与 hash/尺寸键（当前为内存 LRU + WebP）。
- `05`：已提供 popup 冷/热展示耗时埋点，TTL 需基于实测数据决定。
- `29`：已提高亮分段缓存；网格虚拟化需实测收益。

### 范围外

- `24`：属于独立的上下文压缩 PR，不在本分支。

## 验证命令

```powershell
cd D:\Project\TouchAI\.worktrees\perf-raycast-plan\apps\desktop
pnpm exec vitest run --configLoader runner --passWithNoTests --reporter=dot
pnpm type:check
node scripts/run-rust-command.mjs check   # 需要 cargo 在 PATH，且先把 rtk 缓存放入 rust-target/check/rtk-cache/0.40.0/<triple>/
```

## 事故与约束记录

- 07 未做线级 delta 协议：`SessionTaskCenter` 与订阅者同处一个 JS 上下文，真正成本是深拷贝与重渲染；已改为「一次发布一份只读快照 + 未变消息对象身份复用」，语义上等价且无 stale 风险。
- 迁移 `0008` 使用 SQLite `ALTER TABLE ADD COLUMN ... GENERATED ... VIRTUAL`，`meta/0008_snapshot.json` 与 journal 已同步。
- `message_parts` 新增 `tool_id` / `server_id` 生成列，`data` 仍是唯一写入源。
- 旧库升级路径有 1 万消息级回归夹具（`tests/database/legacy-0004-migration.test.ts`），记录迁移耗时。
- 未改变 `message_parts` 为正文唯一真相源的契约；FTS 子串语义、审批/取消即时有序均保留。
- Rust 编译缓存（`apps/desktop/rust-target/`，约 4.3GB）在磁盘紧张时可直接删除，重新编译即可恢复。
- 主编排目录 `D:\Project\TouchAI` 的脏工作区未被改动。
- 全量测试在并发下会让个别「首次 import 大模块」的用例超时，已在对应测试里显式放宽超时，不把资源竞争当成真实回归。
- 本 worktree 的 `node_modules` 曾被误删导致 `type:check`/`vitest` 失效过一段时间；已用 `pnpm install --frozen-lockfile` 恢复，`package.json` / `pnpm-lock.yaml` 哈希未变。

## Rebase 复核记录（最新一次）

- 已 rebase 到 `origin/main@34b3ce93`（含 33 个上游提交：DeepSeek 搜索、用量统计、UAT 测试重构等）。
- 最终验证：`vitest` 437 文件 / 5414 用例全过、`vue-tsc --noEmit` 通过、`eslint src tests` 0 error（33 个既有 warning）。
- Rust：`cargo check` 本轮无法本地执行（build.rs 需要从 GitHub 下载 bundled rtk，网络超时）；按约定由 CI 验证。冲突仅发生在 `client_manager.rs`，已按「短锁取快照 + 锁外 RPC」合并。
- 复核方式：对 52 项逐条做「文件 + 语义锚点」检查，全部在位。

### rebase 中发现并修复的真实冲突/覆盖

| 区域 | 现象 | 处理 |
| --- | --- | --- |
| 01 启动 | 冲突解决时 bootstrap 回到了「工具补种后才挂载」 | 恢复「先挂载 + 后台能力注册 + 请求级就绪门」 |
| 02 provider 边界 | 上游新对话框让 `providers/index` 重新转出 `drivers`，设置页又拉全部 adapter | 移除该转出；设置页按需 `defineAsyncComponent` 加载对话框 |
| 09/12/N02/N03 Markdown | 上游新增引用组件与我的双 parser/长代码/滚动 owner 冲突 | 合并为一处，保留全部行为 |
| 16 widget 草稿 | 我的 80ms 节流让上游「逐 delta 更新」测试失败 | 仅对 ≥2000 字符的累计参数节流 |
| 18 光标/多行 | 上游要求多行状态同步更新 | 回退按帧合并，保留「光标三标记单次文档查询」 |
| 21 历史搜索防抖 | 上游测试期望 await 后立即生效 | `updateSessionSearchQuery` 改为可 await 的防抖 |
| 22 历史分页 | 分页会让滚动条与时间轴失真，且与任务快照全量 `sessionHistory` 不一致 | 回退为一次全量读取，渲染由窗口化控流，删除分页 API 与提示行 |
| 25/07/08 持久化/快照 | `persistToolResult` 上游重构 | 与「跳过未变 part」「快照身份复用」并存，摘要刷新不丢 |
| 32 窗口探针 | 并行探测改变了状态写入顺序，手选高度测试失败 | 并行发 IPC，但按「先最大化、再高度模式」写状态 |
| 39 日志 | 上游测试要求日志立即投递 | 改为「有界在途 + 立即投递」，仅超限时丢弃并汇总 |
| N08 元数据 | 动态 import 在测试中会绕过 mock 加载真实模块 | 新增 `modelMetadata/syncEntry` 轻入口，seed 仍独立动态加载 |
| 测试基础设施 | 冲突解决产生的 UTF-16 文件、CRLF 行尾 | 统一转回 UTF-8/LF，并跑 prettier 归一 |
