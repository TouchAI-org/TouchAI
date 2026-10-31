# Architecture

Read this before any non-trivial change.

## Stack and layout

| Area | Path | Stack |
| --- | --- | --- |
| Desktop app | `apps/desktop/` | Vue 3 + TypeScript + Tailwind + Vite |
| Native shell | `apps/desktop/src-tauri/` | Rust + Tauri 2 |
| Database | `apps/desktop/src/database/` | SQLite, Drizzle ORM over a Rust `sqlx` IPC runtime |
| Official site | `apps/site/` | Astro + Starlight |

```text
views / components
    -> composables / stores
        -> services (AgentService, PopupService, NativeService, ...)
            -> Tauri invoke commands (src-tauri/src/commands)
                -> Rust core (src-tauri/src/core)
                    -> SQLite
```

- Do not skip layers. UI code reaches SQL and Rust only through existing service and `NativeService` contracts.
- The Rust runtime owns the SQLite pool, migrations, transactions, backup/import, and query execution. The frontend owns business orchestration through Drizzle. Do not add a second schema definition on the Rust side.

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
| Database runtime | `apps/desktop/src-tauri/src/core/database/`, `apps/desktop/src/database/` | Migration order, WAL/locking, transaction ownership, backup/import |
| Attachments | `apps/desktop/src/services/AgentService/infrastructure/attachments/` | Draft state, cached copies, and database rows drifting apart; a failed read silently changing what the model sees |

Window labels, popup lifecycle, event ordering, and session identity are cross-window contracts. Duplicate listeners, stale IDs, and races are correctness bugs, not polish.

## Subsystems

Owner pages for areas with their own invariants and contracts:

| Area | Page | Read it when |
| --- | --- | --- |
| Product analytics | [analytics.md](analytics.md) | Touching the event registry, consent, the outbox, the sender, or export/import scrubbing |
