# Architecture

Read this before any non-trivial change.

## Stack and layout

| Area          | Path                         | Stack                                              |
| ------------- | ---------------------------- | -------------------------------------------------- |
| Desktop app   | `apps/desktop/`              | Vue 3 + TypeScript + Tailwind + Vite               |
| Native shell  | `apps/desktop/src-tauri/`    | Rust + Tauri 2                                     |
| Database      | `apps/desktop/src/database/` | SQLite, Drizzle ORM over a Rust `sqlx` IPC runtime |
| Official site | `apps/site/`                 | Astro + Starlight                                  |
| Agent execution | `packages/agent-core/` | Platform-neutral TypeScript execution loop |
| Model protocols | `packages/models/` | Provider contracts, drivers and streaming |

```text
views / components
    -> composables / stores
        -> app/api
            -> app/workflows -> modules
                -> database / platform
                    -> Tauri commands -> Rust core -> SQLite / OS
```

- UI, composables and stores use injected `app/api` capabilities; they cannot import modules, SQL, platform or composition directly.
- `app/composition` assembles owners; `app/workflows` coordinates them. Modules never import sibling modules, including types. Pure domain code performs no I/O.
- Main owns the sole Agent Core and settings host. Secondary windows are clients. Core uses Models contracts; neither package imports Desktop.
- Native calls go through `platform/native/invoke.ts`. Run `pnpm check:architecture` to check dependency boundaries, public entries and runtime cycles.
- The Rust runtime owns the SQLite pool, migrations, transactions, backup/import, and query execution. The frontend owns business orchestration through Drizzle. Do not add a second schema definition on the Rust side.

Code lives in `apps/desktop/src/{views,components,composables,stores}/` for UI, `app/` for composition and workflows, `modules/` for business owners, `platform/` for native I/O, `database/` for data, and `apps/desktop/src-tauri/src/{commands,core}/` for native.

## TypeScript and Rust are one contract

Any change to an invoke payload, return shape, nullability, error code, timeout, or cancellation semantic updates both sides and both test suites in the same change. A change verified on one side only is not verified.

## RFC-first areas

No implementation without an accepted RFC issue and explicit user direction: Agent Core and Desktop Agent, tool execution, session persistence, context construction and instruction loading, agent orchestration, MCP integration, database schema and migrations.

## High-risk surfaces

Read the owning code first and expect cross-window or cross-process consequences.

| Surface                    | Path                                                                                        | Main risk                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Agent orchestration        | `packages/agent-core/`, `apps/desktop/src/modules/agent/`                                                   | Message ordering, streaming, cancellation, tool loops, final vs intermediate state                                |
| Built-in tools             | `apps/desktop/src/modules/tools/builtin/`                                             | Sandbox escape, unbounded output, approval bypass, resource leaks                                                 |
| Search overlays and events | `apps/desktop/src/views/SearchView/components/SearchOverlayHost/`, `src/platform/windows/events.ts` | Stale async results, duplicate listeners, focus restoration, open/close races                                     |
| Native bridge              | `apps/desktop/src/platform/native/`, `apps/desktop/src-tauri/src/commands/`          | TypeScript/Rust type drift, timeout and cancel semantics                                                          |
| Multi-window shell         | `apps/desktop/src-tauri/src/core/window/`                                                   | Window lifecycle, resize feedback loops, focus restoration, tray state                                            |
| Database runtime           | `apps/desktop/src-tauri/src/core/database/`, `apps/desktop/src/database/`                   | Migration order, WAL/locking, transaction ownership, backup/import                                                |
| Attachments                | `apps/desktop/src/modules/attachments/`                        | Draft state, cached copies, and database rows drifting apart; a failed read silently changing what the model sees |

Window labels, event ordering, and session identity are cross-window contracts. Search overlays share the main Vue tree and its state; they have no standalone popup window or event transport. Duplicate listeners, stale IDs, and races are correctness bugs, not polish.

`useSearchWindowResize` owns card geometry from natural content and accepted native bounds; `SearchOverlayHost` owns overlay placement. Rust's `search_host` and `search_region` own the native viewport and Windows clipping region. Dragging changes position only and may leave the card off-screen; overlays stay within the visible work area. Native geometry updates occur at transition boundaries, not on every animation frame.

## Subsystems

Owner pages for areas with their own invariants and contracts:

| Area               | Page                         | Read it when                                                                                     |
| ------------------ | ---------------------------- | ------------------------------------------------------------------------------------------------ |
| Product analytics  | [analytics.md](analytics.md) | Touching the event registry, consent, the delivery queue, the sender, or export/import scrubbing |
