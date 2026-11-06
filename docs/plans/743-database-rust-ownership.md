# Database Ownership Migration

Related issue: #743. Related RFC: #710.

This document records the implemented ownership boundary and the evidence
required before release. It is not a schema proposal.

## Status

Implementation is in progress on `stack/710-09-database-rust-ownership`. The
production TypeScript Drizzle runtime and the generic SQL/transaction IPC are
removed in the worktree. Final project-wide and CI acceptance is not claimed
until the checks listed under "Open evidence" pass.

## Hard constraints

- No table, column, index, constraint, trigger, view, retention rule, deletion
  rule, or backfill changes.
- Migration files `0000` through `0004`, `_journal.json`, and every committed
  snapshot remain byte-identical.
- The existing migration ledger and ordering remain authoritative. No second
  `sqlx migrate` ledger is introduced.
- Existing SQLite files are opened in place. No database path, file name, WAL
  mode, or rebuild step changes.
- TypeScript may keep view models and request/response types. It may not build
  SQL, own a transaction span, or write through a second production path.
- Rust owns the connection pool, private repositories, validation, complete
  business transactions, stable error mapping, and backup/import.
- A dual run is allowed only in an isolated test database for equivalence
  evidence. It is never a production fallback.

## Runtime ownership

The only production Tauri database commands are:

- `database_operation` with a named, typed operation; no SQL text crosses IPC.
- `database_export_backup` and `database_import_backup`, restricted to the main
  and settings windows.

The committed migration chain and runtime artifacts remain the database
contract:

- `src/database/drizzle/0000_lyrical_toad.sql` through
  `0004_ordinary_solo.sql`
- `src/database/drizzle/meta/_journal.json`
- committed `drizzle/meta/*_snapshot.json` files
- `src/database/artifacts/runtime/guards.sql`
- `src/database/artifacts/runtime/seed.sql`
- `src/database/artifacts/import/full_prelude.sql`
- `src/database/artifacts/import/chat_merge.sql`

The reviewed SHA-256 values live in
`scripts/ci/architecture/db-artifacts-baseline.json`. `drizzle-orm` and
`schema.ts` are offline development/audit inputs. Production runtime imports of
`drizzle-orm` or `@database/schema` are rejected by the architecture gate;
type-only schema imports are allowed and erased.

## Production writer map

Every entry below is a named Rust operation or a Rust-owned composition of
operations. The TypeScript query modules are typed callers only.

| Area | Production entry point |
| --- | --- |
| Settings, statistics, app metadata | `setting_*`, `statistic_*`, `meta_*` |
| Quick-search clicks | `quick_search_upsert` |
| Providers and models | `provider_*`, `model_*` |
| LLM catalog metadata | `llm_metadata_*` including `llm_metadata_replace` |
| MCP servers and tools | `mcp_server_*`, `mcp_tool_*` including `mcp_tool_sync` |
| Built-in tools | `built_in_tool_*` including `built_in_tool_update_many` |
| Sessions and messages | `session_*`, `message_*` |
| Output steps and turn state | `task_record_start`, `task_persist_output_message`, `task_finish`, `task_begin_next_attempt` |
| Tool history | `tool_part_*`, `task_persist_tool_result` |
| Attachments | `attachment_ensure`, `attachment_remote_ref_*` |
| Usage queries and detail writes | `usage_*` including `usage_append_llm_call_parts` |
| Backup/import | `database_export_backup`, `database_import_backup` |

`BEGIN IMMEDIATE` is the standard typed-write transaction entry. Import uses
`BEGIN EXCLUSIVE` after preparing and migrating an isolated source snapshot, so
an Agent write and a full import serialize instead of interleaving.

## Business transaction map

These spans are atomic in Rust and are not split across IPC calls:

| Business action | Rust boundary |
| --- | --- |
| Set default model | validate provider/model, clear old default, set new default |
| Update many built-in tools | update every requested row or none |
| Create tool part | choose `max(sort_order) + 1`, insert part, return parent session |
| Update tool part | find matching rows, merge JSON, return first result |
| Replace MCP tools after connect | delete server tools and insert discovered tools |
| Replace LLM catalog | delete aliases/metadata then insert the catalog |
| Refresh model catalog | update provider models and preserve defaults |
| Persist one assistant output step | validate attempt/step, write parts/messages/turn state |
| Create a turn attempt | create turn/attempt bookkeeping and linked rows |
| Finish a turn attempt | status, usage, LLM-call parts, and turn aggregate update together |
| Persist a tool result | locate by part id or `(call id, message id)`, update data, link attachments |
| Import backup | snapshot, migrate, validate, merge, commit, detach, and remove temp files |

## Compatibility matrix

The comparison includes business results, error category, event order, and the
final database state where applicable.

| Fixture or behavior | Evidence |
| --- | --- |
| Empty/latest database and runtime seed | Existing migration/seed contract tests plus SQLite runtime tests |
| Migration stages `0000` through `0004` | Existing unified-parts and usage-observability migration tests; every stage applies the byte-identical SQL |
| v1.0, v1.2, v1.3 released databases | Frozen fixtures under `apps/desktop/tests/fixtures/database/released/` are copied to an isolated data directory, opened in place, migrated to `0004`, and exercised through typed reads and FTS |
| WAL and committed-WAL import | Import/export use `VACUUM INTO`; runtime import tests keep the source WAL open |
| FTS write, update, delete | `database_search_index_supports_contentless_delete_on_bundled_sqlite` |
| ID gaps and pagination | Existing session/usage query tests plus the released fixtures preserve `sqlite_sequence.sessions = 30` and return the latest session through limit 1 |
| Old full and chat-only backups | Rust import tests cover 4-entry upgrade, repeated import, malformed history, and rollback |
| Invalid/ambiguous imports | Rust tests verify no target change, no attached temp database, and no leftover snapshot directory |
| Export failure cleanup | Rust export test verifies the pool remains usable and the temporary snapshot is removed |
| Same call ID across messages | Rust test verifies a tool result update is scoped by `(tool_call_id, message_id)` and is idempotent |
| Two attempts with reasoning/cost | Rust test verifies per-attempt values, turn sums, pricing data, and LLM-call part ordering |
| Import versus Agent write | Rust test runs a full import concurrently with `task_record_start`; both operations complete with no partial rows |
| Multi-window permissions | Real-window Rust tests cover main/settings allowed operations plus settings Agent/usage-write denials, popup Agent/settings/tool-history/usage/backup denials, and preview settings/backup denials |
| Default model uniqueness | Rust typed-operation test verifies one default after a switch |

Schema comparison must still compare order-independent rows from
`sqlite_master`, `PRAGMA table_info`, `PRAGMA index_list`/`index_info`,
`PRAGMA foreign_key_list`, `sqlite_sequence`, triggers, views, and representative
FTS content. Migration bytes and snapshots are checked separately from the
semantic fingerprint. `released_database_fixtures.rs` compares the upgraded
fixture schema against a fresh current database and separately asserts the WAL
journal mode, foreign keys, preserved ID sequence, FTS search, and migrated
message/tool/attachment content.

## Rollout and rollback

- Rollout is one PR: typed operations and domain switches, then removal of the
  generic SQL/transaction IPC and Drizzle runtime.
- No release is made from this PR. Existing database files are opened in place
  and are never rewritten or rebuilt.
- Rollback before release is a revert of this PR. After release, a rollback must
  keep the same SQLite file readable by the previous version.
- Errors map to stable categories: validation, not found, conflict, busy/locked,
  unavailable, and unknown. User-facing text remains in the existing
  localization layer.

## Open evidence

These are release gates, not claims:

- Re-run the full Rust suite, frontend tests, typecheck, architecture checks,
  E2E, and required GitHub Actions checks.
- Run the performance acceptance workflow on GitHub Actions. Daytona is not a
  dependency and must not be left running.
- Confirm P50/P95 latency and memory are within the 5% budget; an unexplained
  regression stops the rollout.
