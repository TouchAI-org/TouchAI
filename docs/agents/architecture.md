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
        -> services (AgentService, EventService, NativeService, ...)
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
| Search overlays and events | `apps/desktop/src/views/SearchView/components/SearchOverlayHost/`, `services/EventService/` | Stale async results, duplicate listeners, focus restoration, open/close races |
| Native bridge | `apps/desktop/src/services/NativeService/`, `apps/desktop/src-tauri/src/commands/` | TypeScript/Rust type drift, timeout and cancel semantics |
| Multi-window shell | `apps/desktop/src-tauri/src/core/window/` | Window lifecycle, resize feedback loops, focus restoration, tray state |
| Database runtime | `apps/desktop/src-tauri/src/core/database/`, `apps/desktop/src/database/` | Migration order, WAL/locking, transaction ownership, backup/import |
| Attachments | `apps/desktop/src/services/AgentService/infrastructure/attachments/` | Draft state, cached copies, and database rows drifting apart; a failed read silently changing what the model sees |

Window labels, event ordering, and session identity are cross-window contracts. Search overlays share the main Vue tree and its state; they have no standalone popup window or event transport. Duplicate listeners, stale IDs, and races are correctness bugs, not polish.

## Search window geometry

`useSearchWindowResize` owns the logical panel height. It measures natural conversation content and direct control rows; the rendered viewport and animated card height are outputs, never measurement inputs. Manual sizing, maximization, overlay reservation, and work-area bounds resolve the effective target before a transition starts.

`SearchOverlayHost` owns anchored placement and scrollable overlay bounds inside the same WebView. Rust's `search_host` accepts bounded host geometry, and `search_region` applies the union of visible panel and overlay regions on Windows. The renderer reconciles the accepted native snapshot instead of assuming a requested size was applied. Native updates occur at transition boundaries, not on every animation frame.

Dragging owns position, not size. A position-only move may leave the card partly outside the screen and must preserve its dimensions and client-space placement after release. Card capacity comes from the host viewport and monitor dimensions, independently of the host's screen position. Only overlays use the intersection with the visible work area. Explicit reset, maximize/restore, and changes to monitor capacity retain their separate bounds policies.

`apps/desktop/tests/layout/README.md` describes the browser layout regression and its native-boundary mocks. Physical monitor/DPI changes, cross-application click-through, and release latency/memory budgets still require native acceptance.

## Subsystems

Owner pages for areas with their own invariants and contracts:

| Area | Page | Read it when |
| --- | --- | --- |
| Product analytics | [analytics.md](analytics.md) | Touching the event registry, consent, the delivery queue, the sender, or export/import scrubbing |
