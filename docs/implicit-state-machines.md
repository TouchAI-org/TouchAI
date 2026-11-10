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
| `stores/settings.ts`, `stores/mcp.ts` | Initialization, load promise, subscription and disposal | Refactored initialization owners, retry and disposal; overlapping read counts remain independent. MCP transport/cache authority is unchanged |
| `views/SearchView/index.vue`, `views/SearchView/components/SearchBar/composables/useModelSelection.ts` | Quick-search reveal/fold/handoff; overlay intent and model-list loading | Refactored handoff phases, per-load ownership and pending model intent; retained reveal/geometry generations and the controller's writable visibility request |
| `views/SearchView/components/SearchOverlayHost/index.vue` | Mount, position, reveal and animation cleanup | Refactored closed/entering/open/closing/disposed; placement, native acknowledgement, CSS and durations unchanged |
| `views/SearchView/searchSurfacePreparation.ts`, `views/SearchView/searchWindowRegions.ts` | Preparation/commit, cancellation, generations and stale acknowledgements | Refactored the preparation controller's local listener set as pending/active/failed/disposed, including repeated startup and partial-registration failure. Retained native `rendererEpoch`/`showEpoch`/`hostEpoch`, `isCurrent` checks around each await, viewport matching and bounded flush retries; the native handshake and region authority are unchanged |
| `views/SearchView/composables/useSearchPage.ts` | Visibility, blur reconciliation, auto-hide, pinning and listeners | Retained: one-shot admission is not readiness; every startup await checks disposal, `listenWhileMounted` guards callbacks/late handles, and blur/visibility epochs distinguish independent native observations |
| `views/SearchView/composables/useSearchWindowResize.ts`, `views/SearchView/composables/useSearchPanelResizing.ts`, `views/SearchView/composables/useSearchPanelDragging.ts` | Measurement, desired/accepted geometry, commit/cancel and rollback | Retained: pointer position, natural size, desired bounds and accepted native bounds coexist. Commit/generation acknowledgement is already explicit; one phase would lose pending geometry |
| `views/SearchView/components/QuickSearchPanel/composables/useQuickSearchLogic.ts`, `views/SearchView/components/QuickSearchPanel/composables/useAssetLoader.ts` | Debounced queries, pagination, in-flight generations and asset queues | Retained: query/pagination generations and separate icon/image pipelines permit concurrent work. Caches are capped at 300 entries/3 MiB and 120 entries/2 MiB, with two retries; menu ownership is refactored at its existing owner |
| `views/SearchView/composables/useSearchRequest.ts`, `composables/useSessionStatus.ts` | Pending submission, completion, history searches and subscriptions | Refactored both native subscriptions and derived the queued/waiting projection from its request. History query IDs and keys already reject stale results; task execution remains outside the view's lifetime |
| `components/ui/message-scroller/MessageScroller.vue` | Follow output, manual/programmatic scroll, navigation and measurement | Retained: follow intent, a programmatic-scroll lease, navigation and coalesced measurement can coexist. Timers/observers have teardown; mutually exclusive phases would change follow/scroll behavior |
| `views/SettingsView/components/Browser/index.vue`, `views/SettingsView/components/Browser/runtimeCache.ts` | Autosave, discovery and single-flight caches | Existing save-state enum and independent caches do not justify a generic machine |
| `views/SettingsView/components/DataManagement/index.vue` | Dialog mount/exit, import/export progress and restart countdown | Refactored the two mounted dialog owners. Backup progress/status, native operations and countdown are separate data; no import, retention or restore change |
| `views/SearchView/startup.ts`, `utils/font.ts`, `views/SettingsView/sectionPreloader.ts` | First-paint readiness, font registration, reload generations and idle preloads | Refactored preloader scheduling/loading/disposal, including synchronous callbacks. Startup is linear orchestration of guarded owners; FontFace owns font loading, while injection generations preserve the old face until its replacement is ready |
| `services/AppUpdateService/index.ts`, `services/AppUpdateService/reminders.ts` | Initialization/disposal, operation promises, reminder history and subscriptions | Refactored initialization/subscription owners and guarded queued notification actions. Existing update reducer, native operation promises, history serialization and settings-opening lease remain independent |
| `services/AgentService/task/center.ts`, `services/AgentService/execution/runtime.ts`, `services/AgentService/execution/executor.ts` | Task ownership, attempts, streaming, retries, tools, cancellation and finalization | Retained: domain statuses/events and terminal projection operations are already explicit. A task owns multiple attempts and tool results; AbortController cancellation, retry identity and persistence completion are not one exclusive UI phase |
| `services/AgentService/outputs/persistence.ts` | Session creation, turn/attempt identity and terminal writes | Retained: session/turn/attempt IDs and terminal writes enforce durable identity. A view lifecycle cannot replace transactional identity or determine when a durable attempt is committed |
| `stores/askUser.ts`, `services/AgentService/task/projection/userPrompts.ts` | Approval/question queues, resolver ownership and cancellation | Retained: tagged resolver entries are a concurrent queue; `settleAt` removes ownership before calling the resolver, preventing double settlement. One machine for all prompts would incorrectly serialize unrelated requests |
| `services/BuiltInToolService/tools/bash/index.ts`, `services/AgentService/task/projection/widgets.ts` | Stream flush/cancel/finish; widget draft/ready/removal | Retained: cancellation and buffered stream flushing can overlap; widget draft/ready is an explicit protocol. Widget run tokens, destruction checks and resource scopes already guard script execution and dispose timers/listeners/observers without weakening the sandbox |
| `services/SchedulerService/scheduler.ts` | Enabled schedule, timer/event binding, generation and running task | Refactored each trigger binding as pending/armed/disposed; superseded handles are released. Schedule version and running-task identity stay independent, so cancelling a trigger does not implicitly cancel an executing task |
| `composables/useMcpConnection.ts`, `services/AgentService/infrastructure/mcp/McpManager.ts`, `apps/desktop/src-tauri/src/core/mcp/` | Connect/disconnect/reconnect and native resource ownership | Retained: frontend data is a per-server projection; native `ServerStatus`, rmcp `RunningService` and locked optional handles own the connection. A frontend transition table cannot govern that transport and would introduce competing authority |
| `apps/desktop/src-tauri/src/core/browser/runtime.rs` | Managed/unmanaged process, connection and observation generations | Retained: `BrowserStatusKind` already names native phases; `begin_lifecycle_transition` and `begin_unmanaged_connect` increment the locked generation, `is_current_connected_generation` checks both generation and endpoint, and `stop`/`set_error` consume the owned process with `take()`. Managed ownership and observation identity remain independent of connection status |
| `services/ObservabilityService/index.ts`, `services/ObservabilityService/queue.ts` | Initialization, batching, flush and shutdown | Refactored window close as open/flushing/closing/closed, preserving unlisten-before-close and retry after synchronous failure. Queue production and batch flushing can coexist; bootstrap deduplication remains separate |
| `apps/desktop/src-tauri/src/core/analytics/runtime.rs` | Consent epoch, session, operation handles and delivery batch | Retained: consent and delivery epochs reject pre-revocation work. Session/operation ownership and bounded queue state coexist; replacing these privacy fences with one lifecycle would lose identity |
| `apps/desktop/src-tauri/src/core/database/runtime/mod.rs`, `database/driver.ts` | Transaction registration, connection consumption, expiry and commit/rollback | Retained: a locked optional connection is consumed with `take()` for exactly one terminal commit/rollback. Expiry and transaction registry are resource ownership, not competing booleans; no schema/contract change |
| `utils/markdownMathDetection.ts`, `components/MarkdownContent.vue`, `database/driver.ts` | Fence, math, quote and escape scanning | Retained grammar-specific scanning: delimiter depth, quoting and escape context compose rather than represent an asynchronous resource lifetime |
| `composables/useMotionPressure.ts`, `components/MarkdownCodeBlock.vue` | Pressure hysteresis and copy feedback | Refactored pressure monitoring as idle/sampling/disposed with restart generations: synchronous feedback cannot revive or duplicate a sampler. The one-second cadence and two-late/eight-timely hysteresis stay unchanged. Copy feedback remains independent: concurrent writes are allowed, `disposed` guards feedback/timer creation after the await, and unmount clears its one-second timer |
| `apps/site/src/scripts/component-demo-runtime.ts`, `apps/site/src/pages/index.astro`, `apps/site/public/*/touchai-components.html` | Mount/loading/readiness, replay, scroll-driven playback and effects | Refactored demo loads with a tagged idle/loading/ready/error owner plus native AbortController. Retained playback progress, visibility and replay admission: continuous animation coordinates and independent observer inputs are not exclusive phases |

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
The Astro runtime instead uses a small discriminated resource union and the
browser's AbortController: introducing Vue/Reka there would add a framework for
one browser-owned request. The benchmark uses existing WDIO and Node/PowerShell
platform APIs; its nearest-rank percentile calculation needs no statistics library.

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
- Settings/update initialization: each pending/ready/disposed attempt owns its
  subscription handles, so replacement does not wait for a disposed attempt.
- MCP/reminder initialization: idle/initializing/ready/disposed; failure permits
  retry, while disposal prevents publication and queued actions.
- Session/history subscriptions: pending/active/failed/disposed; callbacks guard
  disposal as well as late handle acquisition.
- Search-surface subscriptions: pending/active/failed/disposed; concurrent and
  reentrant starts share their listener set, and a failed attempt releases partial
  handles before retry. Native preparation identity remains a separate authority.
- Motion-pressure monitoring: idle/sampling/disposed; a per-run generation guards
  every scheduling boundary against synchronous feedback and stale callback tails.
- Preloader: idle/scheduled/loading/disposed. A schedule can fire synchronously;
  a loader can throw synchronously; neither can strand the serialized queue.
- Overlay: closed/entering/open/closing/disposed; data dialogs:
  closed/open/closing/disposed. Rendered/motion projections cannot contradict.
- QuickSearch handoff: idle/holding/closing/disposed. Model data loads own their
  pending/ready/failed/invalidated state; model-open promises own an intent epoch.
- Scheduler binding: pending/armed/disposed. Cleanup belongs to the registration
  attempt, not whichever schedule happens to occupy its identifier later.
- Window close: open/flushing/closing/closed, reopening only on failed close.
- Site demo: idle/loading(controller)/ready/error; only the current attempt can
  publish. Removing the source aborts and invalidates the pending attempt.

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

## Completion pass acceptance scenarios

The maintainer requested completion of every suitable candidate without opening
issues. Every inventory row now has an implemented or code-grounded retained
decision, not a future-task label. The current-head testing evidence and required
checks in [PR #774](https://github.com/TouchAI-org/TouchAI/pull/774) record full
acceptance separately from implementation. Existing data shapes, native authority
and security scopes remain unchanged.

1. Given concurrent settings initialization, when registration completes, then
   callers share one subscription and disposal releases it.
2. Given initialization waiting for storage or native registration, when its
   owner disposes, then completion cannot restore readiness or deliver updates.
3. Given a disposed initialization still pending, when a new initialization
   starts, then the new owner becomes ready independently of the old completion.
4. Given failed initialization, when initialization is requested again, then the
   failure remains observable and a fresh owner can subscribe successfully.
5. Given an active settings store, when its Pinia scope is disposed or native
   unregistration is delayed, then no queued event mutates the disposed store.
6. Given overlapping refreshes, when one finishes, then loading remains visible
   until the remaining read finishes.
7. Given an update controller awaiting native subscriptions, when disposal wins,
   then late registrations are released and cannot publish stale update state.
8. Given concurrent reminder initialization, when the owner disposes, then no
   duplicate or late notification listener can open settings or persist history.
9. Given concurrent MCP-store initialization, when the view scope is disposed,
   then one shared status subscription is released and late storage/native
   completions cannot make the disposed store ready or mutate its projections.
10. Given a failed MCP status registration, when initialization is retried, then
    the error remains observable and a fresh registration can become ready.
11. Given a section loader that throws before returning a promise, when another
    section is prefetched, then the error is reported and serial loading resumes.
12. Given synchronous scheduling, when settings closes during an active import,
    then completed scheduler handles are not cancelled and queued imports stop.
13. Given a synchronous log-flush failure, when closing is retried, then the next
    request can flush and close rather than remaining attached to a settled request.
14. Given an overlay preparing, opening or leaving, when it is reopened, hidden
    or disposed, then only the current entrance can reveal/focus it and only the
    current exit can release its region; timing and geometry remain unchanged.
15. Given an import-choice or backup-progress dialog, when it closes and reopens
    before a previous exit event, then the new dialog remains visible; cancelled
    file selection never performs a database import/export.
16. Given a session-status subscription still registering or unregistering, when
    its component unmounts, then queued native status events cannot mutate the
    disposed projection and any late subscription is released.
17. Given a schedule being armed or replaced, when it is unscheduled or removed
    before registration finishes, then no superseded timer or event subscription
    survives; running task execution remains an independent concern.
18. Given a website demo reload superseding an older fetch or script load, when
    the older work succeeds or fails, then it cannot mark the newer demo ready or
    failed, replace its content, or clear its loading indicator.
19. Given a QuickSearch-to-conversation handoff, when its animation finishes or
    the expansion is cancelled, then holding and closing cannot coexist as
    contradictory flags and the result shell stays until the existing owner releases it.
20. Given model-list invalidation during an open request, when an older query
    completes, then it cannot overwrite the current model list or clear the
    pending state of a newer toggle that the user is cancelling.
21. Given an open history list with a native status subscription registering or
    unregistering, when the view is disposed, then queued events cannot start
    more database reads or update the abandoned list; late listeners are released.
22. Given a loaded or loading website demo, when its source is removed and reload
    is requested, then readiness clears without a new fetch and any old request
    cannot later publish content or readiness.
23. Given baseline and head builds in external Windows scratch directories, when
    Vite emits Monaco workers, then both revisions write assets to their intended
    scratch output instead of appending an absolute drive path to the source root.
24. Given a motion-pressure sample publishing feedback, when its consumer
    synchronously disposes the policy, then no background sample survives disposal.
25. Given a pressure callback synchronously restarting monitoring, when one new
    delayed sample arrives, then it cannot count as two samples or reduce motion.
26. Given recovery feedback synchronously refreshing window visibility, when the
    old restart returns, then exactly one current sampler remains scheduled.
27. Given repeated or synchronously reentrant search startup requests, when native
    subscriptions connect, then one listener set delivers each window fact once.
28. Given a failed search subscription attempt, when its remaining handles or
    queued events arrive, then they are released or ignored and a retry owns a
    fresh listener set without changing the native preparation handshake.
29. Given a disposed search preparation controller, when startup is requested
    again or disposal interrupts synchronous registration, then no further native
    listener or readiness request is created.
30. Given release assets in an external Windows scratch directory, when Tauri
    packages either revision, then it embeds that directory as local assets rather
    than interpreting the drive letter as a URL; native IPC retains its normal
    trusted origin without changing CSP or the release profile.
31. Given a native settings listener registered before its handle returns, when
    the store disposes and a queued setting arrives, then it cannot mutate the
    disposed store, and the late handle is still released.
32. Given a disposed progress subscription whose native handle is still pending,
    when a new update owner downloads and receives progress, then each progress
    fact reaches its subscribers once and late old-handle cleanup keeps the new
    subscription usable.
33. Given multiple search results and a view-toggle button, when native menu
    acceptance opens a result menu in either grid or list view, then readiness
    and input dispatch target the same first result without ambiguous selection.
34. Given a benchmark runner whose system prefers reduced motion, when either
    isolated revision launches, then only that benchmark WebView receives the
    normal-motion override; real animations and automatic pressure remain active.
35. Given an ongoing native measurement, when system motion, application pressure
    or window visibility makes any sampled frame invalid, then acceptance fails
    with the observed conditions rather than including that sample as normal.
36. Given a native driver whose launch flags do not affect media preferences,
    when acceptance selects each benchmark window, then the existing driver
    applies normal motion to that target and actual media/application readback
    confirms it before measurement; other windows remain untouched.
37. Given rejected native media emulation, when acceptance initializes a window,
    then the driver error remains observable, no sample is admitted, and a later
    successful driver request can initialize normally without a fallback.
38. Given a successful media command, when actual media still prefers reduced
    motion, application pressure remains active or the window is hidden, then
    acceptance rejects the observed environment instead of trusting the command
    response, changing application policy or waiting for pressure to clear.
39. Given a captured native process tree, when a child exits or its PID is reused
    before a later lookup, then memory and process/renderer counts describe the
    same captured tree rather than failing or mixing unrelated process data.
40. Given a missing or ambiguous app root, no renderer, unavailable counters or
    a failed system query, when native memory is sampled, then no valid report
    is emitted; a later valid sample succeeds without retries or zero fallback.
41. Given a process whose recorded parent PID has been reused by the app or an
    owned child, when its creation predates that parent, then the unrelated
    process and its descendants are not attributed to the benchmark app.
42. Given a genuinely newer descendant, when its executable or process role
    differs from the app, then its memory and process count are still included;
    missing creation times reject the sample rather than guessing ownership.
43. Given a native memory sample, when a process-count budget changes, then its
    report identifies the owned processes and rejected parent-PID reuses using
    the same enumeration, without recording executable paths or command lines.

## Verification evidence

### Original interaction pass

Verified on 2026-11-10 against baseline `2467ac12` (head `c1367abc`):

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

### Completion pass

The expanded implementation has separate red/green evidence, not just the old
PR's passing checks:

- Settings initialization: 5 failures on the old owner; updater/reminder: 7;
  MCP/preloader/close: 7; status subscription: 1; scheduler/site: 7;
  model popup: 2. These reproduce lifecycle behavior, not private phase names.
- The last history-subscription/source-removal cases produced 3 failures before
  their fixes, then passed with existing request and model-selection regressions:
  **6 files / 102 tests**.
- A final retention review reproduced three pressure-monitor failures: disposal
  inside synchronous feedback left a timer, restarting during pressure counted
  one late sample twice, and refreshing visibility during recovery created two
  samplers. Its lifecycle and per-run generation now own scheduling; the signal's
  thresholds and cadence are not changed to make the tests pass.
- The same review reproduced six search-subscription failures: repeated or
  reentrant startup duplicated native facts, startup after disposal registered
  new work, both synchronous and asynchronous connection failure retained partial
  listeners, and failed attempts accepted late handles/events. Only the local
  subscription owner is refactored; native epochs and geometry commits remain
  the existing authority.
- A subsequent synchronous-disposal regression caught two more native
  registrations being requested after disposal interrupted startup. Admission is
  now checked before each native registration, not only when its handle returns.
- The pressure, subscription and existing readiness regressions passed together:
  **3 files / 37 tests**. Startup race tests now wait for observable preparation
  barriers rather than assuming a fixed number of promise microtasks, so hiding,
  disposal and supersession still exercise the intended in-flight phase.
- Two additional native-boundary regressions cover events arriving after listener
  registration but before its handle returns: disposed settings cannot change,
  and a replacement update owner receives each progress fact once. Removing their
  existing guards makes both tests fail; restoring the guards passes **2 files /
  20 tests**. These strengthen existing behavior rather than change product code.
- The broader SearchView and motion characterization passed **80 files / 929
  tests** before the last synchronous-disposal case; the final 37-test suite covers
  that added admission guard. Full new-head CI remains a separate acceptance gate.
- Earlier completion-pass runs passed **12 files / 128 tests** (settings and
  updater), **12 / 80** (MCP/preloader/observability), **3 / 28** (dialogs/overlay),
  **2 / 15** (status), **4 / 58** (scheduler/site), and **3 / 42** (model popup,
  search lifecycle and site). These suites overlap; the counts must not be added.
- Fresh production, desktop-test and CI-tooling type checks passed. The motion
  regression now initializes the real store through its database boundary rather
  than assigning a derived readiness flag.
- The expanded full local frontend coverage run uses canonical Windows `TEMP`/`TMP`,
  avoiding the previously reproduced short-path mismatch without changing the
  coverage mapper. The local full CI-tooling run had **331 passed / 40 failed**;
  failures included subprocess/test timeouts and temporary-file locking while
  concurrent checks ran. This is not recorded as a passing full gate.
- The native-report comparison tests avoid per-case Node startup and test the
  public report API. The original five passed; reduced-motion and hidden-window
  rejection extend the characterization to **7/7 passed**. CI still invokes the
  real CLI/native harness; no timeout or budget changed.
- The native-media boundary suite reproduces **7 failures / 2 passes** without
  the driver override. With target-local media control, all **9/9 pass** alongside
  the seven report cases (**2 files / 16 tests**). These tests run the real
  request/readback helper against HTTP and WebView system boundaries; they do
  not replace actual Windows native integration or performance evidence.
- The native-memory boundary suite reproduces **4 failures / 5 passes** with
  the two-query collector. With one process-tree enumeration, all **9/9 pass**;
  the combined memory/media/report suites pass **3 files / 25 tests**. The full
  repository tooling suite passes **15 files / 391 tests**. Only OS query
  boundaries are replaced; the actual PowerShell collector runs unchanged in
  these tests, including rejection and subsequent recovery. No native memory
  measurement or passing release comparison is inferred from those fixtures.
- Expanded-head CI, native E2E, visual checks and release performance results
  are recorded in the PR's testing evidence and linked check reports. Old-head
  `c1367abc` checks are historical evidence only, not acceptance of later code.

## Performance and release gate

No new loops, polling, global registries, unbounded history or caches. Each live
interaction owns bounded resources, and disposal releases its timer, animation
frame, listener and Vue app. Styling and animation timing are unchanged.

The existing budget remains at most 5% P50/P95 latency and steady-state memory
regression on the same release build/device/DPI/WebView. Unit tests and synthetic
timings are not substitutes for that native release measurement. Validation
results and unavailable gates must be reported separately.

Local `pnpm test:pr` cannot run its native build stages on this machine: there is
no non-system scratch drive. The existing required CI jobs remain the full
frontend/Rust/coverage/site-build gate; no threshold or test timeout is relaxed.

`apps/desktop/e2e-tests/performance/run.ps1` adds release acceptance to the
existing Windows E2E job, so `E2E Required` cannot pass before it completes.
Changes to this audit or the benchmark opt in; unrelated PRs retain their normal
E2E path. It builds the PR baseline and head with frozen dependencies and the
unchanged release profile, with all benchmark build/runtime/report output in
verified non-system runner scratch, outside the checkout.

The same WDIO harness measures native menus, model overlays, confirmation and
import dialogs in six independent sessions per revision, alternating ABBA.
Each phase gets 300 recorded warm samples after five warmups per session. Every
P50/P95 latency, retained-DOM and native process-tree memory budget is checked at
5%; the WebView, DPI, viewport, visibility and normal-motion environment must
match. Raw samples, long tasks, renderer/process counts and the comparison are
uploaded as `lifecycle-release-performance`. No forced GC or disabled animation
is used. These are existing flows, not new-flow cold-start claims. Each session
uses isolated test data and releases only its benchmark process tree afterward.

Neither the benchmark's comparison-unit tests nor an installed harness count as
native performance evidence. Acceptance requires that job to actually run and
its report to pass; the PR records the tested commit and actual measurements.

The release job at `98a7acba` exposed a second Windows asset-path issue before
sampling: Tauri's installed `FrontendDist` deserializer tries URL before directory,
so an absolute drive-letter path selects an external URL and embeds no assets.
The runner now resolves its temporary `frontendDist` relative to the archived
`apps/desktop/src-tauri` directory, while keeping the actual output in external
scratch. The existing native bridge startup assertion is the regression guard;
the origin check, CSP, security scopes and release optimization flags are unchanged.
Local syntax/path checks are not recorded as a successful native build or sample.

At `7c76c4ba`, both native release builds and all 45 smoke tests passed, but the
first benchmark session failed: the menu prerequisite matched six results plus
the view-toggle button. Its partial baseline report also recorded the Windows
runner's reduced-motion preference. Neither the incomplete cases nor those
reduced-motion samples are valid performance evidence.

Readiness and menu dispatch now share the first result's grid/list selector.
At `4eab7b94`, all 45 smoke tests, app-window visuals and both native release
builds passed. The benchmark still failed before recording a sample: WebView2
reported system and application reduced motion despite the recorded
`--force-prefers-no-reduced-motion` launch argument. A generic Chromium source
reference was not proof of the actual WebView2 media preference. This failed run
provides no performance comparison and does not pass the aggregate E2E gate.

The ineffective argument is replaced by the existing EdgeDriver's target-local
`Emulation.setEmulatedMedia` command for `prefers-reduced-motion: no-preference`.
The benchmark applies it to both the selected search and settings WebViews, waits
exactly two rendered frames for media/Vue propagation, then reads actual system
media, application pressure and visibility. Driver rejection or invalid readback
fails acceptance; there is no fallback, retry or wait for pressure to clear.
Every measured frame retains the same normal-motion and visibility guards.

The installed WDIO exposes its legacy Chromium command only for recognized
Chromium sessions, while this native driver reports `webview2`. Its Puppeteer
adapter would require an uninstalled dependency. Rather than add a dependency or
attach a second browser controller, the benchmark sends one standard vendor
request through the existing WDIO connection/session using Node's bounded fetch.
[Selenium's Chromium connection](https://raw.githubusercontent.com/SeleniumHQ/selenium/trunk/py/selenium/webdriver/chromium/remote_connection.py)
defines `/session/$sessionId/{vendor_prefix}/cdp/execute`, and its
[Edge connection](https://raw.githubusercontent.com/SeleniumHQ/selenium/trunk/py/selenium/webdriver/edge/remote_connection.py)
uses `ms` as that prefix. Local HTTP/WebView-boundary tests cover route handling,
window-local effects, driver failure/recovery and ineffective/pressured/hidden
readback. The real Windows native job remains the final integration proof.

No OS setting, product preference, shared smoke/visual configuration, automatic
pressure detection or animation duration is changed. The environment report
identifies the media-control method; per-flow reports contain actual conditions.
The same six-session ABBA run and unchanged budgets must pass on the new head.

At `950af148`, both release builds, all 45 native smoke tests and app-window
visuals passed. Actual search/settings media readback and all measured frames
confirmed visible windows with normal motion. The artifact contains one complete
baseline session, not a paired comparison: the first head session completed its
four animated flows but failed when a child exited between process enumeration
and a later `Get-Process -Id` memory lookup.

The collector now takes ownership, renderer counts and memory counters from the
same `Win32_Process` enumeration, without a second mutable PID lookup, retry or
catch-and-ignore. `PrivatePageCount` and `WorkingSetSize` map to the same native
fields that [.NET uses for private bytes and working set](https://raw.githubusercontent.com/dotnet/runtime/main/src/libraries/System.Diagnostics.Process/src/System/Diagnostics/ProcessManager.Windows.cs).
A missing/ambiguous app root, absent renderer, missing counter or failed query
still rejects the sample. The environment report identifies the collection method.
System-boundary regression tests reproduce process exit, PID reuse and missing
counters before the fix; the actual release job must still complete all sessions
and budgets before this work is accepted.

At `abf529ec`, all 12 native release sessions completed and 23 of 24 budgets
passed. Process-count P95 failed: 10 at baseline versus 11 at head, above the
unchanged 5% limit. Two head samples (blocks 6 and 9) contain 11 processes; the
other 58 samples contain 10. All samples contain three renderers. Private-bytes
P95 changes by +0.31% and working-set P95 by +0.33%; latency and retained-DOM
budgets pass. Both the native job and aggregate E2E gate failed. These reports
contain totals but no process identities, so the additional process cannot be
attributed to PID reuse, a particular helper or a product leak from this evidence.

The ancestry audit found a separate, reproducible collector gap: a process's
recorded parent PID can refer to a newer, unrelated process after PID reuse.
[Windows documents creation-time comparison for this case](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-process#properties).
Ownership now also requires that each descendant was created no earlier than
its recorded parent, using creation times from the same enumeration. Missing
creation times reject the sample; genuinely newer descendants are counted
regardless of executable or role. There is no helper allow-list or counter filter.

Each sample now includes owned process IDs, parent IDs, executable names, UTC
creation times, allow-listed roles and both memory counters, plus rejected
parent-PID reuse edges. Paths and command-line contents are not emitted. This is
CI artifact metadata only, not a user-data or native IPC format change.

Scenarios 41–43 were written before the additional OS-boundary regressions.
The old collector produces 6 failures and 12 passes across 18 cases, retaining
all nine preceding passing regressions. The corrected collector passes all 18;
the combined memory, native-motion and report-comparison suites pass 3 files /
34 tests. Replaying the original 60-sample corpus still fails its process-count
budget. No samples, percentiles, session counts, pressure guards or budgets were
changed. A new native run must use the identity evidence to evaluate the anomaly;
a later passing run alone does not establish the cause of the earlier failure.
