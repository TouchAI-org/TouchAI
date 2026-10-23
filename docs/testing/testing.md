# Testing Guide

Guidelines for writing and maintaining tests in the TouchAI codebase.

## Principles

1. **Test behavior, not implementation.** Assert observable outcomes (return values, state changes, emitted events, visible DOM), not internal method calls or private variable values. See [Behavior, not implementation](#behavior-not-implementation).
2. **One behavior per test.** Each test should have exactly one reason to fail.
3. **Prefer state and output assertions** over interaction (call-count) assertions.
4. **Use real code paths where possible.** Only mock at system boundaries (Tauri IPC, network, OS). Never mock your own pure functions or local strategy objects.
5. **Control all nondeterminism.** Time, timers, randomness, temp dirs, and network responses must be test-controlled.

## Behavior, not implementation

A test asserts what a user or caller can observe: a return value, a state change, an emitted event, a visible DOM node, a persisted row. It never asserts how the code reaches that outcome.

The decision rule: **if you rewrite the implementation behind the same public contract and the test still passes, the test is right; if the test breaks, it was testing implementation.**

```
// Good -- the user-visible outcome, which survives any rewrite of the billing path
it('user is not charged twice when the same order is submitted twice', async () => {
    await submitOrder(order);
    await submitOrder(order);

    expect(await chargesFor(order)).toHaveLength(1);
    expect(await balanceOf(customer)).toBe(initialBalance - orderTotal);
});

// Bad -- encodes one internal call sequence and breaks on a safe refactor
it('calls processPayment once', async () => {
    await submitOrder(order);

    expect(processPayment).toHaveBeenCalledTimes(1);
});
```

The bad test passes while the customer is double-charged through a second code path, and fails when a refactor moves the same charge behind a different function. Assert the balance and the charge list; the method name and call count are not the contract.

## BDD and TDD

**BDD comes first.** Write the acceptance scenario before the test, and the test before the code.

1. **Acceptance scenario.** In the issue or PR, state the scenario a user or PM can read: the Given context, the When action, the Then outcome. This is the shared definition of done; a scenario that cannot be written means the requirement is not understood yet.
2. **Red.** Write a failing test that expresses that scenario.
3. **Green.** Write the minimum code to make the test pass.
4. **Refactor.** Clean up the code while keeping tests green.

Workflow:

- Write the acceptance scenario for the expected behavior (happy path, edge case, error path).
- Turn each scenario into a failing test named in the [naming convention](#naming-tests).
- Run `pnpm test` (watch mode) and confirm the test fails.
- Implement the code until the test passes.
- Refactor, then run `pnpm test:pr` to verify full quality gate including coverage.

Exceptions: exploratory spikes, pure UI layout tweaks, or configuration changes where the behavior is better verified manually. In these cases, explain why BDD and TDD were not followed in the PR.

## Running Tests

```bash
pnpm test              # Vitest watch mode (development)
pnpm test:unit         # Single run (CI mode)
pnpm test:coverage     # Run with frontend coverage report
pnpm test:e2e          # Desktop E2E smoke (requires tauri-driver)
pnpm site:build        # Build the Astro Starlight site
pnpm test:pr           # Full PR gate (quality checks + all tests + frontend coverage)
pnpm check             # Quality checks only (type, lint, format, Rust)
```

For Rust:

```bash
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
pnpm test:rust                          # Run Rust tests
pnpm test:coverage:rust                 # Run Rust tests with coverage (requires cargo-tarpaulin)
```

CI runs both coverage gates on every desktop change:

- Frontend coverage in the `frontend-tests` job: `pnpm test:coverage`, summarized from `coverage-summary.json`, uploaded as `frontend-coverage-report`.
- Rust coverage in the `rust-coverage` job: `pnpm test:coverage:rust` (cargo tarpaulin), summarized from the cobertura XML, uploaded as `rust-coverage-report`.

Each report is summarized in the GitHub step summary, and each failure blocks the required `CI Required` check.

## Coverage

Coverage is a floor that stops regressions, not a target to game. A test added only to raise a number is noise: it still has to encode a behavior a user or caller can observe.

Frontend coverage is enforced in `apps/desktop/vitest.config.ts` as a global floor:

| Metric | Floor | Reached today |
| --- | ---: | ---: |
| Statements | 75% | 75.3% |
| Branches | 64% | 65.2% |
| Functions | 73% | 74.2% |
| Lines | 75% | 75.8% |

The floor sits about one point under what the suite reaches, so it blocks a regression without demanding a specific number from any single change. The keys must stay at the top level of `thresholds`: vitest reads the global floor from `thresholds.<metric>`, and a nested `global` object is treated as a glob pattern matching no file, which leaves the gate silently inert.

Rust coverage runs in CI as a report, not a gate: it has no threshold yet, so a drop there is visible in the job summary but does not fail the build.

- Per-file thresholds in `apps/desktop/vitest.config.ts` are the enforced frontend contract; do not lower one to land a change.
- New modules start at the minimum in [Test Layers](#test-layers) and keep it.
- A line covered only by an interaction assertion does not count as covered behavior.

## File Placement

```
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

- Frontend tests: `apps/desktop/tests/**/*.test.ts`
- Desktop E2E: `apps/desktop/e2e-tests/**/*.e2e.js`
- Rust unit tests: `#[cfg(test)]` within the module
- Rust integration tests: `apps/desktop/src-tauri/tests/**/*.rs`

Mirror the `apps/desktop/src/` directory structure inside `apps/desktop/tests/`. For example, `apps/desktop/src/services/PopupService/manager.ts` is tested in `apps/desktop/tests/services/PopupService/manager.test.ts`.

## Test Layers

### Frontend Logic (composables, services, pure functions)

- Test via inputs, outputs, and state transitions.
- Mock only Tauri IPC and external APIs.
- Minimum coverage for a new module:
  - 1 happy path
  - 1 edge case
  - 1 error/rejection path

### Vue Components

- Test through the public interface: props, emits, visible DOM, user interactions.
- Do not assert internal reactive variables or watcher call counts.
- Minimum: 1 render test, 1 core interaction, 1 error/disabled state.

### Rust Logic

- Assert state transitions, not log output or internal intermediaries.
- Drive state machines with real inputs; do not mock helpers in the same module.
- Minimum: 1 happy path, 1 boundary value, 1 error branch.

### Tauri Commands

- Use `tauri::test` for parameter parsing, state wiring, and return shapes.
- Each command test verifies one clear contract.
- Do not re-cover lower-level logic already tested elsewhere.

### Desktop E2E

- Verify critical cross-layer user flows only (app launch, search, settings).
- Do not use E2E to cover logic that unit tests already express reliably.

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

Migrating an existing name: keep the behavior, drop the internals.

```ts
// Before -- names a component callback and a payload type
it('calls onSubmit with the payload', () => {
    // ...
});

// After -- names the Given context, the When, and the Then outcome
describe('user submits a prompt', () => {
    it('user sees the prompt sent when pressing Enter', () => {
        // ...
    });
});
```

Rust follows the same rule in snake_case: `#[test] fn user_sees_prompt_sent_when_pressing_enter()`.

## Mocking

**Mock at system boundaries only:**

- `@tauri-apps/api/mocks` for Tauri IPC
- `tauri::test` for Rust commands
- Vitest fake timers for `setTimeout`/`setInterval`

**Do not mock:**

- Your own pure functions or strategy objects
- Internal helpers just to assert they were called

If a module requires heavy mocking to test, it likely needs refactoring first.

## Assertion Priority

In descending order of preference:

1. Return values
2. Observable state changes
3. Emitted public events
4. Visible DOM / user-facing output
5. Boundary contract (IPC args/shape)

Interaction assertions (call counts, call order) are allowed only when the call itself is a public contract and omitting it would make the behavior unverifiable.

## Error Testing

Do not just assert that an error is thrown. Also verify:

- The error type or message is stable.
- State is correctly rolled back.
- Subsequent inputs still work after the error.

## PR Checklist

Before submitting a test PR, verify:

- [ ] The acceptance scenario (Given / When / Then) is written in the issue or PR, and the tests implement it.
- [ ] Tests cover behavior, not implementation details: a rewrite behind the same public contract would keep them green.
- [ ] Test names start with `user` and name the Given context, the When, and the Then outcome, with no internal symbol, function, or file name.
- [ ] Without these tests, would a real regression go undetected?
- [ ] Could this be tested at a lower (cheaper, more stable) layer?
- [ ] Mocks are limited to system boundaries.
- [ ] Happy path, edge case, and error path are all covered.
- [ ] Tests pass via `pnpm test:pr` (includes type check, lint, format, unit tests, and coverage).
