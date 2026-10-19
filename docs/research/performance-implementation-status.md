# TouchAI 性能优化实施状态

- 基线：`origin/main@1b8180052a2bdd57c82a920a4a71725b9dfaf471`（桌面 1.2.2）
- 分支：`codex/perf-raycast-plan`（worktree：`.worktrees/perf-raycast-plan`）
- 方案来源：`docs/research/performance-improvement-plan-main.md`（52 项）
- 最近验证：`vitest` 228 文件 / 1738+ 用例通过，`vue-tsc --noEmit` 通过，改动文件 ESLint 0 error
- **Rust 侧验证限制**：`cargo check --all-targets` 通过（`node scripts/run-rust-command.mjs check`）；`cargo test` 因磁盘空间不足（D: 剩余 1.8GB）无法链接测试二进制，Rust 单测代码已通过类型检查但未在本机执行
- 未做性能基线/前后对比（按约定，待全部完成后另行补基线）

## 已完成（33 项）

| 编号 | 内容 | 关键提交 |
| --- | --- | --- |
| 01 | 启动三阶段：先挂载外壳，工具/Bash/元数据转后台能力 + 请求级就绪门 | `dc5f69fa` |
| 02 | provider driverCatalog 拆分，设置页不再拉全部 adapter | `6b191bd0` |
| 03 | 设置批量读取（`getSettingValues`） | `4ab7ddbb` |
| 06 | 字体成功路径不重复 fetch | `d90cf0ac` |
| 08 | 发布给 UI 的展示快照剔除 runtime checkpoint / prompt 快照 | `3a500549` |
| 09 | Markdown 流式解析合并窗口 + 静态/流式 parser 分离 | `e9c8afc9` |
| 11 | 收起 reasoning 卸载 Markdown + bounded preview | `bb9659d6` |
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
| 33 | tauriFetch 背压/取消 | `88770fa1` |
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
| N11 | 0004 全库迁移夹具（1 万消息 + 旧工具日志/附件/孤儿）+ 耗时记录 | `a4783843` |
| N12 | SSE 行预筛 | `e4dc4c99` |

## 部分完成（4 项）

| 编号 | 已完成 | 未完成 |
| --- | --- | --- |
| 07 | 普通流式快照按微任务合并发布；审批/完成同步 flush（`12dbec66`） | 差量协议：`taskId/epoch/seq + 变更消息 ID + patch`，历史未变消息保持对象身份 |
| 14 | 会话图片 `decoding="async"` + `loading="lazy"`（`3a36b2f4`） | 真实缩略图生成（Rust）、按内容 hash/尺寸缓存、增大原图缓存隔离 |
| 23 | turn 内 `SessionReadModel`：附件预检与 transport 重建共享一次查询（`815071ab`） | 展示 bootstrap/分页与 transport 跨阶段复用 |
| 27 | 点击统计并行预取（`567f3d4c`） | 后续排序/写回合并 |

## 待实施（15 项）

### 前端

| 编号 | 摘要 | 备注 |
| --- | --- | --- |
| 07 | 差量快照协议（P0，最大剩余项） | 依赖消息 identity/revision 协议 |
| 12 | 代码块增强按需初始化 | 需按 markstream 1.0.6 实测；长代码纯文本入口 |
| 18 | Tiptap transaction 分类更新 | 现有测试 mock 编辑器 |
| 22 | 历史首屏分页（40–80 条/页 + 游标 + scroll anchor） | UI 改动大 |
| 29 | 快捷项 top-K + 列表/网格虚拟化 | 需与 Rust 搜索端配合 |
| 35 | 附件 metadata-only 规划与流式物化 | 依赖 Rust |
| 36 | web_fetch 解析拆分/Worker | 需先埋点实测 |
| N03 | 恢复 viewport 能力 | 已验证 markstream 1.0.6 提供 `virtualScroll.scrollRoot`（可绑定外层滚动 owner）；需真实渲染环境验证后从 bypass 切换 |

### Rust（`cargo check` 可验证，`cargo test` 受磁盘限制）

| 编号 | 摘要 |
| --- | --- |
| 05 | 多窗口保温内存/延迟预算 |
| 31 | 快捷方式回写线性 find 与长写锁 |
| 32 | 窗口几何/resize IPC 合并 |
| 34 | 剪贴板图文顺序（含产品决策） |
| N10 | Bash 输出有界缓冲与流式落盘 |

### 需产品决策

- `24`：上下文预算与摘要策略
- `10`：跨虚拟项选区语义
- `34`：剪贴板图文顺序

## 验证命令

```powershell
cd D:\Project\TouchAI\.worktrees\perf-raycast-plan\apps\desktop
pnpm exec vitest run --configLoader runner --passWithNoTests --reporter=dot
pnpm type:check
node scripts/run-rust-command.mjs check   # 需要 cargo 在 PATH，且先把 rtk 缓存放入 rust-target/check/rtk-cache/0.40.0/<triple>/
```

## 事故与约束记录

- 迁移 `0008` 使用 SQLite `ALTER TABLE ADD COLUMN ... GENERATED ... VIRTUAL`，`meta/0008_snapshot.json` 与 journal 已同步。
- `message_parts` 新增 `tool_id` / `server_id` 生成列，`data` 仍是唯一写入源。
- 旧库升级路径有 1 万消息级回归夹具（`tests/database/legacy-0004-migration.test.ts`），记录迁移耗时。
- 未改变 `message_parts` 为正文唯一真相源的契约；FTS 子串语义、审批/取消即时有序均保留。
- Rust 编译缓存（`apps/desktop/rust-target/`，约 4.3GB）在磁盘紧张时可直接删除，重新编译即可恢复。
- 主编排目录 `D:\Project\TouchAI` 的脏工作区未被改动。
