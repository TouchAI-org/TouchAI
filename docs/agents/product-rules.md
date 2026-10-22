# Product rules

Read this when changing UI, data, or performance.

## Database

Default: **do not change the database structure**. Reuse existing tables, columns, indexes, settings, and message parts; derive values at read time when the cost is bounded.

**Any change to the database data structure requires the user's explicit approval before implementation.** That covers creating, dropping, or renaming tables or columns; changing types, defaults, nullability, or constraints; adding, dropping, or changing indexes, unique constraints, triggers, or views; adding or editing migrations; changing a persisted JSON/blob shape read as a schema; and changing retention, deletion, or backfill behavior for stored user data. An accepted RFC does not replace user approval.

If avoiding the change would leave real technical debt, present the tradeoff and ask first. The proposal states:

1. The problem and evidence that a schema change is needed.
2. The minimal change, plus the no-change alternative with its ongoing cost and risk.
3. Migration steps with the exact `pnpm db:generate` output and a rollback or restore path.
4. Data volume, expected duration, lock/WAL impact, and behavior on interruption.
5. Query and storage impact, with `EXPLAIN QUERY PLAN` for changed queries.
6. Compatibility with older and newer app versions, and how existing data is preserved.

If approved: add a new migration and never edit a released one; prefer additive, backward-compatible changes; keep migrations deterministic and repeatable; test upgrade and restore on a copy of a realistic database including the previous schema; never add runtime "auto-fix schema" logic outside the migration path; record the approval in the PR. If not approved, file a technical-debt issue with the evidence and continue inside the existing model.

## UI

> Avoid unnecessary secondary labels and descriptions. Let the layout do the explaining.

- Let hierarchy, spacing, alignment, grouping, and typography carry meaning. No helper line or subtitle that restates a control label.
- No description under every settings row, secondary label on every card, or tooltip repeating visible text. If a control is unclear, fix its placement, wording, or grouping first.
- Reuse components, design tokens, and interaction patterns under `apps/desktop/src/components/` and `apps/desktop/src/views/`. No parallel design system or ad-hoc styling.
- Keyboard-first: every action is reachable without a mouse, with visible focus and predictable order.
- Respect the window minimum and default width from `tauri.conf.json`; check long translations, empty states, and error states at both.
- Every user-visible string goes through `apps/desktop/src/i18n/` with both `zh-CN` and `en-US` entries. Never hardcode user-facing text.
- UI changes need before/after screenshots or a recording at minimum and default width.

## Performance

Any change touching startup, search, streaming, Markdown rendering, IPC, database access, window/panel lifecycle, or memory lifetime states a performance budget in the issue or PR and measures it on a release build with fixed device, DPI, and WebView version.

Unless the issue approves a different tradeoff:

- At most 5% P50 or P95 regression for the affected user-visible flow against the baseline on the same machine and build profile.
- At most 5% increase in steady-state memory or retained DOM.
- No unbounded queue, cache, listener, timer, observer, or retained history; every cache has a size cap and an eviction/cleanup path.
- No blocking UI-thread work for unbounded input; long work is chunked, scheduled, or moved off the interaction path.
- Every new hot-path database query has an index plan and an `EXPLAIN QUERY PLAN` result in the PR.

Report cold and warm P50/P95 for new flows, before/after numbers on the same environment plus the baseline commit for existing flows, and long tasks, DOM/renderer count, and memory for rendering changes. If a number cannot be measured locally, say so and name the evidence that decides it before release. Keep behavior tests separate from performance tests, and never replace native end-to-end measurement with a synthetic micro-benchmark.
