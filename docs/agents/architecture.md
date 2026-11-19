# Architecture

Read this before any non-trivial change.

## Stack and layout

| Area          | Path                         | Stack                                              |
| ------------- | ---------------------------- | -------------------------------------------------- |
| Desktop app   | `apps/desktop/`              | Vue 3 + TypeScript + Tailwind + Vite               |
| Native shell  | `apps/desktop/src-tauri/`    | Rust + Tauri 2                                     |
| Database      | `apps/desktop/src/database/` | SQLite, Drizzle ORM over a Rust `sqlx` IPC runtime |
| Official site | `apps/site/`                 | Astro + Starlight                                  |
| Agent execution | `packages/agent-core/` | Neutral TypeScript task/turn/attempt engine |
| Model protocols | `packages/models/` | Neutral contracts and installed Provider drivers |

```text
views / components
    -> composables / stores
        -> app/api (per-window commands, queries and events)
            -> injected module capabilities and app/workflows
                -> module I/O -> database / platform
                    -> Tauri commands -> Rust core -> SQLite / OS

main -> app/bootstrap -> app/composition
    -> agent-core + models + Desktop modules / adapters
```

- UI, stores and composables use narrow `app/api` capabilities. They never import module internals, SQL, platform/native, bootstrap or composition. Ordinary clients cannot read connection secrets or construct execution hosts.
- `app/api` cannot bypass those boundaries by importing SQL, native SDKs, provider drivers or workflow implementations. Workflow contracts are traversed to prove they remain passive. Existing platform bridges are restricted to the exact source, target and named bindings in `API_PLATFORM_BINDINGS`; the rest of each platform entry stays unavailable to the API. APIs, workflows and adapters cannot depend on UI state or owner construction.
- `app/composition` constructs instance lifetimes and binds consumer-owned interfaces; `app/workflows` coordinates public capabilities. Business modules never import sibling modules, including types. Module I/O uses designated database/platform capabilities; pure domain code does not perform I/O.
- Main is the only execution/settings host. `agent-core` owns the sole task/turn/attempt loop; Desktop Agent owns sessions, committed history and safe UI projections. Secondary windows remain bounded clients and never create fallback owners.
- Exactly two root business packages exist: `@touchai/agent-core` and `@touchai/models`. Core imports only neutral Models contracts. Models owns Provider protocols and installed SDKs; neither package imports Desktop. Neutral contracts/catalog must not load Provider drivers.
- Builtins and MCP share one Tools registry and controlled execution pipeline. Frozen declarations and execution bindings match per turn, and revocation is checked before effects. Registration alone never grants authorization.
- Raw Tauri `invoke` belongs only to `platform/native/invoke.ts`. The gate also rejects acquiring it through the root Tauri `core` namespace, reexports or dynamic imports elsewhere.
- The Rust runtime owns the SQLite pool, migrations, transactions, backup/import, and query execution. The frontend owns business orchestration through Drizzle. Do not add a second schema definition on the Rust side.

Desktop business owners live in `src/modules/{agent,models,tools,skills,attachments,settings,search,usage,scheduler,updates,analytics}`. Tools owns `contracts`, `registry`, `execution`, `builtin` and `mcp`. Cross-module backup/restore/clear belongs to `app/workflows/data-management`; model metadata belongs to Models. Platform owns native, windows, HTTP, files and diagnostics. Existing UI, database, stores and native command/core directories retain their roles.

Public package entries are `@touchai/agent-core` and `/contracts`, and `@touchai/models`, `/contracts`, `/catalog` and reviewed `/providers/*` entries. Repository gates live in `tooling/architecture` and `tests/ci/architecture`; `pnpm check:architecture` checks direct/transitive/type boundaries, public entries, runtime cycles and graph completeness. A passing TypeScript graph is not native IPC or E2E proof. See [the #710 implementation record](710-implementation.md) for the approved matrix and current acceptance evidence.

## TypeScript and Rust are one contract

Any change to an invoke payload, return shape, nullability, error code, timeout, or cancellation semantic updates both sides and both test suites in the same change. A change verified on one side only is not verified.

## RFC-first areas

No implementation without an accepted RFC issue and explicit user direction: agent-core and Desktop Agent lifetimes, tool execution, session persistence, context construction and instruction loading, agent orchestration, MCP integration, database schema and migrations.

## High-risk surfaces

Read the owning code first and expect cross-window or cross-process consequences.

| Surface                    | Path                                                                                        | Main risk                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Agent orchestration        | `packages/agent-core/`, `apps/desktop/src/modules/agent/`, `src/app/workflows/agent/` | Message ordering, streaming, cancellation, tool loops, durable barriers and final vs intermediate state |
| Built-in tools             | `apps/desktop/src/modules/tools/` | Sandbox escape, unbounded output, approval bypass, resource leaks |
| Search overlays and events | `apps/desktop/src/views/SearchView/components/SearchOverlayHost/`, `src/platform/windows/events.ts` | Stale async results, duplicate listeners, focus restoration, open/close races |
| Native bridge              | `apps/desktop/src/platform/native/`, `apps/desktop/src-tauri/src/commands/` | TypeScript/Rust type drift, timeout and cancel semantics |
| Multi-window shell         | `apps/desktop/src-tauri/src/core/window/`                                                   | Window lifecycle, resize feedback loops, focus restoration, tray state                                            |
| Database runtime           | `apps/desktop/src-tauri/src/core/database/`, `apps/desktop/src/database/`                   | Migration order, WAL/locking, transaction ownership, backup/import                                                |
| Attachments                | `apps/desktop/src/modules/attachments/`, `src/adapters/models/` | Draft state, cached copies, and database rows drifting apart; a failed read silently changing what the model sees |

Window labels, event ordering, and session identity are cross-window contracts. Search overlays share the main Vue tree and its state; they have no standalone popup window or event transport. Duplicate listeners, stale IDs, and races are correctness bugs, not polish.

`useSearchWindowResize` owns card geometry from natural content and accepted native bounds; `SearchOverlayHost` owns overlay placement. Rust's `search_host` and `search_region` own the native viewport and Windows clipping region. Dragging changes position only and may leave the card off-screen; overlays stay within the visible work area. Native geometry updates occur at transition boundaries, not on every animation frame.

## Subsystems

Owner pages for areas with their own invariants and contracts:

| Area               | Page                         | Read it when                                                                                     |
| ------------------ | ---------------------------- | ------------------------------------------------------------------------------------------------ |
| Product analytics  | [analytics.md](analytics.md) | Touching the event registry, consent, the delivery queue, the sender, or export/import scrubbing |
