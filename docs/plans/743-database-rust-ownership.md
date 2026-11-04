# Database Ownership Migration

Related issue: #743. Related RFC: #710.

This plan records the database contract that must stay stable while production
data access moves from TypeScript/Drizzle to Rust. It is an implementation
guard, not a schema proposal.

## Hard constraints

- No table, column, index, constraint, trigger, view, retention rule, deletion
  rule, or backfill changes.
- Migration files `0000` through `0004`, `_journal.json`, and every committed
  snapshot remain byte-identical.
- The existing migration ledger and ordering remain authoritative. No second
  migration ledger is introduced.
- Existing SQLite files are opened in place. No database path, file name, WAL
  mode, or rebuild step changes.
- TypeScript may keep view models and request/response types. It may not build
  SQL, own a transaction span, or write through a second production path.
- Rust owns the connection pool, private repositories, validation, complete
  business transactions, stable error mapping, and post-commit notifications.
- A dual run is allowed only in an isolated test database for equivalence
  evidence. It is never a production fallback.

## Current contract

The runtime contract is defined by the committed migration chain plus these
runtime artifacts:

- `src/database/drizzle/0000_lyrical_toad.sql` through
  `0004_ordinary_solo.sql`
- `src/database/drizzle/meta/_journal.json`
- committed `drizzle/meta/*_snapshot.json` files
- `src/database/artifacts/runtime/guards.sql`
- `src/database/artifacts/runtime/seed.sql`
- `src/database/artifacts/import/full_prelude.sql`
- `src/database/artifacts/import/chat_merge.sql`

The reviewed SHA-256 values live in
`scripts/ci/architecture/db-artifacts-baseline.json`. A contract test must fail
when any committed artifact changes without an explicit review.

## Production writer map before migration

The initial inventory is intentionally complete at module granularity. The
implementation commits replace each entry with one Rust transaction or one
Rust read operation.

| Area | Current production writer | Required Rust boundary |
| --- | --- | --- |
| Settings | `queries/settings.ts` | `setting_upsert` / `setting_get` |
| Statistics | `queries/statistics.ts` | `statistic_upsert` / `statistic_get` |
| App metadata | `queries/touchaiMeta.ts` | `meta_get`, `meta_upsert`, `meta_delete` |
| Providers | `queries/providers.ts` | provider CRUD operations |
| Models and default model | `queries/models.ts` | model CRUD plus `model_set_default` transaction |
| LLM catalog metadata | `queries/llmMetadata.ts`, `modelMetadata/store.ts`, `modelMetadata/sync.ts` | metadata replace/upsert transactions |
| MCP servers | `queries/mcpServers.ts` | server CRUD operations |
| MCP tools | `queries/mcpTools.ts`, `McpManager.ts` | tool CRUD and server tool replacement transaction |
| Built-in tools | `queries/builtInTools.ts` | tool CRUD plus multi-update transaction |
| Tool logs | `queries/toolParts.ts`, `toolParts` callers | atomic tool-part create/update operations |
| Sessions | `queries/sessions.ts` | session create/update/list/delete operations |
| Messages | `queries/messages.ts`, `outputs/persistence.ts` | message create/update and turn persistence bundles |
| Message parts and attachments | `queries/messageParts.ts`, `queries/attachments.ts`, `outputs/persistence.ts` | atomic part/attachment bundles |
| Turns | `queries/sessionTurns.ts`, `outputs/persistence.ts` | complete turn lifecycle transactions |
| Turn attempts | `queries/sessionTurnAttempts.ts`, `outputs/persistence.ts` | attempt lifecycle and usage transactions |
| Usage rollups | `queries/usageStats.ts`, `UsageService/*` | high-level usage write operations |
| Quick-search clicks | `queries/quickSearchClicks.ts` | click upsert operation |
| Backup/import | `database/backup.ts` plus Rust import runtime | Rust export/import with UI progress only |

## Business transaction map

These spans must not be split across IPC calls once the Rust owner is active.

| Business action | Current TS span | Rust operation |
| --- | --- | --- |
| Set default model | clear old default and set new default | `model_set_default` |
| Update many built-in tools | update every requested row or none | `built_in_tools_update_many` |
| Create tool part | choose `max(sort_order) + 1`, insert part, return parent session | `tool_part_create` |
| Update tool part | find matching parts, merge JSON, return first result | `tool_part_update` |
| Replace MCP tools after connect | delete server tools and insert discovered tools | `mcp_tools_replace_for_server` |
| Replace LLM catalog | delete aliases and metadata, then insert catalog | `llm_metadata_replace` |
| Refresh model catalog | delete/recreate provider models and preserve defaults | `models_replace_catalog` |
| Persist one assistant output step | validate attempt/step, write parts/messages/turn state atomically | `task_persist_output_step` |
| Create a turn attempt | create turn/attempt bookkeeping and linked rows | `task_begin_attempt` |
| Finish a turn attempt | update status, usage, and linked turn state atomically | `task_finish_attempt` |
| Import backup | run import in one Rust-owned serialized operation | `database_import_backup` |

## Compatibility matrix

Every row must be exercised on a frozen database fixture. The comparison
includes business results, error category, event order, and a final database
snapshot.

| Fixture | Required evidence |
| --- | --- |
| Empty database | latest migrations, guards, seed, and first-write behavior |
| Migration stage `0000` | upgrade to `0004`, preserving rows and generated columns |
| Migration stage `0001` | upgrade from the legacy message shape |
| Migration stage `0002` | deduplication result and unique click-stat index |
| Migration stage `0003` | legacy built-in tool log upgrade |
| Migration stage `0004` | current latest schema and FTS behavior |
| v1.0 database | read, write, and import compatibility |
| v1.2 database | read, write, and import compatibility |
| v1.3 database | read, write, and import compatibility |
| WAL database | checkpoint, concurrent read, crash recovery, and restart |
| FTS database | write, update, delete, and search after every migration |
| ID gaps | ordering and pagination do not depend on contiguous IDs |
| Old backup | `full` and `chat_only` imports preserve the documented merge shape |
| Multi-window settings | concurrent mutation is serialized and stale epochs are rejected |
| Same call ID | duplicate tool updates are idempotent and ordered |
| Default model | exactly zero or one default model at every commit boundary |
| Import versus Agent write | one complete operation wins; no partial rows remain |

## Schema comparison

The contract fingerprint compares ordered, canonicalized rows from:

- `sqlite_master` for tables, indexes, triggers, views, and SQL
- `PRAGMA table_info`
- `PRAGMA index_list` and `PRAGMA index_info`
- `PRAGMA foreign_key_list`
- `sqlite_sequence`
- FTS virtual-table metadata and representative content

The fingerprint is stored as test data, not generated as a production schema.
Migration bytes and snapshots are checked separately from the semantic
fingerprint so an editor cannot hide a byte change by changing the fixture.

## Rollout and rollback

- Rollout is one PR: typed Rust operations first, domain switches second,
  removal of generic SQL/transaction IPC last.
- No release is made from this PR. The existing database file is opened in
  place and is never rewritten or rebuilt.
- Rollback before release is a revert of this PR. After release, a rollback
  must keep the same SQLite file readable by the previous version.
- Errors are mapped to stable categories: validation, not found, conflict,
  busy/locked, unavailable, and unknown. User-facing text remains in the
  existing localization layer.

## Stop conditions

Stop and ask before implementing if:

- a table, column, index, constraint, trigger, view, migration byte, or
  migration ledger change is required;
- a production TypeScript writer must remain alongside Rust;
- an older version cannot read data written by the new version;
- an unexplained business, ordering, retry, cancellation, or event difference
  appears;
- a P50/P95 latency or steady-state memory result exceeds the 5% budget.
