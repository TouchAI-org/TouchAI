# Architecture

Read this before any non-trivial change.

## Stack and layout

| Area | Path | Stack |
| --- | --- | --- |
| Desktop app | `apps/desktop/` | Vue 3 + TypeScript + Tailwind + Vite |
| Native shell | `apps/desktop/src-tauri/` | Rust + Tauri 2 |
| Database | `apps/desktop/src/database/`, `apps/desktop/src-tauri/src/core/database/` | SQLite owned by Rust `sqlx`; Drizzle schema is an offline development and audit input |
| Official site | `apps/site/` | Astro + Starlight |

```text
views / components
    -> composables / stores
        -> services (AgentService, PopupService, NativeService, ...)
            -> typed NativeService database operations
                -> Tauri commands (src-tauri/src/commands)
                    -> private Rust repositories and transactions
                        -> SQLite
```

- Do not skip layers. UI code reaches persisted data only through existing service,
  `NativeService`, and typed database operation contracts.
- Rust owns the SQLite pool, migrations, private repositories, complete business
  transactions, validation, stable error mapping, backup/import, and the only
  production SQLite write path.
- TypeScript may own view models and business orchestration, but it does not
  construct SQL or own a transaction span. It calls named
  `database_operation` variants; there is no generic SQL, batch, or transaction
  IPC fallback.
- `src/database/schema.ts`, Drizzle, and the committed migrations are the offline
  schema/audit input. Do not add a second schema definition in Rust. The runtime
  executes the byte-identical migration and SQL artifacts under
  `apps/desktop/src/database/`.

Code lives in `apps/desktop/src/{views,components,composables,stores}/` for UI, `services/` for services, `database/` for data, and `apps/desktop/src-tauri/src/{commands,core}/` for native.

## TypeScript and Rust are one contract

Any change to an invoke payload, return shape, nullability, error code, timeout, or cancellation semantic updates both sides and both test suites in the same change. A change verified on one side only is not verified.

## RFC-first areas

No implementation without an accepted RFC issue and explicit user direction: `AgentService` and the conversation runtime, tool execution, session persistence, context construction and instruction loading, agent orchestration, MCP integration, database schema and migrations.

## High-risk surfaces

Read the owning code first and expect cross-window or cross-process consequences.

| Surface | Path | Main risk |
| --- | --- | --- |
| Agent orchestration | `apps/desktop/src/services/AgentService/` | Message ordering, streaming, cancellation, tool loops, final vs intermediate state |
| Built-in tools | `apps/desktop/src/services/BuiltInToolService/` | Sandbox escape, unbounded output, approval bypass, resource leaks |
| Popups and events | `apps/desktop/src/services/PopupService/`, `EventService/` | Stale `popupId`/`sessionVersion`, duplicate listeners, ready/data/close races |
| Native bridge | `apps/desktop/src/services/NativeService/`, `apps/desktop/src-tauri/src/commands/` | TypeScript/Rust type drift, timeout and cancel semantics |
| Multi-window shell | `apps/desktop/src-tauri/src/core/window/` | Window lifecycle, resize feedback loops, focus restoration, tray state |
| Database runtime | `apps/desktop/src-tauri/src/core/database/`, `apps/desktop/src/database/` | Migration order, WAL/locking, transaction ownership, backup/import, offline schema drift |
| Attachments | `apps/desktop/src/services/AgentService/infrastructure/attachments/` | Draft state, cached copies, and database rows drifting apart; a failed read silently changing what the model sees |

Window labels, popup lifecycle, event ordering, and session identity are cross-window contracts. Duplicate listeners, stale IDs, and races are correctness bugs, not polish.

## Architecture enforcement

`pnpm architecture:check` runs four checks; CI runs the same command in the
`architecture` job, which is part of `CI Required`. The rules live next to the
checks in `apps/desktop/scripts/ci/architecture/` and are also wired into
`eslint.config.js`, so `pnpm lint:check` enforces the import rules as well.

| Check | Enforces |
| --- | --- |
| `check-boundaries.mjs` | The direct-import rules below |
| `check-cycles.mjs` | No new runtime import cycle (a parse failure fails the gate) |
| `check-ipc-commands.mjs` | Every `NativeService` `invoke` has a Rust handler or an exact plugin-command allow-list entry |
| `check-db-drift.mjs` | Committed migrations/artifacts match the reviewed baseline; `schema.ts` still matches the committed migrations |

Enforced direct-dependency rules. Paths resolve through `tsconfig.json`, so `@/`,
`@services/`, `@database/` and relative specifiers are the same edge; type-only,
value and dynamic imports are classified separately:

- **Service core must not import the Vue UI layer** (`views`, `components`,
  `composables`, `stores`) or `vue`/`pinia`/`vue-router`/`@vue/*` at runtime.
  Type-only imports are allowed.
- **`AgentService/contracts` must not import `AgentService/execution`** internals;
  executor checkpoints stay internal.
- **The database layer must not depend on business services**; the `NativeService`
  IPC bridge is the only allowed service dependency.
- **Production runtime code must not import `drizzle-orm` or
  `@database/schema`** outside `src/database/schema.ts`; type-only schema imports
  are allowed and erased from the runtime bundle.
- **A neutral domain module (`src/domain/`) must not import** Vue/Pinia/Tauri
  runtime packages, the UI layers, or services.
- **An internal module must not import its own public barrel** (`index`).

### Strength and scope — read before claiming a boundary is enforced

The gate checks **direct imports only**. It does not prove transitive purity:

- A support module (`utils`, `lib`, `types`, `config`, `i18n`, `router`,
  `prompts`) may still import Vue/Pinia or a store, and any module importing it
  inherits that reach. Services importing `@/i18n` are a **baseline**: this round
  does not make every service transitively free of the UI runtime.
  `SettingsService/domain` policy currently returns values and delegates
  translation to a service adapter; do not describe all services as UI-runtime-free.
- The support areas are **not** constrained yet. Treat that as a known gap, not as
  proof the whole architecture is clean.

Exceptions are per edge, never per directory: `baseline-exceptions.json` records
the edge, its import kind, a reason and an exit condition. It may only be widened
through code-owner review (`apps/desktop/scripts/ci/architecture/` is owned in
`.github/CODEOWNERS`); there is no automatic re-green. Edges an RFC #710 worker
owns are fixed, not baselined. The guard tests carry positive and negative
fixtures under `apps/desktop/tests/ci/architecture/` and prove an alias, a
relative path or a dynamic import cannot bypass a rule.

### The IPC gate is presence, not contract

The IPC check proves a `NativeService` `invoke` names a registered command; it
does not decode the payload. Real Tauri argument mapping, Serde and plugin
decoder behavior are verified by the Rust/IPC test suites, not here. The gate
never requires the wrapper set to equal `generate_handler!`, and never asserts
argument casing.

### Database drift is not a second source of truth

`schema.ts` is only the drizzle-kit input; the committed `drizzle/*.sql` +
`drizzle/meta/*` and the runtime/import SQL artifacts (`guards.sql`, `seed.sql`)
are the reviewed contract. The gate never writes into the worktree — the
generation check copies `schema.ts`, the committed migrations and a
`node_modules` symlink into an out-of-tree temp directory, runs
`drizzle-kit generate` there and fails if a new migration appears. Production
runtime code cannot import the offline schema or Drizzle; the boundary gate
fails a value import while allowing a type-only import. `guards.sql` is hashed
but still unversioned this round; that long-term risk is retained, not solved.

### When an RFC is still required

These checks do not replace the RFC-first rule in this document. New schema or
migration changes, new Tauri commands, and tool-protocol changes still need an
accepted RFC and explicit user direction. Ordinary import adjustments that keep
the same contracts do not need a per-change RFC.
