# Testing Guide

Guidelines for writing and maintaining tests in the TouchAI codebase.

## Principles

1. **Test behavior, not implementation.** Assert observable outcomes (return values, state changes, emitted events), not internal method calls or private variable values.
2. **One behavior per test.** Each test should have exactly one reason to fail.
3. **Prefer state and output assertions** over interaction (call-count) assertions.
4. **Use real code paths where possible.** Only mock at system boundaries (Tauri IPC, network, OS). Never mock your own pure functions or local strategy objects.
5. **Control all nondeterminism.** Time, timers, randomness, temp dirs, and network responses must be test-controlled.

## Running Tests

```bash
pnpm test              # Vitest watch mode
pnpm test:run          # Single run (CI mode)
pnpm test:coverage     # Run with coverage report
pnpm test:e2e          # Desktop E2E smoke (requires tauri-driver)
```

For Rust:

```bash
cargo check --manifest-path src-tauri/Cargo.toml --all-targets
cargo test --manifest-path src-tauri/Cargo.toml
```

## File Placement

```
tests/
├── setup/                  # Vitest global setup, Tauri mocks
├── utils/                  # Shared test helpers and fixtures
├── services/               # Service tests (PopupService/, EventService, NativeService)
├── composables/
│   └── SearchView/         # SearchView composable tests
└── SearchView/             # SearchView view-level tests (windowSizing, utils)

e2e-tests/                  # Desktop E2E (WebDriverIO)

src-tauri/tests/            # Rust integration / command tests
```

- Frontend tests: `tests/**/*.test.ts`
- Desktop E2E: `e2e-tests/**/*.e2e.js`
- Rust unit tests: `#[cfg(test)]` within the module
- Rust integration tests: `src-tauri/tests/**/*.rs`

Mirror the `src/` directory structure inside `tests/`. For example, `src/services/PopupService/manager.ts` is tested in `tests/services/PopupService/manager.test.ts`.

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

Describe the behavior and condition. A reader should understand the failure from the name alone.

```
// Good
"returns manual override when user drags height outside programmatic resize path"
"replays pending popup payload after popup ready event"
"clears input on Escape when input has text"

// Bad
"test popup"
"works correctly"
"handles case 1"
```

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

- [ ] Tests cover behavior, not implementation details.
- [ ] Without these tests, would a real regression go undetected?
- [ ] Could this be tested at a lower (cheaper, more stable) layer?
- [ ] Mocks are limited to system boundaries.
- [ ] Test names explain the failure reason.
- [ ] Happy path, edge case, and error path are all covered.
- [ ] Tests pass via `pnpm test:run`.
