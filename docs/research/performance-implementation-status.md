# TouchAI 性能优化实施状态

- 基线：`origin/main@1b8180052a2bdd57c82a920a4a71725b9dfaf471`（桌面 1.2.2）
- 分支：`codex/perf-raycast-plan`（worktree：`.worktrees/perf-raycast-plan`）
- 方案来源：`docs/research/performance-improvement-plan-main.md`（52 项）
- 最近验证：`vitest` 全部通过（当前 233 文件 / 1750+ 用例）、`vue-tsc --noEmit` 通过、改动文件 ESLint 0 error
- **Rust 侧验证**：`cargo check --all-targets` 全部通过；按约定 `cargo test` 交由 CI 执行（本地磁盘不足）
- 未做性能基线/前后对比（按约定，待用户验收后另行补基线）

## 已完成（40 项）

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
| 30 | 资源缓存按字节 LRU | `531d7a48` |
| 31 | 快捷方式回写走 `path_norm → 下标` 索引，全局写锁内不再线性扫描 | `72780c93` |
| 32 | 窗口状态独立探针并行下发（最大化 + 高度模式） | `41a5b0fd` |
| 33 | tauriFetch 背压/取消 | `88770fa1` |
| 36 | WebFetch 单次 HTML 解析（图片/标题/正文共用 DOM，Readability 用克隆副本） | `09a75f0d` |
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

## 部分完成（7 项）

| 编号 | 已完成 | 未完成 |
| --- | --- | --- |
| 14 | 会话图片 `decoding="async"` + `loading="lazy"`（`3a36b2f4`） | 真实缩略图生成（Rust）、按内容 hash/尺寸缓存、增大原图缓存隔离 |
| 18 | 光标三个标记共享一次文档查询；自动换行布局测量按帧合并（`bdfe3a2b`） | docChanged/selectionChanged 分类更新；宽度变化触发重算 |
| 22 | 分页查询（`findMessagesPageBySessionId`）+ 分页 loader（`loadSessionHistoryPage`）与游标（`c9f9b977`） | UI 首屏/滚动加载接线：center 的任务 bootstrap 会全量加载历史并接管 sessionHistory，需先改投影/历史所有权协议（与 `10` 同批） |
| 23 | turn 内 `SessionReadModel`：附件预检与 transport 重建共享一次查询（`815071ab`） | 展示 bootstrap/分页与 transport 跨阶段复用 |
| 27 | 点击统计并行预取（`567f3d4c`） | 后续排序/写回合并 |
| 34 | auto-paste 先原子预留授权/新鲜度/去重，再做重任务；外链图片解析 3 并发 + 10s 总预算；结果按 snapshotId 校验（`3498b760`） | 两阶段 API（文本先回、附件 placeholder 补齐）与草稿 generation 缓存 |
| 10 | 消息级窗口化（消息 > 40 启用）+ 高度测量/补偿 + 未挂载跳转定位（`828ae276`） | part 级有界挂载、图片后加载/回滚回归、跨虚拟项选区策略需真机验收 |

## 待实施（4 项）

| 编号 | 摘要 | 备注 |
| --- | --- | --- |
| 04 | 启动契约维护 | 无新增优化任务；Settings 不重同步已由启动测试覆盖 |
| 05 | 多窗口保温内存/延迟预算 | 测量优先：需 main/popup/tray 的增量内存与首开延迟数据后才能定 TTL |
| 29 | 快捷项虚拟化 | 已有 60 条/页分页 + generation 校验；单页固定行高虚拟化收益需实测后再定 |
| 35 | 附件 metadata-only 规划与流式物化 | Rust 端大改造，需真实附件场景回归 |

### 需真机/真实数据验收

- `10` 剩余：part 级有界挂载、图片后加载/回滚/时间轴与键盘翻页回归、跨虚拟项选区策略。
- `22` 剩余：首屏分页 UI 接线（依赖 center 投影/历史所有权协议）。
- `34` 剩余：两阶段 API（文本先回、附件 placeholder 补齐）与草稿 generation 缓存。
- `05` / `29` / `35`：需先拿到测量数据或真实附件场景。

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
- 剩余 4 项均需真实数据/真机回归（内存预算、附件场景、虚拟化收益），未做任何猜测性实现。
