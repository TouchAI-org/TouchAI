# RFC #710 — Task, Settings and Platform Ownership (design & acceptance record)

This is the local workspace/design and acceptance record for RFC #710. The
authoritative design lives in issue #710; this file fixes the baseline, the
phased file scope, the BDD→TDD acceptance checklist, the performance budget and
the invariants the implementation and verification agents must hold.

Status (2026-11-03): **implementation, executable functional/regression
acceptance, Rust coverage, and the canonical GitHub-hosted performance
acceptance are complete. GitHub Actions is the only acceptance environment for
performance; Daytona is retained as historical diagnostic evidence only.** The
formal cold-latency run measured 240/240 valid launches across 60 paired
A/B/B/A blocks, and the formal steady-state-memory run measured 48/48 valid
runs across progress and long-session histories 100, 500 and 1000. All gated
latency, progress-memory and retained-memory rows passed the unchanged 5%
upper-bound budget. Earlier local and Daytona failures remain below as
historical evidence; none was deleted or used to replace the GitHub-hosted
result. The branch is pushed in draft PR #733 and has been synchronized with
`main` at `379543a917737f71eac0c4024bb40d999398feff`.

## Baseline and workspace

- Baseline commit: `21e261a1343087d7dc75414dbb46a12a98630da6` (tip of `main` at task start).
- Branch: `t3/710-architecture-ownership-design`; worktree: `/root/.t3/worktrees/TouchAI/t3-8efe7848` (isolated, not the main workspace). Status: implementation, Rust coverage and GitHub Actions performance acceptance complete; commits `5b0da593`, `5174b9ed`, `376d1fb9`, `64514c9a` and `7be0fcdc` are pushed in draft PR #733. The branch has been synchronized with `main` at `379543a917737f71eac0c4024bb40d999398feff`; the merge preserves upstream observability, CI-sharding and design-system work.
- Prior art: RFC #434 / draft PR #435 (`codex/issue-434-architecture-boundaries`) is read-only reference. Do not check out, rebase or rewrite it; reconcile overlapping contract/popup/HTTP work rather than replay its older branch.

## Design summary

Single source of truth is #710. Load-bearing decisions, restated short:

1. Keep Vue/TS orchestration and Tauri/Rust ownership of native resources and SQLite; no microservices, DI container, generic RPC or second DB model.
2. Neutral shared DTOs get explicit public entry points; separate value/type/dynamic imports in boundary checks; no new runtime cycles; core must not depend on Vue/Pinia/Tauri runtime/view components; internal modules must not import their own public barrel.
3. Executor checkpoints stay internal; expose only allowlisted `TaskViewSnapshot`, `TaskResult`, `ModelSummary` and public task events. Preserve the existing checkpoint DB serializer.
4. Runtime/task interaction state (not projection) owns pending approvals/answers/resolvers; register before notifying; key by task/attempt/call; reject stale; settle once; cancellation releases waits; UI detach does not cancel execution.
5. Main WebView is composed as the current runtime/settings command owner; other windows are clients. Bootstrap exposes owner readiness + ephemeral host epoch; no settings write before the owner has authoritative state; missing owner is a visible error, never an indefinite queue or second writer.
6. One typed `SettingsService` command path for UI and tool; serialize mutations globally in the owner; read committed → validate → reversible native action → commit persistence → publish/cache; never hold a SQLite transaction across an OS action; distinct rejected / committed / restored / recovery-required / unknown outcomes; reconcile an ambiguous ack before compensating; post-commit notify failure never rolls back; bounded pending + timeouts; ambiguous timeout does not auto-retry effects.
7. Settings clients reconcile at init/show/focus/invalidation; `hostEpoch` + monotonic in-memory revision to reject stale; DB stays authoritative across restarts; broadcast invalidations or non-sensitive DTOs only; readiness uses request/reply handshake plus notifications; startup/compensation reconcile native settings from persisted state; no durable operation journal.
8. Unlimited tool-loop iterations stay supported. Reduce full-state cloning and coalesce presentation updates without delaying terminal/approval/error transitions. Replaceable complete progress snapshots: one write in flight + one latest pending; semantic records and tool results never silently dropped; capture task/attempt/message identity at enqueue; retry/terminal closes the old writer, resolves in-flight work and supersedes pending progress only via an authoritative boundary/final write; old-attempt writes never target the next attempt's state; storage failure must not restart executed tools; keep the visible persistence-error behavior.
9. Preserve existing tool concurrency and per-call timeouts; narrow dispatcher with concrete builtin/MCP adapters; no global iteration/time cap; cancellation reports real capability (local wait cancellation ≠ remote MCP side-effect stopped); a native MCP cancellation protocol is deferred to a separate scoped design, never claimed via `Promise.race`.
10. Move HTTP/platform helpers to their owner and fix reader/pull/cancel lifecycle; separate Popup manifest/protocol from Vue renderer registration, retaining popup/session identity and ready/data/close/focus semantics; relocate model-ID pure policy; remove the `UsageService` self-barrel cycle without a catch-all shared utility service.
11. Verify real Tauri argument mapping, Serde and plugin commands (decoder behavior), not blanket camelCase or wrapper/handler equality; do not modify unrelated command behavior.

## Phased file scope

Paths below are the intended blast radius. A phase keeps call sites working
through short-lived adapters; it does not leave a second writer or a second
source of truth behind.

**Phase 1 — contracts, platform/HTTP, safe task API**
- `apps/desktop/src/services/AgentService/contracts/` — public DTOs (`TaskViewSnapshot`, `TaskResult`, `ModelSummary`, public events), import-mode separation.
- `apps/desktop/src/services/AgentService/task/` (`center.ts`, `types.ts`, `projection/`) — public handle vs internal checkpoint types.
- `apps/desktop/src/services/AgentService/execution/` (`executor.ts`, `runtime.ts`, `retry.ts`) — keep checkpoints internal.
- `apps/desktop/src/services/AgentService/session/` (`transport.ts`, `history.ts`) — reader/pull/cancel lifecycle.
- `apps/desktop/src/services/AgentService/catalog/models.ts` + model-ID pure policy owner; `apps/desktop/src/services/UsageService/` (`index.ts` self-barrel cycle).

**Phase 2 — interaction state vs presentation**
- `apps/desktop/src/services/AgentService/task/center.ts`, `task/projection/*` — projection formats history/cards only; approvals/answers/resolvers move to runtime/task interaction state.
- `apps/desktop/src/composables/agent/*`, `apps/desktop/src/stores/askUser.ts` — detach/attach without cancelling execution.

**Phase 3 — progress writes and UI delivery**
- `apps/desktop/src/services/AgentService/execution/*`, `outputs/persistence.ts`, `task/projection/*` — bounded progress pipeline at attempt/terminal boundaries; retain visible persistence-error behavior.

**Phase 4 — settings ownership**
- `apps/desktop/src/stores/setting/*`, `apps/desktop/src/stores/settings.ts` — single typed `SettingsService` command path.
- `apps/desktop/src/services/*` settings consumers, `apps/desktop/src/services/BuiltInToolService/` setting tool entry — same command path, tool approval/allowlist at the entry.
- `apps/desktop/src/services/NativeService/`, `apps/desktop/src-tauri/src/commands/` — owner readiness + host epoch, bounded transport, no schema change.

**Phase 5 — popup/native boundary + enforcement + docs**
- `apps/desktop/src/services/PopupService/*`, `apps/desktop/src/services/EventService/*` — manifest/protocol vs renderer registration.
- Dependency-rule enforcement near `eslint.config.js` (prefer an installed tool; add `no-restricted-imports`/cycle rules, or a small script only with a stated reason) and update `docs/agents/architecture.md`.

## Architecture enforcement (implemented in this task)

Goal: the ownership rules are executable gates, not a vision. Delivered under
`apps/desktop/scripts/ci/architecture/`, wired into `eslint.config.js`, the root
and desktop `package.json` (`architecture:check`) and a `CI Required`
`architecture` job. The rules run only linters already installed
(typescript-eslint, vue-eslint-parser, eslint `no-restricted-imports`); no new
dependency and no lockfile change.

| Check | Script | Strength |
| --- | --- | --- |
| Import boundaries | `check-boundaries.mjs` | Direct imports only; resolves real paths via `tsconfig` aliases so `@/`, `@services/`, `@database/` and relative specifiers are one edge; type/value/dynamic classified separately |
| Runtime cycles | `check-cycles.mjs` | TS/Vue AST + Tarjan SCC; type-only edges kept separate; a parse error fails the gate instead of faking "no cycles" |
| IPC presence | `check-ipc-commands.mjs` | Presence, not a decoder contract |
| DB drift | `check-db-drift.mjs` | Artifact hash baseline + out-of-tree `drizzle-kit generate` (temp dir removed in `finally`) |

Enforced now, with positive/negative fixtures in
`apps/desktop/tests/ci/architecture/`: `services/**` must not runtime-import the
Vue UI layer; `AgentService/contracts/**` must not import `execution/**`;
internal modules must not import their own `index` barrel; `database/**` must not
depend on business services (the `NativeService` bridge excepted); a neutral
`src/domain/**` module must not import Vue/Pinia/Tauri, the UI layers or
services.

`HOST_ADAPTERS` is **empty** today (documented with an exit condition). The
runtime-package bans and the path rules are **direct-import only**: support areas
(`utils`/`config`/`i18n`/…) are not constrained yet and services importing
`@/i18n` are an acknowledged baseline, so this does not claim every service is
transitively free of the UI runtime. `SettingsService/domain` policy returns
values and delegates translation to a service adapter.

Precise baseline exceptions (edge + import kind + reason + exit condition, in
`baseline-exceptions.json`):

- `services/AppUpdateService/index` → `stores/settings` (value) — refactoring the
  app-update flow onto the SettingsService contract is outside #710's authorized
  scope; exit when it stops consuming the Vue store directly.
- `services/AppUpdateService/notifications` → `services/AppUpdateService/index`
  (value, self-barrel) — pre-existing, not a cycle; exit when the singleton moves
  out of `index.ts`.

These are the **only two** exceptions. The only remaining boundary violation on
the live tree is `AppUpdateService/index -> stores/settings`, which is baselined;
the cycle baseline is empty and the only remaining cycle is type-only
(`AgentService/contracts/protocol ↔ tooling`), erased at build.

### Completion and remaining gaps

Delivered and exercised in this worktree:

- Full `pnpm test:pr`, the full Rust suite and `pnpm test:e2e` completed with the
  results in the verification record below.
- Rust coverage completed with the configured line and region floors passed;
  details and limitations are in the verification record below.
- Real Tauri decoder contract tests now cover the reviewed Serde/IPC cases:
  `src-tauri/tests/window_commands.rs` (13 tests) and
  `src-tauri/tests/ipc_contracts.rs` (7 tests).
- The narrow tool dispatcher is implemented under
  `AgentService/infrastructure/tools/`; the executor calls `dispatchToolCall`,
  and builtin/MCP behavior is covered through public adapter tests.
- The Settings owner/client, task interaction lifecycle, bounded progress
  writes, HTTP reader/cancellation, popup renderer split and architecture gates
  are integrated into the committed change set.

Performance acceptance is resolved by two GitHub-hosted runs:

- Cold latency, run
  [41445842343](https://github.com/TouchAI-org/TouchAI/actions/runs/41445842343):
  240/240 valid launches, 60 paired blocks, zero notification failures. P50 is
  `0.9702x` with 95% CI `[0.9526, 0.9811]`; P95 is `0.9684x` with
  `[0.9258, 0.9809]`. Both gated rows pass.
- Steady-state memory, run
  [41497330849](https://github.com/TouchAI-org/TouchAI/actions/runs/41497330849):
  48/48 valid runs, zero notification failures. Progress steady-state PSS,
  long-session 100/500/1000 retained PSS, and all retained DOM counts pass. The
  final run uses the corrected live-process memory sampler and retains the
  complete raw JSONL artifact.

The earlier 3.6 GiB local failures and Daytona diagnostics remain below as
historical evidence. They are not the acceptance result and no gate was
lowered.

Scope audit: no schema, migration, seed, index, persisted JSON/blob,
retention/deletion, CSP, capability, scope, tool allowlist or approval-rule
change was made. The unlimited tool loop has no new iteration or time cap, and
the checkpoint serializer is unchanged. The Settings single owner covers
GeneralSettings registered keys only; the existing `AppUpdateService`
update-reminder history write is a documented baseline exception.

## E2E harness and Settings UI stabilization

The first two full E2E runs after implementation produced 12 passing / 3 failing
and 11 passing / 4 failing. The bridge failures were not evidence that the main
window's production bridge had disappeared: WebdriverIO selected a remaining
window handle after `closeWindow()` and raced the explicit switch back to main,
leaving the session on a blank page. The same suite passed 18/18 on baseline
`21e261a1`. The harness now uses `switchToWindowWithE2eBridge()` to re-select the
target handle until `window.__TOUCHAI_E2E__` is visible. It still throws after
its timeout, so a permanent bridge failure is not swallowed.

The `settings-start-minimized-toggle` failure was a real production-state race:
an in-flight mutation received a focus-refresh snapshot with an older revision,
and the store mirrored that old value over the user's optimistic value. The
store now layers a per-key in-flight mutation overlay over every snapshot until
the request settles. Success, failure, timeout and disposal all clear the
overlay, and only the latest request for a key may clear it. The regression is
covered by `tests/stores/settings-mutations.test.ts` using the real owner/client
transport.

The overlay is presentation state only. UI and tool writes still converge on
`SettingsService.mutate`; it does not add a second persistence path or another
settings writer. After the fix, the implementation worker observed two focused
runs at 13/13 and two full runs at 18/18; the independent verifier then observed
another full `pnpm test:e2e` at 18/18.

## Final verification record (2026-11-01)

These are executable results from the final verification pass. The functional
and Rust gates passed; the performance result is explicitly reported in the
next section and is not uniformly passing.

| Area | Command | Result | Time / resources |
| --- | --- | --- | --- |
| Full PR gate | `pnpm test:pr` | exit 0; frontend unit and coverage runs each passed 322 files / 2,922 tests; statements 78.7%, branches 68.65%, functions 77.56%, lines 79.19%; Rust 224 passed / 0 failed / 1 ignored; site build passed | 23m47s; peak 1.6G, swap 459.4M |
| Full E2E | `pnpm test:e2e` | exit 0; 18 passing | spec 14s; service 3m42.6s; peak 1.6G |
| Source typecheck | `pnpm type:check` | exit 0 | 29.1s; peak 1.5G |
| Test typecheck | `pnpm test:typecheck` | exit 0 | 38.5s; peak 1.6G |
| Lint | `pnpm lint:check` | exit 0; 0 errors / 29 warnings | 60.8s; peak 788.7M |
| Format | `pnpm format:check` | exit 0 | 35.2s; peak 418.5M |
| Architecture | `pnpm architecture:check` | exit 0; 532 files / 0 boundary violations; 534 source files / no runtime cycle; 75 invokes / 74 Rust handlers + 1 explicit plugin / 0 unresolved; DB artifacts no drift | 52.4s; peak 660.3M |
| Worktree diff hygiene | `git diff --check` | exit 0 (the target document is untracked, so Prettier is its content-format check) | — |
| Rust formatting | `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --all -- --check` | exit 0 | 0.7s |
| Rust checks | `pnpm check:rust` | exit 0 | time not recorded in the final table |
| Real IPC tests | `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --target-dir /root/.cache/touchai/rust-target/test --test window_commands --test ipc_contracts` | exit 0; `window_commands` 13/13; `ipc_contracts` 7/7 | 2.9s incremental |
| Focused Settings tests | Focused Settings Vitest selection (19 files, including `SettingsService`, `settings-recovery`, `settings-mutations` and SettingsView) | exit 0; 19 files / 217 tests passed | 40.2s; peak 627M |
| Rust coverage | From `apps/desktop`: `pnpm test:coverage:rust` with `CARGO_TARGET_DIR=/root/build/touchai-coverage CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0`; cgroup `MemoryHigh=1700M MemoryMax=2200M MemorySwapMax=2000M CPUQuota=150% Nice=10` | exit 0; 13 target runs; 224 passed / 0 failed / 1 ignored / 0 doctests; lines 5604/11294 = 49.62% (gate 47%), regions 7442/15512 = 47.98% (gate 46%), functions 661/1556 = 42.48% (no configured gate); branches 0/0, not collected because the stable invocation did not enable `--branch` | script 162s; outer 167s; systemd service 2m41.719s; memory peak 1702.23 MiB (1.6623 GiB); swap peak 240.67 MiB; no OOM |

The full `pnpm test:pr` row already includes the Rust suite, frontend coverage
and site build. The focused Settings row is an additional check of the
cross-window changes; it does not replace the full regression run.

The first formal Rust coverage attempt exited 101 after 719s because a
build-time RTK dependency download failed with `tls connection init failed`;
the same command was retried unchanged and passed. This was an
environment/download failure, not a test or code defect. The stable coverage
invocation did not enable `--branch`, so branch coverage was not collected. The
configured line and region floors passed, but the result remains below the
repository's 85% Rust coverage aspiration; passing the configured gates must
not be read as meeting that aspiration.

Ownership of the remaining high-risk surfaces is recorded in
`.github/CODEOWNERS` (existing maintainer `@hiqiancheng`; no invented teams).

## BDD → TDD acceptance checklist

Scenario first, then a failing `user`-prefixed Given/When/Then test, then code.
Each item is backed by a public-contract (behavior) assertion.

- [x] `user` sees intended display fields (no internal checkpoints/connection
  config) while retry, reopen, detach and approvals keep working.
  (`task-view-contract.test.ts`, `runtime-credentials.test.ts`,
  `center-interactions.test.ts`, task/execution regression.)
- [x] `user` can still approve when a UI message is missing; duplicate/stale
  answers are rejected; cancellation clears pending waits and resources.
  (`interactions.test.ts`, `center-interactions.test.ts`, runtime cancellation
  coverage.)
- [x] `user` gets the same committed/recovered result whether a setting is
  changed from UI or the tool; native failure, DB failure, ambiguous ack,
  compensation failure and post-commit emit failure are distinct outcomes.
  (`SettingsService/service.test.ts`, setting-tool i18n/behavior tests,
  `settings-recovery.test.ts`.)
- [x] `user` sees concurrent writes from different windows serialize against
  latest cross-key validation; owner-not-ready, owner loss, missed
  ready/change events and focus/reopen are covered. (`SettingsService` service
  tests, `settings-recovery.test.ts`, `settings-mutations.test.ts`, E2E
  settings spec.)
- [x] `user` never sees an old attempt's progress on a new attempt and terminal
  output is not overwritten; semantic output preserved; pending work bounded;
  many iterations run until a real completion/cancel/error with no artificial
  ceiling. (`progress-barrier.test.ts`, `progress-writer.test.ts`, executor and
  adaptive-timeout regression; this is functional loop coverage, not a
  long-duration performance measurement.)
- [x] `user` sees HTTP downstream cancellation reach the real reader; slow
  consumption is not pumped into an unbounded wrapper queue.
  (`HttpService/tauri-fetch.test.ts`, webFetch/webSearch `discard-body.test.ts`,
  model-metadata discard coverage.)
- [x] `user` sees popup stale identities rejected and ready/data/close,
  selection, focus and size unchanged. (`PopupService` tests, PopupView renderer
  tests, startup/window E2E.)
- [x] Guard tests include violating fixtures that prove enforcement; a rewrite
  behind a public contract keeps behavior tests green.
  (`tests/ci/architecture/**`, `pnpm architecture:check`; real Tauri IPC
  contract tests cover the decoder cases while the IPC gate remains
  presence-only.)

Test homes: `apps/desktop/tests/**` (mirror `src/`), Rust `#[cfg(test)]` and `apps/desktop/src-tauri/tests/**`, E2E under `apps/desktop/e2e-tests/**` for startup/settings/popup/window.

## Performance budget

Budget: ≤5% P50/P95 and ≤5% steady-state memory regression on the affected
release flows on the same device/WebView; long-session tests report retained
history separately from temporary queue/clone overhead. Ratios in the table are
`current / baseline`; the GitHub Actions harness uses a paired A/B/B/A
block-cluster percentile bootstrap with 10,000 iterations. Sampling a complete
block preserves the local pairing of baseline and current launches instead of
treating temporally adjacent runs as independent. Runs without block metadata
fall back to an independent run-cluster bootstrap. A gated row passes only when
the interval upper bound is at most `1.05` and each arm has at least three
clusters. The threshold and metric definitions are unchanged. The tables below
were produced before this statistical refinement and are retained as historical
evidence with their original run-cluster intervals.

| Flow / metric | Baseline (KiB or ms) | Measured (KiB or ms) | Ratio [95% CI] | Status |
| --- | ---: | ---: | --- | --- |
| Streamed task loop, cold P50 | 1,956.5 ms | 1,881 ms | 0.9614x [0.3593, 1.0120] | PASS |
| Streamed task loop, cold P95 | 5,161.5 ms | 2,005.5 ms | 0.3885x [0.3676, 1.0336] | PASS |
| Streamed task loop, warm P50 | 1,603 ms | 1,522 ms | 0.9495x [0.9045, 0.9723] | PASS |
| Streamed task loop, warm P95 | 1,863.9 ms | 1,637.6 ms | 0.8786x [0.8516, 0.9373] | PASS |
| Progress write steady-state PSS | 1,543,307 KiB | 1,330,339.5 KiB | 0.8620x [0.8192, 0.9114] | PASS |
| Long-session 100 retained total PSS | 938,177.5 KiB | 952,657 KiB | 1.0154x [0.8913, 1.1767] | FAIL |
| Long-session 100 retained DOM nodes | 1,986 | 1,989 | 1.0015x [1.0015, 1.0015] | PASS |
| Long-session 500 retained total PSS | 1,156,420 KiB | 1,152,821.5 KiB | 0.9969x [0.9260, 1.0446] | PASS |
| Long-session 500 retained DOM nodes | 9,586 | 9,589 | 1.0003x [1.0003, 1.0003] | PASS |
| Long-session 1,000 retained total PSS | 1,243,721.5 KiB | 1,290,268 KiB | 1.0374x [0.8461, 1.1047] | FAIL |
| Long-session 1,000 retained DOM nodes | 19,086 | 19,089 | 1.0002x [1.0002, 1.0002] | PASS |

The release sample contains 76 run records: 60 succeeded and 16 failed. Valid
independent runs are 6 baseline / 6 current for latency, 6 / 6 for progress,
6 / 6 for long-session 100, 6 / 6 for long-session 500, and 6 / 6 for
long-session 1000. The 1500-message level remains an explicit diagnostic with
0 / 0 valid samples. The long-session 100 and 1000 rows both FAIL because their
run-cluster upper 95% bounds exceed `1.05`; the 1000 point ratio (1.0374) is
inside the 5% point budget, but the gate also requires the upper bound to be
inside it. The 1000 history-only growth row is AUX, not a substitute for the
gated retained-total row.

The historical protocol in this artifact's `run-plan.json` is latency blocks 3,
progress blocks 3, long-session blocks 3 for each formal level 100/500/1000;
`stats.mjs` reads the canonical `protocol`. The runner's `remainingPlan` field
records the pre-execution resume plan and is not used to compute measurement
counts. The GitHub-hosted workflow now uses six long-session blocks per level to
reduce the variance described below.

The long-session 1500 runs are a real environment blocker, not a synthetic
substitute:

- The seeded session opened successfully in the baseline attempt and rendered
  1,500 messages / 28,586 DOM nodes / 15.4 M body characters. The streaming
  phase then failed repeatedly with WebDriver timeouts or WebKit/
  JavaScriptCore segfaults. The app/WebDriver path timed out and the systemd
  scope reached about 1.7 GiB memory and about 1.9 GiB swap before SIGTERM.
  No model request was received in the failing runs. The failed evidence remains under
  `/root/.cache/touchai-verify/710/perf-20261101/failures/` and the raw run
  logs under `/root/.cache/touchai-verify/710/perf-20261101/logs/runs/`.
- The formal levels are 100, 500 and 1000 messages. The 1500 level remains
  available with `--history-levels 1500` as a diagnostic, but it is not part of
  the reproducible default and is not claimed as a valid measurement.
- The 1000-message level also produced repeated WebKit/JavaScriptCore
  segfaults under the same cgroup; seven failed run records are retained. The
  6 baseline / 6 current successful samples above are the complete valid
  post-open set used by the gate, not a replacement for the failed records.

Performance evidence is from release binaries built from baseline
`21e261a1` and the current dirty snapshot. Baseline SHA-256 is
`62d8de66dfb71ba90140a5bcd5bfb199ea129e7a58a88ee0ce64cda6af2fab7c`
(34,635,008 bytes); current SHA-256 is
`62cce5a7588aec9c92a75620ab4838fe42dcfba6fe2509f7e59a99ad926df4e1`
(34,644,096 bytes). Raw JSONL, the canonical run plan, the bootstrap report and
the per-run logs are under
`/root/.cache/touchai-verify/710/perf-20261101/` (`raw/formal/`,
`run-plan.json`, `stats.json`, `summary.md`, `samples.csv`). The successful
smoke evidence remains separately under `smoke/`.

The formal runs used A/B/B/A arm order and serial systemd cgroup execution with
`MemoryHigh=1700M MemoryMax=2200M MemorySwapMax=2000M CPUQuota=150% Nice=10`.
The two release builds took 29m09s and 29m02s (58m11s total); their cgroup
memory peaks were about 1702.0 MiB, with swap peaks 1,534.8 MiB and 1,510.2 MiB.
The 76 formal run records took 5h44m51s in aggregate; the maximum run cgroup
memory peak was 1,813,204,992 bytes (about 1,729.2 MiB) and the maximum run
swap peak was 2,000 MiB. No synthetic timing or memory value replaces the raw
measurements.

### Independent host re-verification (Daytona, 2026-11-01/02)

The 3.6 GiB local host could not distinguish a product regression from
WebKitGTK/JavaScriptCore instability at 1,000-1,500 messages. The same release
binaries were therefore re-run in a Daytona container with an 8 GiB memory
limit, 4 vCPU (AMD EPYC 9254) and WebKitGTK 2.54.0. This is supplementary
evidence for host sensitivity. It does not replace the local formal record
above, and it is not a project CI run.

The 20-block run has 129 app runs: 128 succeeded and one WebDriver failure is
retained. Gated rows:

| Flow / metric | Ratio [95% CI] | Status |
| --- | --- | --- |
| Progress-write steady-state PSS | 0.9587x [0.9039, 0.9813] | PASS |
| Long-session 100 retained total PSS | 1.0191x [0.9879, 1.0236] | PASS |
| Long-session 500 retained total PSS | 1.0231x [0.9996, 1.0348] | PASS |
| Long-session 1,000 retained total PSS | 1.0177x [1.0041, 1.0360] | PASS |
| Long-session 100/500/1,000 retained DOM nodes | 1.0015x / 1.0003x / 1.0002x | PASS |
| Streamed task loop, cold P50 | 0.9438x [0.7891, 1.3989] | FAIL |
| Streamed task loop, cold P95 | 1.0049x [0.8066, 1.1318] | FAIL |
| Streamed task loop, warm P50 | 0.9559x [0.9105, 0.9954] | PASS |
| Streamed task loop, warm P95 | 0.9717x [0.9480, 1.0139] | PASS |

The local long-session 100 and 1,000 failures do not reproduce on the larger
host: every long-session point estimate is inside 5%, the long-session gates
pass, and the retained DOM counts are effectively unchanged. The remaining
Daytona failure is cold first-prompt latency, where the point estimates are at
or below baseline but the interval is too wide to prove the 5% budget. That is
an underpowered/noisy measurement result, not evidence that the current tree is
slower. The 1,500-message level remains a local diagnostic with no valid
samples; it is not silently promoted to a pass.

Two harness defects surfaced during the Daytona runs:

- `startNewSession()` reused the editor's cached WebDriver element. After the
  node was recreated, WebKitWebDriver could hang on `elementClick` for five
  minutes and drop the driver connection. The failed record
  `progress-b3-s2-current-1793529438424` is retained under `failures/`, not
  deleted. The harness now focuses the editor through a fresh DOM query.
- The cold sample was taken immediately after launch while the update feed,
  model metadata refresh and tool synchronization were still running.
  `TOUCHAI_PERF_STARTUP_SETTLE_MS` (default 8 s; 12 s in the rerun) now lets
  startup-only work finish symmetrically in both arms.

The harness also falls back to a direct child process when `systemd-run --user`
is unavailable (GitHub-hosted runners), accepts cgroup limit overrides, supports
`--warm-samples 0` for cheap cold-only launches, and lets CI override
`CARGO_BUILD_JOBS`. A local 1-block cold-only smoke with
`TOUCHAI_PERF_DISABLE_CGROUP=1` produced 4/4 successful runs with exactly one
`cold` event per run and no warm events, exercising both the fallback path and
the reduced protocol.

The fixed latency-only rerun (10 blocks, 20 app runs per arm, 40/40 successful)
produced warm P50 0.9884x [0.9447, 1.0257] PASS and warm P95 0.9563x
[0.9421, 0.9796] PASS. Cold P50 was 0.9537x [0.8612, 1.1056] and cold P95 was
1.0499x [0.9060, 1.1275]; both still FAIL the CI-width gate. The settle window
changes the meaning from "launch-to-first-prompt" to "settled-startup first
prompt", so this rerun is recorded separately and does not change the original
cold row to PASS. Under the report logic used for that historical run, its
disabled progress and long-session rows were labelled BLOCKED; the current
report emits NOT_RUN for disabled flows. Those flows are covered by the 20-block
run above.

The cold result is statistically underpowered for a 5% non-inferiority gate:
adjacent baseline/current pairs in the fixed 10-block rerun ranged from 0.50x to
1.74x. The expanded cold-only rerun (20 blocks, 40 app launches per arm,
80/80 successful) produced cold P50 1.0667x [0.8086, 1.2800] FAIL and cold P95
0.9570x [0.8934, 1.0278] PASS. Its 20 block-level ratios had median 1.033,
p10 0.659, p90 1.342, min 0.648 and max 1.651; its 40 adjacent baseline/current
pair ratios had median 1.032, p10 0.607, p90 1.697, min 0.417 and max 2.546.
The protocol was intentionally cold-only, so its warm, progress-write and
long-session rows were BLOCKED by construction under the historical report
logic; those flows remain covered by the mixed-protocol run above.
An exploratory pooled analysis of the two fixed-settle reruns (60 launches per
arm) gave cold P50 0.9886x [0.8842, 1.1435], still outside the gate; it is not
the official result because it combines reruns rather than one planned sample.
The P50 point estimate has moved from 0.9537x to 1.0667x, so the evidence does
not establish a stable product regression, but it also cannot establish
non-inferiority. Closing that gate needs a lower-variance measurement design or
an explicitly approved redefinition of the cold metric - not more launches at
the same noise level and not a lowered threshold. No performance gate was added
to `.github/workflows/ci.yml`; the only new required job is the architecture
gate.
The canonical performance path is `.github/workflows/perf-nightly.yml`, running
on GitHub-hosted `ubuntu-24.04` only. It builds both release arms, installs
WebKitWebDriver/Xvfb plus `dbus-x11`, `dunst`, `openbox` and `wmctrl`, and gives
each launch a private X display, DBus session, notification daemon and window
manager. This prevents a missing notification service from corrupting the run
and makes `windowFocused`/`appFocused` represent a real managed desktop window.
The workflow supports `cold-latency`, `steady-state-memory` and `full` scopes.
The cold protocol uses `--warm-samples 0` and 60 paired A/B/B/A blocks (240 app
launches). The steady-state protocol uses three paired blocks for progress and
six paired blocks for each long-session history level 100/500/1000; a
memory-only run therefore executes 84 app runs, and a full run executes 324.
The earlier three-block memory result is retained as historical evidence, but
is not the canonical CI sample size because a single noisy block can widen a
three-cluster 95% interval past the unchanged 1.05 upper bound. Scheduled runs
use the full scope; manual and `perf:rfc710` PR runs select a scope explicitly.
Every protocol records invalid-run reasons, excludes invalid samples from the
gate, and uploads raw JSONL plus bootstrap evidence.

The formal GitHub-hosted acceptance results are:

| Flow / metric | Baseline | Current | Ratio [95% CI] | Status |
| --- | ---: | ---: | --- | --- |
| Cold Enter-to-DOM P50 | 2,395.5 ms | 2,324 ms | 0.9702x [0.9526, 0.9811] | PASS |
| Cold Enter-to-DOM P95 | 2,603.3 ms | 2,521.1 ms | 0.9684x [0.9258, 0.9809] | PASS |
| Progress-write steady-state PSS | 1,435,689 KiB | 1,370,218.5 KiB | 0.9544x [0.9523, 0.9562] | PASS |
| Long-session 100 retained total PSS | 990,227.5 KiB | 992,805 KiB | 1.0026x [0.9918, 1.0488] | PASS |
| Long-session 500 retained total PSS | 1,131,150 KiB | 1,129,004.5 KiB | 0.9981x [0.9942, 1.0069] | PASS |
| Long-session 1000 retained total PSS | 1,328,808 KiB | 1,334,210 KiB | 1.0041x [0.9838, 1.0455] | PASS |
| Long-session 100 retained DOM | 1,986 | 1,989 | 1.0015x [1.0015, 1.0015] | PASS |
| Long-session 500 retained DOM | 9,586 | 9,589 | 1.0003x [1.0003, 1.0003] | PASS |
| Long-session 1000 retained DOM | 19,086 | 19,089 | 1.0002x [1.0002, 1.0002] | PASS |

The cold run recorded 240/240 valid launches and zero notification failures;
the memory run recorded 48/48 valid runs and zero notification failures. The
cold run was made at `376d1fb9`. The later `64514c9a` and `7be0fcdc` commits only
expanded workflow scope selection and removed exited-process zero samples from
memory statistics; the memory acceptance was re-run at final code commit
`7be0fcdc`. No product source or gate threshold changed after the cold run.

The workflow is scheduled, manually dispatchable, and can also be triggered by
the `perf:rfc710` label on a pull request. It is not yet a required
branch-protection check, but it is not observational in the “always green”
sense: invalid samples or a failed enabled gate make the job fail. No
self-hosted runner or Daytona sandbox is required or used for acceptance.

Evidence:

- GitHub Actions cold-latency run:
  [41445842343](https://github.com/TouchAI-org/TouchAI/actions/runs/41445842343),
  artifact `rfc710-cold-latency-41445842343`.
- GitHub Actions steady-state-memory run:
  [41497330849](https://github.com/TouchAI-org/TouchAI/actions/runs/41497330849),
  artifact `rfc710-performance-41497330849`.
- GitHub Actions upload-path smoke:
  [41435911731](https://github.com/TouchAI-org/TouchAI/actions/runs/41435911731),
  12/12 valid launches and zero notification failures.
- Local formal run: `/root/.cache/touchai-verify/710/perf-20261101/`.
- Daytona 20-block mixed-protocol run:
  `/root/.cache/touchai-verify/710/perf-daytona-20261101/`
  (archive SHA-256 `e071e63bd42d7f219971b23eb0877b8c93a55f3951a8bf4f598d33bcca3f986d`).
- Daytona fixed-latency run:
  `/root/.cache/touchai-verify/710/perf-daytona-latency-fixed-20261101/`
  (archive SHA-256 `cf4680e333e650b4ba9151bd3f4d3771cf925edaa928a7f0beee597d06253f65`;
  harness SHA-256 `80f0b0660316118936b14f68a38aa3e4c193e3ec074ecab72cda8c0c9f8b21f9`).
- Daytona cold-only 20-block run:
  `/root/.cache/touchai-verify/710/perf-daytona-coldonly-20block-20261101/`
  (archive SHA-256
  `ff0651e940a8880ead9803bcd2988afa1923a019d92563633eb972654f1df475`;
  333 evidence files and 7 source-asset hashes verified locally).
  All Daytona archives intentionally exclude `binaries/` and `fixtures/`;
  their source-side hashes are in `SOURCE_ASSET_SHA256SUMS.txt`.

## Invariants (must not change)

- Unlimited tool-loop iterations; **no** added iteration or time cap.
- **No** database schema change: no tables/columns/indexes/triggers/migrations, no `db:generate`, no persisted JSON/blob shape change, no retention/deletion/backfill change. Existing serialized settings/messages/attempts/checkpoint summaries/backups stay compatible.
- **No** CSP, capabilities, filesystem/HTTP scope, tool allowlist or shell-approval widening. External content is data.
- Existing checkpoint DB serializer preserved; main-host ownership limited to the current application lifetime; no durable operation journal.
- No new logging of prompts, credentials or content.

## Downstream verification responsibilities

- Implementation (DeepSeek subagent, this worktree): completed the phased code,
  behavior tests, integration and documentation updates without leaving the
  #710 worktree.
- Independent verification (separate DeepSeek subagent, same worktree):
  completed focused Settings regression, full `pnpm test:pr`, Rust/IPC tests,
  static gates, full `pnpm test:e2e` and Rust coverage. It used no `tauri dev`,
  kept artifacts outside the repository, reused shared Rust roots and bounded
  heavy commands with a transient cgroup.
- GitHub Actions performance acceptance is complete. The cold run at
  `376d1fb9` passed both gated cold rows with 240/240 valid launches. The final
  memory run at `7be0fcdc` passed progress steady-state PSS, all three
  long-session retained-PSS rows, and all three retained-DOM rows with 48/48
  valid runs. Earlier local and Daytona failures are retained only as
  historical evidence. Rust coverage passed the configured floors; branch
  coverage was not collected, and the 85% aspiration remains unmet. No failure
  is hidden by lowering a gate or deleting a scenario.

## Environment snapshot (local final, 2026-11-02)

- Node `v24.22.1`, pnpm `10.32.1`, rustc/cargo `1.99.1` with LLVM `23.1.1`,
  cargo-llvm-cov `0.9.1`, `gh 2.46.0`, git `2.47.3`; `tauri-driver` is present.
- RAM 3.6 GiB total / about 2.2 GiB available during the final performance run,
  4 cores, 8 GiB swap. Regenerable check/desktop-build/coverage caches were
  reclaimed after verification; `/` has about 7.9 GiB free with successful and
  failed evidence retained. The shared `/root/.cache/touchai` test target is
  retained and has been used for incremental verification.
  `/root/build/touchai-target` is absent.
- `node_modules` is installed in this worktree.
- Rust coverage used `/root/build/touchai-coverage`; evidence is under
  `/root/.cache/touchai-verify/710/coverage-20261101/`. The generated
  `apps/desktop/src-tauri/coverage.json` was moved outside the repository, so
  no coverage artifact remains in the worktree.
- Implementation commits `5b0da593`, `5174b9ed`, `376d1fb9`, `64514c9a` and
  `7be0fcdc` are pushed to
  `ssh/t3/710-architecture-ownership-design` and draft PR #733. The branch was
  synchronized with `main` at
  `379543a917737f71eac0c4024bb40d999398feff`; the merge commit records that
  synchronization.
- Main workspace `/root/project/TouchAI` was not used for RFC #710 edits. Local
  data directories (`/root/project/TouchAI/data`, `apps/desktop/data`) do not
  exist; no real user DB was used.
- GitHub-hosted performance runners were `ubuntu-24.04`, image
  `20261026.354.1`, 4 vCPU, 16,760,344,576 bytes RAM, WebKitGTK
  `2.52.6-0ubuntu0.24.04.1`, kernel `7.0.0-1017-azure`. The workflow owns the
  display, DBus, window-manager and notification-daemon lifecycle and records
  invalid samples instead of silently dropping them.
- Daytona re-verification container: cgroup limit 4 vCPU / 8 GiB, WebKitGTK
  2.54.0, AMD EPYC 9254 host CPU. Evidence was downloaded and checksum-verified
  before the sandbox was stopped. It remains stopped and is historical evidence,
  not part of the acceptance path.
