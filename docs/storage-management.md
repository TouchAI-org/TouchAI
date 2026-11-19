# Storage management

## Scope and authorization

The maintainer authorized the complete storage design without a separate issue or RFC, and approved one migration correcting historical turn ownership. This change reuses existing tables, indexes, attachment hashes and historical paths. It adds no separate accounting table. User content is deleted only by the explicit history controls or a confirmed storage cleanup action.

The maintainer also explicitly authorized deletion of every managed storage category, including conversations and other important data after a warning. The selection-dialog revision changes deletion behavior without adding or modifying a migration.

## Acceptance scenarios

- Given the storage overview, when the user chooses Clean up space, then one dialog lists every managed category with checkboxes; the overview has no per-category maintenance buttons.
- Given the cleanup dialog, when the user reviews any item before selecting it, then gray text beside its name explains its contents and any material deletion consequence; low-risk items have no extra warning.
- Given Data & privacy settings, when the user opens the page or searches settings, then the duplicate data statistics block and its search result are absent; the storage overview and history controls remain available.
- Given selected categories contain personal data, when the user reviews the selection, then the dialog describes the loss and still allows explicit deletion. Database deletion clears conversations, usage and local configuration, then requires a restart; it never deletes the live SQLite file or schema.
- Given referenced attachments or managed screenshots are explicitly selected for deletion, when cleanup completes, then their managed bytes and matching file references are removed without erasing unrelated conversation text or touching external originals. Subsequent backups remain valid.
- Given browser data or installed resources are selected, when cleanup starts, then the corresponding managed runtimes stop and their writers cannot race the deletion. Files outside the measured managed roots remain untouched.
- Given unused-file cleanup and overlapping categories are selected together, when the estimate is shown and cleanup runs, then each managed file is counted and processed once. Database free-space recovery runs inside the same maintenance operation.
- Given any selected operation partially fails, when the user sees the result, then committed deletion, remaining failures and restart requirements remain visible.
- Given a storage scan, when the user opens the overview, then a compact list shows each category and its occupied size. Inspecting a category shows its share and file count, including for zero-byte files.
- Given a user navigates by keyboard, when they open cleanup, then the dialog traps focus, exposes labeled checkboxes and allows cancellation before deletion starts.
- Given a category supports maintenance, when the user selects its name in the overview, then the ring shows its usage. Deletion choices and the combined estimate appear in the cleanup dialog.
- Given a backup containing settings and conversation data, when the user selects either or both during export or restore, then the selected settings, conversations, usage and managed attachments travel with their respective scope. Restoring just settings preserves local history and its files; restoring just data preserves local configuration.
- Given two conversations share an attachment, when one conversation is removed, then the other conversation's attachment and original image remain readable.
- Given a user changes an external source file after sending it, when the conversation is reopened, then the saved attachment still contains the bytes captured at send time.
- Given identical immutable app-owned bytes exist under two necessary paths, when storage is optimized, then the paths share a physical file where supported; unsupported filesystems still provide independent readable copies.
- Given a draft, agent task, import or backup is active, when cleanup is requested, then cleanup cannot remove its files or interleave with its database writes.
- Given unused app-generated clipboard files, thumbnails and temporary artifacts, when safe cleanup is confirmed, then those files are removed without deleting user originals, active browser profiles, saved recordings or current drivers.
- Given a path is a symbolic link, junction or other reparse point, when storage is scanned or cleaned, then it is not followed outside the managed root.
- Given several paths are hard links to one file, when usage is displayed, then the physical file is counted once and removing only one name is not reported as releasing its contents.
- Given file deletion fails, when cleanup completes, then successfully deleted items and failed items are reported separately and another cleanup can reclaim leftovers.
- Given the user explicitly deletes history, when deletion commits, then content snapshots and unreferenced attachments do not survive unintentionally, while durable usage totals are preserved.
- Given the database has free pages, when the user requests database compaction, then valid content is unchanged; active transactions or insufficient free disk space are refused without modifying user data.
- Given a full backup is exported and restored into a different application root, when history is opened, then database content, managed attachments and retained app-owned originals are restored without requiring the source installation. Each content object is archived once; a backup is never a hard link to live data.
- Given a legacy `.db` backup, when the user imports it, then the existing import behavior remains supported.
- Given an older browser screenshot is referenced by history or input recovery, when another screenshot is captured or the browser stops, then the original remains readable; only reference-aware storage maintenance can reclaim it.
- Given a screenshot directory is replaced by a symlink or junction, when capture or cleanup is attempted, then no external file is written, modified or deleted.
- Given an unsent draft is temporarily replaced while browsing input history, when cleanup is requested, then its recoverable attachments stay protected until the draft is discarded or the owning view closes.
- Given non-zero turn and attempt usage in a backup, when the restore includes Data, then token, cost, latency and daily aggregates are preserved and repeated imports count each live turn once.
- Given the clipboard changes before maintenance starts, when cleanup obtains exclusive access, then protection is read from that current snapshot rather than a pre-lock snapshot.
- Given a platform data directory has redirected ancestors but no redirects inside the managed cache, when publishing, scanning, compacting or backing up, then existing logical paths keep working without relaxing the managed subtree boundary.
- Given committed database changes remain in WAL or database files are compressed, when compaction completes, then before/after usage includes physical allocation for the database and sidecars, not just the main file's logical length.
- Given a completed or running turn uses a model, when that model or its provider is deleted, then the turn, attempts, content snapshots and usage survive with a null model reference.
- Given model/provider configuration is renamed after a turn started, when history or usage is read, then the original name snapshots remain available; new turns capture the new names.
- Given a database using the previous schema contains attempts, when the approved migration rebuilds the turns table, then attempts, row IDs, content, counters and foreign-key integrity remain unchanged.
- Given a model-deleted turn is exported or restored, when either backup format/import mode is used, then detached turns retain their names and usage without a missing-model join dropping them.

## Ownership and invariants

Rust owns filesystem publication, physical identity accounting, cleanup and the maintenance exclusion gate. Frontend services coordinate draft/task activity through NativeService. Database runtime operations share a read/exclusive maintenance gate so cleanup, import and compaction cannot race a transaction. Files are prepared before SQLite write transactions.

Hard links are not snapshots and are never used to adopt external user files. Published attachment content is immutable: no truncate-and-write of an existing hash path. A hard link is permitted only between managed, verified, byte-identical files within one trust domain; paths exposed as editable outputs need independent copies. Original and normalized images remain distinct when their bytes differ. Business references, not link counts, determine whether content may be removed.

The default unused-file cleanup processes recognized files under managed roots, protects attachment rows and referenced app-owned originals, and recovers reusable database space. Explicit category selection removes all files in that category, including referenced and recent files, after displaying the consequences. Both paths reject reparse points and unknown filesystem identities, scan before mutation, and run under the storage and database maintenance gates. Native removal still validates every file's physical identity.

Explicit file deletion prunes attachment associations and matching metadata paths in messages, prompt snapshots and recovery attempts while retaining conversation text. Removing an app-owned original alone updates its attachment row to the saved cached copy. JSON processing uses bounded pages and depth/node budgets. Database deletion runs a transaction that clears user rows without altering the schema or migration history, compacts the remaining database, then closes the shared pool to prevent stale windows from rewriting deleted data before restart. Font and driver deletion also requires restart. Filesystem or compaction failures after committed metadata changes remain visible in the result.

Managed originals restored under `cache/originals` count toward Attachments and can be deleted with that category. When Database and Unused files are selected together, the unused-file plan uses references from before the reset; previously referenced attachments are not silently added to the selection. Partial deletion requiring restart stays on screen with a Restart action so the failure details remain reviewable.

Full backups use an independent compressed archive, a versioned manifest and SHA-256 verification. Import validates paths, entry types, sizes and hashes before publication. Restored files are independent copies, not hard links to archive blobs or to another restored path. Old database imports remain available. Cache format or backup manifest changes do not change database structure.

The ring shows total physical usage. Its legend lists every category once, largest first, with its occupied bytes. Hovering or selecting an occupied category shows its size, share and file count in the ring; the category tooltip also exposes the count and share. Empty categories stay in the list, including files that occupy zero bytes.

The button under the ring reads Clean up space. A shadcn/vue-style Dialog with Reka UI Checkbox primitives contains the unused-file option, every measured category and select-all. Each name is followed by a gray description of its contents and any material deletion consequence, visible before selection and associated with the checkbox for assistive technology. Low-risk items have no extra warning, and there is no separate warning block at the bottom. Database and installed-resource selections change the final action to Delete and restart. Refresh remains an icon; the category rows have no maintenance icons. Typography inherits the Settings window's Source Han Serif font. Data & privacy no longer repeats the session, message and turn counts already covered by Usage.

![Storage overview with a 2 GiB sample dataset](images/storage-overview-zh.png)

![Cleanup selection with gray descriptions beside each item](images/storage-cleanup-zh.png)

Component references: [shadcn/vue Dialog](https://www.shadcn-vue.com/docs/components/dialog) and [Checkbox](https://www.shadcn-vue.com/docs/components/checkbox). Both patterns reuse the installed Reka UI dependency.

Export and restore each offer two selections, Settings and Data. Settings includes preferences and provider, model and tool configuration, including credentials. Data includes conversations, usage, search history and managed attachments. A partial ZIP carries its content scope in a version 2 manifest and contains a newly projected database with just the selected content. The file picker reads the manifest before displaying restore choices. A full ZIP keeps the version 1 format, and legacy database-only `.db` backups remain available for both scopes together on export and selective restore on import.

## Historical reference correction

Deleting a model or provider must not delete completed or running turn history. The approved migration makes `session_turns.model_id` nullable with `ON DELETE SET NULL` and adds `model_name` / `provider_name` snapshots. It reuses the existing turns table and does not add persistent per-call accounting records or change the explicit turn-clear policy.

New turns resolve the model association and names in the same insert. Existing rows are backfilled from configuration that still exists when the migration runs. A past rename cannot be reconstructed where no original name was stored, and rows already deleted by the previous cascade cannot be recreated.

SQLite rebuilds the turns table for this constraint change. Foreign-key pragma handling runs outside the native migration transaction; otherwise the generated `PRAGMA foreign_keys=OFF` is ignored and dropping the old table can cascade into attempts. The migration preserves the AUTOINCREMENT watermark and validates foreign keys before commit. Downgrading to a writer using the previous schema is not supported; take an independent backup before upgrading.

Usage and context queries use outer joins so removed configuration cannot hide retained rows. Removed model ranking rows remain readable but cannot be selected as a current configuration filter.

Imports match existing turns by their stable task identity, which survives message/session clearing, then restore the saved session and prompt links. Prompt snapshot attachment rowids are remapped by attachment hash. The all-time trend adds frozen baseline days to live detail and uses rollup rows only for legacy days that have neither; this avoids hiding a baseline when the same day receives new requests.

## Limits

- Archives bound each blob to 4 GiB, expanded/restored content to 16 GiB, managed paths to 50,000, and manifest/usage metadata to 16 MiB. Incomplete or oversized input fails explicitly.
- A same-day import overlapping archived daily totals, or an ambiguous legacy live day, is refused rather than guessing whether usage overlaps. Deleted turn identities cannot be reconstructed.
- Old browser artifacts outside the configured cache are not swept by filename because cross-install ownership cannot be proven.
- Unmanaged external originals are never overwritten; legacy `.db` imports remain supported.
- No automatic full VACUUM runs on startup.

## Verification and budgets

Behavior tests use synthetic databases and private fixtures, never the live application database or clipboard. The implementation is checked locally with TypeScript production/test type checks, ESLint, source formatting, and targeted database/storage/settings tests. Full `pnpm test:pr`, Rust coverage, desktop E2E, a realistic large-database migration rehearsal and installed-release measurements remain CI/release evidence; they are not claimed as locally run.

Before release, run `pnpm test:pr` and `pnpm test:e2e`, including Windows NTFS hard links, cross-volume/non-link fallback, open-handle deletion, reparse-point escape, interrupted publication, shared-attachment deletion, full backup restore and legacy `.db` restore. Check settings at minimum/default widths and both locales.

Measure the affected installed-release flows against baseline `c9036541` on the same device, DPI and WebView version: at most 5% P50/P95 latency and steady-state memory regression. Hashing, copying, directory scans and archive work stay off the UI thread; scans have bounded file counts and return explicit incomplete/error diagnostics.
