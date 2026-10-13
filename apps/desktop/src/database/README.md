# 消息正文与搜索索引

## 唯一正文来源

`messages` 只保存消息元信息，`message_parts` 保存有序的正文、推理和推理时间点。
读取时按 `(sort_order, id)` 拼接 `type IN ('text', 'tool_result')` 的片段，得到消息正文。
搜索、历史恢复和摘要使用相同顺序；推理不参与正文搜索。

## FTS5

`message_search_fts` 是派生索引，不是另一份消息存储：

- `rowid` 对应消息 ID，一条消息对应一个搜索文档，允许关键词跨正文片段匹配。
- `content=''`、`contentless_delete=1`：不保存原文副本，支持普通删除和替换。
- `tokenize='trigram'`：用于子串候选检索，而不是按英文单词切分。
- `detail=none`：不存词位置；不依赖短语查询、排名或 FTS 高亮。
- 要求 SQLite 3.43.0 或以上且启用 FTS5；Rust 集成测试直接验证应用携带的 SQLite。

查询至少三个 Unicode 码点时，将开头的三个码点转义为一个字面 MATCH token，
先获取候选消息 ID，再对有序正文做完整的、转义后的 LIKE 检查，统一派生命中的会话 ID。
外层会话查询使用 IN 子查询，避免每个会话重复遍历候选消息。
这避免把用户输入当作 FTS 运算符，并保留原有大小写、特殊字符和子串匹配语义。
一两个码点的查询及包含 NUL 的查询直接走原文匹配；会话标题仍按原有方式搜索。

只筛选一个 trigram 使查询大小固定，但常见开头会产生更多候选；原文核验保证结果正确。
这不是全文扫描完全消失的承诺，也没有引入相关性排序。

## 同步与迁移

三个 `message_parts` 触发器处理正文插入、删除，以及内容、类型、顺序、所属消息的变化。
每次重新派生受影响消息的正文并更新索引；最后一个正文片段删除后移除索引记录。
时间字段、仅推理的修改和未变化的正文不会单独触发索引重写。
触发器与源数据同事务提交或回滚，级联删除和备份导入无需额外同步代码。

代价是多片段批量替换时，行级触发器可能多次更新同一条消息的索引。
当前优先保持一致性和简单架构，不增加定时器、后台同步队列或第三份缓存。
倒排索引本身仍占磁盘，删除也不保证立刻缩小数据库文件。

FTS 虚拟表与触发器使用 Drizzle custom migration SQL；它们不映射为业务 schema 实体。
当前 PR 的 custom SQL 已合并至唯一尚未发布的
`0004_wide_starhawk` 迁移，从已发布的 `0003` 直接建立最终 parts 结构，
迁移正文、思考、工具、附件关联并精简 checkpoint，最后一次性创建和回填索引。
关系表 SQL、最终 snapshot 与 journal 由 Drizzle CLI 重新生成；数据搬迁与 FTS 使用 custom SQL。
后续已发布迁移不应修改，应使用新的 custom migration；不要手工给关系表快照添加虚拟表。

contentless 索引不能自行读回原文进行 rebuild。需要重建时，在同一写事务内清空
FTS（`delete-all`），再从按序拼接的 `message_parts` 重新插入；parts 始终是恢复来源。

## 回归测试

`tests/database/message-parts-contract.test.ts` 使用真实 SQLite 验证迁移回填、
索引同步、回滚、导入、跨片段匹配、中文、短词和字面特殊字符，并检查执行计划使用 FTS。
`src-tauri/tests/database_commands.rs` 验证应用携带的 SQLite 支持上述索引配置及同步行为。
