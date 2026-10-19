# TouchAI 性能优化实施状态

- 基线：`origin/main@1b8180052a2bdd57c82a920a4a71725b9dfaf471`（桌面 1.2.2）
- 分支：`codex/perf-raycast-plan`（worktree：`.worktrees/perf-raycast-plan`）
- 方案来源：`docs/research/performance-improvement-plan-main.md`（52 项）
- 最近验证：`vitest` 226 文件 / 1725 用例通过，`vue-tsc --noEmit` 通过，改动文件 ESLint 0 error
- 未做性能基线/前后对比（按约定，待全部完成后另行补基线）

## 已完成（24 项）

| 编号 | 内容 | 关键提交 |
| --- | --- | --- |
| 02 | provider driverCatalog 拆分，设置页不再拉全部 adapter | `6b191bd0` |
| 03 | 设置批量读取（`getSettingValues`） | `4ab7ddbb` |
| 06 | 字体成功路径不重复 fetch | `d90cf0ac` |
| 09 | Markdown 流式解析合并窗口 + 静态/流式 parser 分离 | `e9c8afc9` |
| 11 | 收起 reasoning 卸载 Markdown + bounded preview | `bb9659d6` |
| 13 | 会话滚动改尾部 revision，移除 deep watch | `295290ed` |
| 15 | Widget 脚本资源作用域回收 | `b6df37af` |
| 16 | Widget 参数草稿去重 + 节流 | `ea49a55c` |
| 17 | 隐藏期暂停展示型定时器 | `de197043` |
| 19 | `messages(session_id, id)` 索引 | `05106850` |
| 20 | sessions 活动时间表达式索引 + 轮次复合索引 | `9f9a701a` |
| 21 | 历史搜索 120ms 防抖 | `465cb164` |
| 26 | 工具日志轻量投影 + 展开时取详情 | `5f5e6cf0` |
| 28 | 快搜翻页 generation 校验 | `321e022d` |
| 30 | 资源缓存按字节 LRU | `531d7a48` |
| 33 | tauriFetch 背压/取消 | `88770fa1` |
| 39 | 日志 callsite 过滤 + 有界队列 | `99945d2b` |
| 40 | 轻量 perf trace + 三条热路径埋点 | `073fd728` |
| N01 | 数学检测预筛 | `1c6ede5b` |
| N02 | 仅未闭合数学边界回退全量解析 | `e9c8afc9` |
| N04 | FTS 触发器收窄 | `e306e89d` |
| N05 | 多三元组候选（detail=none 限制） | `2e7a58aa` |
| N09 | Settings 串行 idle 预热 + hover 优先 | `52014a40` |
| N12 | SSE 行预筛 | `e4dc4c99` |

## 部分完成（3 项）

| 编号 | 已完成 | 未完成 |
| --- | --- | --- |
| 07 | 普通流式快照按微任务合并发布；审批/完成保持同步 flush（`12dbec66`） | 差量协议：`taskId/epoch/seq + 变更消息 ID + patch`，历史未变消息保持对象身份 |
| 23 | turn 内 `SessionReadModel`：附件预检与 transport 重建共享一次消息行查询（`815071ab`） | 展示 bootstrap/分页与 transport 跨阶段复用；同 executor 短读事务 |
| 27 | 点击统计并行预取（`567f3d4c`） | 后续排序/写回合并 |

## 待实施（25 项）

### 前端可测（下一批建议）

| 编号 | 摘要 | 备注 |
| --- | --- | --- |
| 01 | 启动三阶段拆分（配置/mount 外壳/后台能力 ready Promise） | 需覆盖空库、离线、大模型目录、首帧立即提交 |
| 07 | 差量快照协议（P0，最大剩余项） | 依赖消息 identity/revision 协议 |
| 08 | 精简 `TaskViewSnapshot`，终态释放 checkpoint/诊断 | 与 07 同批 |
| 22 | 历史首屏分页（40–80 条/页，向前游标 + scroll anchor） | UI 改动大 |
| 25 | 写入事务内批量刷新会话摘要 / 分区计数增量 | 现有实现已跳过未变 part |
| 29 | 快捷项 top-K + 列表/网格虚拟化 | 需与 Rust 搜索端配合 |
| 12 | 代码块增强按需初始化 | 需先按 1.0.6 实测成本 |
| 14 | 附件按显示尺寸生成缩略图 | 生成端在 Rust |
| 18 | Tiptap transaction 分类更新 | 现有测试 mock 编辑器，无法验证真实行为 |
| 35 | 附件 metadata-only 规划与流式物化 | 依赖 Rust |
| 36 | web_fetch 解析拆分/Worker | 需先埋点实测 |
| N03 | 恢复 viewport 能力（外层滚动 owner 绑定） | 需核实 markstream 1.0.6 API |
| N06 | 生成投影列替代 JSON 路径表达式索引 | 需手写迁移（drizzle-kit 表达式索引有缺陷） |
| N07 | 输出 part revision + 边界增量入队 | 与 08/22 同族 |
| N08 | metadata 入口拆分（seed/refresh/sync） | 轻模块入口 |

### 需 Rust 工具链（cargo 位于 `C:\Users\26366\.cargo\bin`，未在 PATH）

`31`、`34`、`37`、`38`、`N10`、`N11`、`32`、`05`、`04`（契约守护）。
构建：`node scripts/run-rust-command.mjs check|test`（`CARGO_TARGET_DIR=rust-target/<mode>`）。
首次冷编译耗时未知，建议集中一批做一次 `cargo check` 验证。

### 需产品决策

- `24`：上下文预算与摘要策略（保留最近 N 轮？摘要触发阈值？）
- `10`：跨虚拟项选区语义（复制范围、跨项选择行为）
- `34`：剪贴板图文顺序（图片与文字混排的复制顺序）

## 验证命令

```powershell
cd D:\Project\TouchAI\.worktrees\perf-raycast-plan\apps\desktop
pnpm exec vitest run --configLoader runner --passWithNoTests --reporter=dot
pnpm type:check
pnpm exec eslint <changed-files>
```

## 事故与约束记录

- 迁移 `0007` 手写修正 drizzle-kit 生成的非法表达式索引；`meta/` snapshot 与 journal 保持一致。
- 未改变 `message_parts` 为正文唯一真相源的契约；FTS 子串语义、审批/取消即时有序均保留。
- 主编排目录 `D:\Project\TouchAI` 的脏工作区未被改动。
