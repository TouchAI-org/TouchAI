# Implicit state-machine audit

## Scope and selection

The audit starts at `2467ac12`. It covers desktop TypeScript/Vue, native Rust,
site source and first-party public demos. Generated files, vendored libraries and
test infrastructure are excluded. Static discovery is not a proof of all runtime
interleavings.

A candidate has transitions whose validity depends on combinations of flags,
optional resources, pending promises or request generations. An enum alone does
not enforce transitions. Independent settings, caches and concurrent operations
must not be collapsed into a single mutually exclusive state.

Public interfaces, persisted data, IPC contracts, CSS and animation durations stay
unchanged. The user explicitly waived the issue prerequisite for this task;
database and RFC-first restrictions remain in effect.

The selected owners have local, mutually exclusive phases and reproduced
lifecycle defects that can be tested through existing public interfaces.
Cross-window protocols, execution/persistence/consent ownership, lexical
grammars and already explicit reducers are not flattened into the same model.

## Inventory

Paths are relative to `apps/desktop/src/` unless prefixed otherwise.

| Owner | Implicit lifecycle or protocol | Decision |
| --- | --- | --- |
| `composables/useContextMenu.ts`, `components/ContextMenu.vue` | Open, closing, disposed; selection, keyboard and animation ownership | Refactored here |
| `composables/useConfirm.ts`, `components/ConfirmDialog.vue` | Pending answer, settled promise, disposal and controlled reopen | Refactored here |
| `views/SettingsView/composables/useShortcutCapture.ts` | Pending native registration, active listener, disposed owner | Refactored here |
| `stores/settings.ts`, `stores/mcp.ts` | Initialization, load promise, subscription and disposal | Separate store lifecycle review; MCP is RFC-first |
| `views/SearchView/index.vue` | Quick-search reveal/fold/handoff; overlay intent and focus | Separate search E2E and geometry-sensitive change |
| `views/SearchView/components/SearchOverlayHost/index.vue` | Mount, position, reveal and animation cleanup | Separate geometry-sensitive change |
| `views/SearchView/searchSurfacePreparation.ts`, `views/SearchView/searchWindowRegions.ts` | Preparation/commit, cancellation, generations and stale acknowledgements | Preserve native handshake and generation guards |
| `views/SearchView/composables/useSearchPage.ts` | Visibility, blur reconciliation, auto-hide, pinning and listeners | Separate cross-window change |
| `views/SearchView/composables/useSearchWindowResize.ts`, `views/SearchView/composables/useSearchPanelResizing.ts`, `views/SearchView/composables/useSearchPanelDragging.ts` | Measurement, desired/accepted geometry, commit/cancel and rollback | Independent geometry axes; requires native measurements |
| `views/SearchView/components/QuickSearchPanel/composables/useQuickSearchLogic.ts`, `views/SearchView/components/QuickSearchPanel/composables/useAssetLoader.ts` | Debounced queries, pagination, in-flight generations and asset queues | Preserve concurrency and bounded caches |
| `views/SearchView/composables/useSearchRequest.ts` | Pending submission, completion, history searches and subscriptions | Conversation changes are RFC-first |
| `components/ui/message-scroller/MessageScroller.vue` | Follow output, manual/programmatic scroll, navigation and measurement | Separate renderer-performance change |
| `views/SettingsView/components/Browser/index.vue`, `views/SettingsView/components/Browser/runtimeCache.ts` | Autosave, discovery and single-flight caches | Existing save-state enum and independent caches do not justify a generic machine |
| `views/SettingsView/components/DataManagement/index.vue` | Dialog mount/exit, import/export progress and restart countdown | Separate import/restore review; no data or retention changes |
| `views/SearchView/startup.ts`, `utils/font.ts` | First-paint readiness, font registration and reload generations | Separate startup-performance change |
| `services/AppUpdateService/index.ts` | Initialization/disposal, operation promises and subscriptions | Separate controller review; retain the existing update reducer |
| `services/AgentService/task/center.ts`, `services/AgentService/execution/runtime.ts`, `services/AgentService/execution/executor.ts` | Task ownership, attempts, streaming, retries, tools, cancellation and finalization | RFC-first |
| `services/AgentService/outputs/persistence.ts` | Session creation, turn/attempt identity and terminal writes | RFC-first; persisted shapes unchanged |
| `stores/askUser.ts`, `services/AgentService/task/projection/userPrompts.ts` | Approval/question queues, resolver ownership and cancellation | RFC-first tool-approval semantics |
| `services/BuiltInToolService/tools/bash/index.ts`, `services/AgentService/task/projection/widgets.ts` | Stream flush/cancel/finish; widget draft/ready/removal | RFC-first tool execution |
| `services/SchedulerService/scheduler.ts` | Enabled schedule, timer/event binding, generation and running task | Scheduling and execution are orthogonal; orchestration is RFC-first |
| `composables/useMcpConnection.ts`, `services/AgentService/infrastructure/mcp/McpManager.ts`, `apps/desktop/src-tauri/src/core/mcp/` | Connect/disconnect/reconnect and native resource ownership | RFC-first; no parallel frontend authority |
| `apps/desktop/src-tauri/src/core/browser/runtime.rs` | Managed/unmanaged process, connection and observation generations | Preserve native ownership and stale-observation guards |
| `services/ObservabilityService/index.ts`, `services/ObservabilityService/queue.ts` | Initialization, batching, flush and shutdown | Running and flushing coexist; retain bounded queue semantics |
| `apps/desktop/src-tauri/src/core/analytics/runtime.rs` | Consent epoch, session, operation handles and delivery batch | Privacy-sensitive; preserve consent boundaries |
| `apps/desktop/src-tauri/src/core/database/runtime/mod.rs`, `database/driver.ts` | Transaction registration, connection consumption, expiry and commit/rollback | RFC-first; no schema or transaction-contract changes |
| `utils/markdownMathDetection.ts`, `components/MarkdownContent.vue`, `database/driver.ts` | Fence, math, quote and escape scanning | Lexical parsers; require grammar-specific regression cases |
| `composables/useMotionPressure.ts`, `components/MarkdownCodeBlock.vue` | Pressure hysteresis and copy feedback | Small, bounded independent state; retain |
| `apps/site/src/scripts/component-demo-runtime.ts`, `apps/site/src/pages/index.astro`, `apps/site/public/*/touchai-components.html` | Mount/loading/readiness, replay, scroll-driven playback and effects | Separate website task |

## Existing explicit models to retain

- `services/AppUpdateService/state.ts`: update availability/download/install reducer.
- `apps/desktop/src-tauri/src/core/window/search/protocol.rs`: search visibility
  transaction with renderer/show/host generations.
- `apps/desktop/src-tauri/src/core/window/webview_recovery.rs`: recovery phases and
  bounded recovery policy.
- `apps/desktop/src-tauri/src/core/observability/shutdown.rs`: idle/flushing/exiting.

## Selected transitions

Reuse the installed, public `reka-ui` `useStateMachine` helper. Its implementation
accepts an explicit transition table and leaves unsupported events unchanged.
No new dependency, shared lifecycle framework or hand-rolled transition engine is
needed. Resources stay with their existing component or composable owner.

- Menu instance: `open -> closing -> disposed`. Only the close transition from
  open notifies; replacement and scope teardown dispose silently. Disposed is
  terminal.
- Menu component: `open -> closing -> closed`. Selection begins closing before
  calling user code, while preserving the public select-before-close event order.
  Visual closing and resource disposal have separate owners.
- Confirmation instance: `pending -> settled -> disposed`, with direct disposal
  for failed mounting. Replacement and scope teardown settle a pending answer as
  false; an already settled answer never changes.
- Controlled confirmation component: open, confirmed/cancelled, closed; reopening
  begins a new answer cycle. An old exit event cannot close an open cycle.
- Shortcut subscription: pending, active, failed, disposed. Disposal is terminal even when
  native registration or unregistration completes later.

## Acceptance scenarios

1. Given an open menu, when the same action is activated twice before the next
   render, then the caller receives one selection and one close notification.
2. Given a closing menu, when a queued click arrives, then no action executes.
3. Given a replaced menu or confirmation, when an old event arrives, then the new
   interaction remains usable and the old result is not delivered again.
4. Given a pending confirmation, when its owner unmounts or replaces it, then the
   promise resolves false and no modal is retained.
5. Given a reopened confirmation, when a stale exit-animation event arrives, then
   it remains open and can produce its own answer.
6. Given a pending native shortcut subscription, when its owner unmounts before
   registration completes, then the late listener is released and receives no
   user callbacks.
7. Given an active shortcut subscription, when unregistration is delayed after
   unmount, then queued native events do not reach the disposed owner.
8. Given a subscription failure, when a new owner subscribes successfully, then it
   receives events normally and the original failure remains observable.

Tests exercise real Vue components and public composables. Only native IPC and
browser/time boundaries are substituted. Pure refactoring retains passing
characterization tests; defects need red-then-green regression evidence.

## Verification evidence

Verified on 2026-11-10 against baseline `2467ac12`:

- The original targeted characterization suite passed: 4 files, 26 tests.
- The new lifecycle suite on the original production code produced 4 failures
  and 6 passes. The failures reproduce duplicate selection, selection after menu
  dismissal, a stale confirmation exit event, and registration after unmount.
- After refactoring, the expanded targeted suite passed: 8 files, 69 tests,
  including existing keyboard, animation and cleanup coverage.
- `pnpm test:typecheck`, changed-file ESLint, changed-file Prettier and
  `git diff --check` passed. Both component templates are byte-identical to the
  baseline. Source references in the inventory and existing-model list were checked.

The targeted command is:

```powershell
pnpm --filter @touchai/desktop exec vitest run --configLoader runner --no-cache --maxWorkers 2 --silent=true tests/composables/interactionLifecycle.test.ts tests/views/SettingsView/shortcutCaptureLifecycle.test.ts tests/components/ContextMenu.test.ts tests/components/ConfirmDialog.test.ts tests/motion/useContextMenu.test.ts tests/motion/useConfirm.test.ts tests/composables/useContextMenuBranches.test.ts tests/composables/useContextMenuEmpty.test.ts
```

The complete frontend command,
`pnpm --filter @touchai/desktop test:unit --no-cache --maxWorkers 2 --silent=true`,
exited with status 1: **492 files passed, 2 failed; 6141 tests passed, 3 failed**.

- Two cases in `apps/desktop/tests/ci/patchCoveragePaths.test.ts` failed. Windows
  exposes the temporary directory through an 8.3 short name, while Git returns
  the canonical long path. The unchanged coverage mapper compares those paths
  lexically, so a covered statement is reported as uncovered. A direct
  reproduction returned 0/1 with the short report path and 1/1 with the canonical
  report path. Neither coverage tooling nor its tests were changed.
- The first case in
  `apps/desktop/tests/components/markdownContentInlineCopy.test.ts` exceeded its
  5000 ms deadline. The test and Markdown rendering paths were not changed, but
  the timeout has not been established as a baseline failure. It remains an
  unresolved full-suite validation failure, not a passing check.

No failure was hidden by increasing a timeout or retrying until green. These
unrelated rendering/tooling paths were not changed as part of lifecycle work.

Verification reused dependencies already installed on this machine, including
Vue 3.5.43, Reka UI 2.11.0, Vitest 4.1.12 and TypeScript 6.0.3, with Node 22.23.4
and pnpm 10.32.1. The missing `virtua` package was reused from another local
installation. No manifest or lockfile was changed; this is not evidence of a
fresh frozen-lockfile installation.

## Performance and release gate

No new loops, polling, global registries, unbounded history or caches. Each live
interaction owns bounded resources, and disposal releases its timer, animation
frame, listener and Vue app. Styling and animation timing are unchanged.

The existing budget remains at most 5% P50/P95 latency and steady-state memory
regression on the same release build/device/DPI/WebView. Unit tests and synthetic
timings are not substitutes for that native release measurement. Validation
results and unavailable gates must be reported separately.

`pnpm test:pr`, desktop E2E and native release P50/P95/memory measurements were
not run. This environment has no non-system scratch drive for the required
heavy build output. Before release, run those gates on a prepared native build
environment and compare the selected interactions with `2467ac12`; the passing
unit and type checks do not establish release readiness.
