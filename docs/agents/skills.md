# Skill enablement storage

Issue #34. The user approved moving skill enablement into the existing database on
2026-11-09. This changes the persisted configuration contract, not the table schema.

## Contract

- Skill content remains in `SKILL.md`. Toggling does not modify or delete it.
- The current app database owns `settings.key = skills_disabled_paths_v1`.
  Its value is a JSON array of canonical absolute `SKILL.md` paths. An empty array
  means every discovered user skill is enabled.
- App and shared skills use the same record. Paths distinguish equal names in
  different roots. Built-in skills remain read-only and cannot be disabled.
- The native skills commands use the existing `DatabaseRuntime` pool. Discovery
  and enabled-content reads consult the same record; settings can still inspect
  disabled content. The frontend IPC payloads and result shapes are unchanged.
- No cache or second writable store exists. Concurrent updates use SQLite
  `BEGIN IMMEDIATE` transactions, including updates from separate connections.

## Legacy import and recovery

If the record is absent, the first user-skill operation reads both old lists:
`<appRoot>/skills/.disabled-skills.txt` and
`~/.agents/.touchai/disabled-skills.txt`. It validates paths with the existing
containment rules, merges and deduplicates them, then inserts one record.
`ON CONFLICT DO NOTHING` prevents a concurrent import from overwriting a newer
choice. Row presence, including `[]`, marks a completed import.

The old files remain untouched as migration backups. After the database record
exists they are neither read nor written. Import failure leaves no partial record;
database read/parse failures are reported rather than treating every skill as
enabled. Each legacy file is capped at 1 MiB; serialized database state is capped
at 8 MiB to accommodate both lists and JSON escaping.

Database backups include this setting. An older application version still uses the
old files and will not see later database changes. To roll back, stop the newer
version and use its database backup or the preserved legacy lists deliberately;
there is no automatic dual-write reconciliation. Absolute paths are machine/root
specific, as in the previous text format.

Deletion validates and stages its state update before removing the directory. A
filesystem failure rolls the database transaction back. Filesystem removal and
SQLite commit cannot form one atomic transaction: if commit fails after removal,
the operation reports an error and may leave a harmless stale disabled path.

## Validation and cost

Acceptance covers one-time import, restart and backup preservation, concurrent
updates, failed writes, invalid state, disabled reads, scope identity, and built-in
protection. Native tests use real SQLite databases and temporary skill roots.

The lookup uses the existing unique index on `settings.key`; no DDL, index, seed,
or Drizzle migration is added. Normal discovery/activation reads one bounded
record. Filesystem work stays on the blocking pool. Switch updates hold a short
write transaction; deletion holds it while the directory is removed. Release
performance acceptance retains the project's 5% P50/P95 and memory budget.

## Reference and execution snapshots

Skill references add optional `{name, path}` identities to `InputHistorySnapshot.skills`
and a `skillTag` editor node. Prompt snapshots retain the selected identities, content
hashes and activation source; these are persisted JSON contract additions, separate
from the enablement setting and from any DDL. Older snapshots without these fields
remain valid. Restoring a reference revalidates its path against the current enabled
catalog before loading its instructions. An older app version cannot render the new
editor node, so a database backup remains the rollback source for full editor fidelity.

Full skill instructions exist only in a logical request's private state. The widget
`is_read_widget_skill` argument is a public model reminder, not a credential. Events,
checkpoints, tool records and summaries use the public projection. Compaction budgets
the live transport projection but summarizes only public content; retained messages
keep their private values by identity, and removed messages release those values. A
retry synchronizes the same compacted public/private boundary. Tool-source verification
compares the public input and persisted output, matching the records actually stored
in SQLite.
