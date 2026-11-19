# RFC #710: cross-window data management E2E

Related to #710. These acceptance scenarios precede the regression spec. They
cover the existing Settings client, main-window workflow and native SQLite
runtime after the refactor; they introduce no product behavior or schema changes.

## Acceptance scenarios

1. **Given** independently seeded sessions, messages and a completed turn in the
   isolated app database, **when** the user opens Settings > Data & privacy,
   **then** all three visible statistics match the persisted counts.
2. **Given** saved history and unrelated provider/settings data, **when** the user
   cancels the clear-messages confirmation, **then** the history and visible
   statistics remain unchanged.
3. **Given** saved history and unrelated provider/settings data, **when** the user
   confirms clearing messages, **then** SQLite contains no messages or message
   parts, sessions and turns remain, turn message references become null,
   unrelated data survives and Settings displays the new counts.
4. **Given** the same independent fixture, **when** the user confirms clearing
   conversation records, **then** turns disappear while sessions, messages,
   message contents, provider configuration and settings remain intact, and
   Settings displays the persisted counts.
5. **Given** a chosen backup destination and existing history, **when** Settings
   requests an export, history is cleared through the UI and a conversation-only
   import is requested, **then** a real SQLite backup restores the history and
   message relationships, preserves a setting changed since export, writes the
   versioned import-success notice and displays the restored statistics.
6. **Given** the same backup/clear sequence and a setting changed since export,
   **when** Settings requests a full import, **then** the setting returns to its
   exported value, history and relationships are restored, the full-import
   notice is durable and Settings displays the restored statistics.
7. **Given** saved history and a corrupt backup file, **when** Settings requests an
   import, **then** it receives the bounded safe error, history and unrelated data
   remain intact, no import-success notice is fabricated and visible statistics
   remain correct. An explicit export and import of a valid backup then succeed.

## Boundaries and isolation

`test/specs/data-management.e2e.js` reuses `desktop.js` for opening and switching
between the real main and Settings windows. Statistics and clear actions use
actual DOM controls, including the production confirmation dialog. No Vue state,
workflow, owner, event reply, database command or rendered content is substituted.

The OS file picker is an explicitly excluded external boundary. Backup/import
tests dispatch the production `data-management:request` envelope **from the
Settings webview to main**, using the existing Tauri event internals. They await
only the matching `data-management:reply`; a missing owner fails the test without
retry or fallback. The actual bootstrap listener, workflow, native backup/import
and SQLite transactions run. Settings is remounted by ordinary section navigation
after import so its own client reloads statistics.

This boundary does not cover clicking Export, picker interaction/cancellation,
the import-mode chooser, progress/error toasts, automatic restart, or consumption
of the startup notice after restart. In particular, the full-import test checks
the restored preference in SQLite; existing in-memory preferences normally apply
after restart. It does not claim they refresh immediately. Rejected import is
verified through the safe channel error, persisted state, UI statistics and a
subsequent successful operation, not through a fabricated UI error.

`test/support/agent-fixture.js` exports `getAgentFixture()` with
`{ appRoot, databasePath, query(sql, ...bindings), execute(sql, ...bindings), ... }`.
`query` returns an array of row objects; `execute` commits fixture setup/cleanup.
The runner runs this spec in a separate session with current migrations/seed and
a fresh app root. No earlier Agent spec, model response or saved row is required.
Fixtures use the actual production tables/columns and a disabled private provider,
their own model, unique session/task identities and a private setting sentinel.
SQL is only fixture setup, cleanup and observation; clear/export/import are always
driven through the production UI or the documented Settings request boundary.
Backup files live in a per-test directory under the isolated app root. Cleanup
removes only that directory and the fixture's identified rows, and preserves the
previous import-success notice. `TOUCHAI_E2E_RUNTIME_ROOT` optionally places the
isolated app roots outside the checkout.

## Running and evidence

`wdio.conf.js` registers this spec as its own group in the normal `pnpm test:e2e`
run. With Node supporting `node:sqlite` (CI uses Node 22), the native driver,
display and matching binary prepared, a focused run from the worktree root is:

```sh
TOUCHAI_E2E_SKIP_BUILD=1 pnpm --filter @touchai/desktop exec wdio run e2e-tests/wdio.conf.js --spec e2e-tests/test/specs/data-management.e2e.js
```

Use the WDIO command directly: the current `pnpm test:e2e` wrapper does not forward
`--spec`. The skip flag requires an already built binary for this worktree. WDIO
then launches the actual application. No new production test hook is needed.

All seven scenarios passed against the Linux Debug application on 2026-11-19.
The combined run and remaining platform limits are recorded in
[E2E results](rfc710-e2e-results.md). This is functional acceptance; it does not
measure release performance or compare visual baselines.
