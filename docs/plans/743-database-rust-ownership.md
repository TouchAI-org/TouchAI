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
  and settings windows. A successful import records the post-restart
  `import_success` metadata inside the Rust import transaction; the settings
  window only owns the restart countdown and dialog.

## Surface permission matrix

Rust checks the calling window label before dispatching a typed operation. The
allow-list is explicit and defaults to denial for every unlisted surface/group
pair:

| Surface | Allowed database groups | Denied database groups |
| --- | --- | --- |
| `main` | Every group: settings reads/writes, config, agent, maintenance, search, tool history, usage reads/writes | None |
| `settings` | Settings reads (`setting_*`/`statistic_*`/`meta_*` reads), Config, Maintenance, ToolHistory, Usage reads, Backup commands | SettingsWrite, Agent, Search, UsageWrite |
| `popup-*` | None | Every group and backup commands |
| `preview*` | None | Every group and backup commands |
| `tray-menu` | None | Every group and backup commands |
| Any other label | None | Every group and backup commands |

`Config` is the settings-owned provider/model/MCP/built-in-tool configuration
surface, including writes. It is never available to popup, preview, or unknown
windows because those payloads can include provider credentials. `Maintenance`
is limited to the three count/delete-all pairs used by Data Management;
session CRUD remains in `Agent`. The real-window integration suite exercises
allowed Settings capabilities and the denial of every group from popup,
preview, unknown, and `tray-menu` labels.

### Settings transport boundary

`GeneralSettings` has two consumers beyond the owning main window, and neither
gets the full snapshot:

- `settings` may read the full snapshot (it renders provider, browser, and
  search configuration) and is the only window that may request a mutation.
- `tray-menu` may read only `language`, `animationSpeed`, and
  `automaticallyReduceMotion`. The owner projects every other field to its
  default before the reply leaves the window, so provider API keys, browser
  data paths, and update state never reach the tray.
- `popup-*`, `preview*`, and unknown labels are rejected on the wire; the owner
  also drops a request that a compromised transport forges with an allowed
  label check failure.

Settings writes stay inside the typed `setting_set` operation, which is
main-only. The settings window talks to the main owner through
`settings:command` and cannot write the database directly; the native
`database-forbidden` guard is the second line of defence.

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
| Settings, statistics, app metadata | `setting_*`, `statistic_*`, `meta_*`; reads are allowed from main and settings, writes are main-only |
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
| Multi-window permissions | Real-window Rust tests cover main/settings reads, main-only settings writes, settings Agent/usage-write denials, all-group popup denials, and preview settings/backup denials |
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
- Errors map to stable categories: validation, not found, conflict,
  `database-busy`/`database-locked` from SQLite primary result codes,
  unavailable, backup/import failure, and unknown. User-facing text remains in
  the existing localization layer.
- Raw sqlx, serialization, and native diagnostics stay in the Rust log. The
  stable code is the caller contract; validation, not-found, and conflict IPC
  messages are fixed public text. Field names, row IDs, table names, SQL, and
  driver/native diagnostics never cross the IPC boundary. `From<sqlx::Error>`
  never copies a driver message, and there is no `From<String>` blanket
  conversion that would let an arbitrary string become public validation text.
- Every TypeScript boundary that renders a failure converts it through a known
  error code or a fixed message key: agent task state, task projection, update
  gate, MCP connection actions, data management export/import, built-in tools,
  and settings. Raw `.message` remains only in logs, diagnostics, and provider
  classification of upstream response bodies.
- Built-in tools keep an explicit `ToolUserFacingError` marker for caller-safe
  validation and policy failures; unmarked native/database/transport errors are
  replaced with a stable generic message and logged.

## Open evidence

These are release gates, not claims:

- Re-run the full Rust suite, frontend tests, typecheck, architecture checks,
  E2E, and required GitHub Actions checks.
- Run the performance acceptance workflow on GitHub Actions. Daytona is not a
  dependency and must not be left running.
- The performance harness initializes one fixture per binary arm, records each
  arm's binary hash and migration ledger, and rejects a run whose fixture hash
  does not belong to that arm. Baseline and current fixtures must have the same
  business-data oracle; the SQLite files themselves need not be byte-identical
  because their migration ledgers differ.
- Confirm P50/P95 latency and memory are within the 5% budget; an unexplained
  regression stops the rollout.
