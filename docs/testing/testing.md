# Testing Guide

Guidelines for writing and maintaining tests in the TouchAI codebase.

## Principles

1. **One behavior per test.** Each test has exactly one reason to fail.
2. **Control all nondeterminism.** Time, timers, randomness, temp dirs, and network responses must be test-controlled.

The rest of this page expands on two rules: assert behavior, not implementation; and mock only at system boundaries.

## Behavior, not implementation

A test asserts what a user or caller can observe: a return value, a state change, an emitted event, a visible DOM node, a persisted row. It never asserts how the code gets there.

**Decision rule: if you rewrite the implementation behind the same public contract and the test still passes, it was testing behavior. If it breaks, it was testing implementation.**

```ts
// Right: survives any rewrite of the billing path, and fails on a real double charge
it('user is not charged twice when the same order is submitted twice', async () => {
    await submitOrder(order);
    await submitOrder(order);

    expect(await chargesFor(order)).toHaveLength(1);
    expect(await balanceOf(customer)).toBe(initialBalance - orderTotal);
});

// Wrong: encodes one call sequence, passes while the user is double-charged elsewhere
it('calls processPayment once', async () => {
    await submitOrder(order);

    expect(processPayment).toHaveBeenCalledTimes(1);
});
```

## BDD and TDD

Write the acceptance scenario before the test, the test before the code.

1. **Scenario.** In the issue or PR, state the Given context, the When action, the Then outcome. A user or PM must be able to read it. If you cannot write it, the requirement is not understood.
2. **Red.** Write a failing test for that scenario.
3. **Green.** Write the minimum code to pass it.
4. **Refactor.** Clean up with the tests green, then run `pnpm test:pr`.

Exceptions: exploratory spikes, pure layout tweaks, config changes. Say why in the PR.

## Running Tests

```bash
pnpm test              # Vitest watch mode (development)
pnpm test:unit         # Single run (CI mode)
pnpm test:ci           # Repository workflow, dependency, and design guard contract tests
pnpm test:coverage     # Run with frontend coverage report
pnpm test:e2e          # Desktop E2E smoke (requires tauri-driver)
pnpm site:build        # Build the Astro Starlight site
pnpm test:pr           # Full PR gate (quality checks + all tests + frontend coverage)
pnpm check             # Quality checks only (type, lint, format, Rust)
```

For Rust:

```bash
pnpm test:rust                          # Run Rust tests
pnpm test:coverage:rust                 # Run Rust tests with coverage (requires cargo-llvm-cov)
```

CI runs both coverage gates on every desktop change: frontend in `frontend-tests`, Rust in `rust-coverage`. Each publishes a table to the step summary, and each failure blocks the required `CI Required` check.

## Coverage

A floor that stops regressions, not a target to game. A test added only to raise a number is noise: it still has to encode an observable behavior. **The floor never goes down. The goal is 85% on every metric.** Get there by covering real behavior, never by asserting on mocks or restating the implementation.

Frontend floor in `apps/desktop/vitest.config.ts`:

| Metric | Floor | Now | Target |
| --- | ---: | ---: | ---: |
| Statements | 90% | 91.0% | 85% |
| Branches | 84% | 84.9% | 85% |
| Functions | 88% | 88.8% | 85% |
| Lines | 91% | 91.5% | 85% |

Statements, functions and lines are past the 85% target. Branches sit just under it: what remains are guards that cannot be reached from outside their module (dead code, base-class defaults that every adapter overrides, and nullish fallbacks behind columns already wrapped in `coalesce`). Those are reported rather than faked with tests that would pass with the implementation deleted.

The keys must stay at the top level of `thresholds`. A nested `global` object is read as a glob pattern matching no file, which leaves the gate silently inert.

**Raising is one-way.** Run `pnpm test:coverage:raise` after a change that earns it; it is vitest's `thresholds.autoUpdate`, which rewrites a metric only when the measured value exceeds it. Run it on the full suite, not a filtered subset, or it ratchets to the subset. It also rewrites the per-file thresholds to exact measured values with no headroom, so raise the global floor by hand when the per-file numbers should keep their slack.

**The floor alone is not enough for a pull request.** A global percentage cannot see a change that adds 400 uncovered lines while covering 400 old ones: the total stays flat and the gate stays green. So the `frontend-tests` job also runs a **patch coverage** check (`scripts/ci/coverage/patch-coverage.mjs`), which takes the lines the diff added to `apps/desktop/src` and asks the v8 report how many of them ran. It fails below **85%**.

- A changed source file that no test ever loaded counts as fully uncovered, which is the point: new behaviour has to arrive with a test that exercises it.
- Only files the report can contain are measured: `apps/desktop/src/**/*.{ts,vue}`, mirroring `coverage.include`. A generated snapshot, a stylesheet or an asset under `src` is skipped instead of counting as uncovered, because it can never appear in the v8 report.
- Blank lines, comments and closing braces carry no statement, so they are skipped rather than counted as failures.
- Deleted lines, test files and scripts are out of scope.
- Run it locally with `pnpm test:coverage:patch` after `pnpm test:coverage`.
- The floor lives in the workflow step, not in a config file, because it is a policy number rather than a measured one.

Rust floor in `apps/desktop/src-tauri/coverage-floors.json`, from **cargo-llvm-cov** (rustc's own `-C instrument-coverage`, not a ptrace debugger). It reports line and region coverage; region is the finer signal because it flags an expression that was only partly evaluated.

| Metric | Floor | Now | Target |
| --- | ---: | ---: | ---: |
| Lines | 61% | 61.4% | 85% |
| Regions | 62% | 62.3% | 85% |

The `rust-coverage` job fails with the exact metric that regressed. Raise with `pnpm test:coverage:rust:raise`. Same one-way rule.

**Why Rust starts lower.** Of its 11043 measured lines, covering every testable pure-logic line tops out near 50% total. The rest sits in browser/CDP, window-shell, clipboard, bootstrap and MCP client code, whose only realistic unit test asserts against mocks. So Rust rises with integration and E2E coverage, not with mock-heavy unit tests. Do not close the gap by testing stubs.

**What cannot be covered, and how to tell.** Some lines will never show up as covered. Before adding a test for one, check which of these it is:

| Kind | Example | How to tell |
| --- | --- | --- |
| Native handle required | `reset_search_window_bounds`, `resize_window_height` | Fails under `tauri::test` with `0x80070578` (invalid window handle). Reach it from E2E, not a unit test. |
| Platform split | `src/core/search/mod.rs` | The uncovered half is behind `#[cfg(windows)]`; Linux CI runs the other half. Not a gap. |
| Needs a live peer | MCP connect, updater, `autostart` | Requires a server, a release feed, or a real OS autostart entry. Cover the pure part, and say what remains. |

Two boundaries look testable but are not:

- `core/system/autostart.rs` only wraps the autostart plugin. Its error branches fire when the OS refuses, which cannot be produced on demand.
- `core/mcp/client_manager.rs` is testable up to the point of connecting. The unknown-id answers, the empty-manager answers and the missing-command/missing-url validation are reachable; anything past `connect_*` needs a live server.

Do not write an assertion that passes without proving anything just to cover one of these. Report it instead.

Rust branch coverage is **not** collected: `--branch` needs nightly, and this job runs stable. The summarizer renders a Branches row when a branch-enabled run feeds it one, so enabling it later is a toolchain change in that job, not a script change. cargo-tarpaulin was replaced by llvm-cov in #598; its branch support was never implemented, so the dimension had never been measurable.

- Per-file thresholds in `vitest.config.ts` are the enforced contract; do not lower one to land a change.
- New modules start at the minimum in [Test Layers](#test-layers) and keep it.
- A line covered only by an interaction assertion does not count as covered behavior.

## File Placement

```
tests/ci/
├── workflows/             # Workflow and CODEOWNERS contracts
├── repository/            # Lockfile and dependency policy contracts
└── design-system/         # ESLint design-system guard contract
apps/desktop/tests/
├── setup/                  # Vitest global setup, Tauri mocks
├── utils/                  # Shared test helpers and fixtures
├── services/               # Service tests (PopupService/, EventService, NativeService)
├── composables/
│   └── SearchView/         # SearchView composable tests
└── SearchView/             # SearchView view-level tests (windowSizing, utils)

apps/desktop/e2e-tests/     # Desktop E2E (WebDriverIO)

apps/desktop/src-tauri/tests/ # Rust integration / command tests
```

- Frontend tests: `apps/desktop/tests/**/*.test.ts`, mirroring the `src/` structure (`src/services/PopupService/manager.ts` → `tests/services/PopupService/manager.test.ts`)
- Repository CI tests: `tests/ci/**/*.test.ts`. Workflow and CODEOWNERS contracts live in `tests/ci/workflows/`; lockfile policy in `tests/ci/repository/`; ESLint design-system guards in `tests/ci/design-system/`. A test that imports `apps/desktop/scripts/**` stays in `apps/desktop/tests/ci/`, because it covers desktop build or release tooling.
- Desktop E2E: `apps/desktop/e2e-tests/**/*.e2e.js`
- Rust unit tests: `#[cfg(test)]` within the module
- Rust integration tests: `apps/desktop/src-tauri/tests/**/*.rs`

## Test Layers

**Frontend logic.** Test via inputs, outputs, and state transitions; mock only Tauri IPC and external APIs. Minimum for a new module: one happy path, one edge case, one error path.

**Vue components.** Test through the public interface: props, emits, visible DOM, user interactions. Never assert internal reactive variables or watcher counts. Minimum: one render, one core interaction, one error or disabled state.

**Rust logic.** Assert state transitions, not log output. Drive state machines with real inputs; do not mock helpers in the same module. Minimum: one happy path, one boundary value, one error branch.

**Tauri commands.** Use `tauri::test` for parameter parsing, state wiring, and return shapes. One clear contract per test; do not re-cover lower-level logic.

**Desktop E2E.** Critical cross-layer flows only (launch, search, settings). Do not use E2E for logic unit tests already cover reliably.

**Visual regression.** Component primitives (`pnpm test:visual`) and application windows (`pnpm test:e2e`) are compared against committed PNG baselines in CI; regenerate an intended difference with `/approve-visuals` on the pull request.

## Naming Tests

Every test is a user story in Given / When / Then form, readable by a user or PM without opening the source.

- The `describe` block names the **Given** context.
- The `it(...)` description begins with the lowercase word `user`, then names the **When** action and the **Then** outcome.
- No test name contains an internal symbol name, a function name, or a file name.

```ts
describe('user submits a prompt', () => {
    // Given the editor holds text and no request is running
    it('user sees the prompt sent when pressing Enter', async () => {
        // ...
    });

    it('user sees an inline error when the request fails', async () => {
        // ...
    });
});
```

Nested `describe` blocks carry the narrower Given context; the `it(...)` still starts with `user`.

```ts
describe('user edits a saved model', () => {
    describe('given the API key field is empty', () => {
        it('user sees the save action disabled', () => {
            // ...
        });
    });
});
```

Renaming an existing test: keep the behavior, drop the internals. `it('calls onSubmit with the payload')` becomes `it('user sees the prompt sent when pressing Enter')` under `describe('user submits a prompt')`.

Rust follows the same rule in snake_case: `#[test] fn user_sees_prompt_sent_when_pressing_enter()`.

## Mocking

Mock at system boundaries only: `@tauri-apps/api/mocks` for Tauri IPC, `tauri::test` for Rust commands, Vitest fake timers for timers. Do not mock your own pure functions or strategy objects, and never mock an internal helper just to assert it was called. If a module needs heavy mocking to test, it needs refactoring first.

## Assertion Priority

Prefer, in descending order: return values, observable state changes, emitted public events, visible DOM, boundary contract (IPC args/shape).

Interaction assertions (call counts, call order) are allowed only when the call itself is a public contract and omitting it would make the behavior unverifiable.

## Error Testing

Do not just assert that an error is thrown. Also verify the error type or message is stable, state is rolled back, and subsequent inputs still work.

## PR Checklist

- [ ] The acceptance scenario is in the issue or PR, and the tests implement it.
- [ ] A rewrite behind the same public contract would keep these tests green.
- [ ] Names start with `user`, give the Given context, the When, and the Then, with no internal symbol, function, or file name.
- [ ] Without these tests, a real regression would go undetected.
- [ ] This could not be tested at a cheaper, more stable layer.
- [ ] Mocks are limited to system boundaries.
- [ ] Happy path, edge case, and error path are covered.
- [ ] `pnpm test:pr` passes.
