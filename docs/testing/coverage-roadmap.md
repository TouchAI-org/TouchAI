# Coverage roadmap

Target: **85% on every measured metric** for both the frontend and Rust.

This page exists because reaching 85% is not one change. It is a sequence of scoped PRs, each
raising the committed floor and leaving it higher than it found it. Read
[testing.md](./testing.md#coverage) first for the rules the floor enforces.

## Where we are

Measured on `main` after #594 and #598 landed.

| Area | Metric | Now | Floor | Target |
| --- | --- | ---: | ---: | ---: |
| Frontend | Lines | 75.8% | 75% | 85% |
| Frontend | Statements | 75.3% | 75% | 85% |
| Frontend | Functions | 74.2% | 74% | 85% |
| Frontend | Branches | 65.2% | 65% | 85% |
| Rust | Lines | 45.5% | 44% | 85% |
| Rust | Regions | 44.2% | 43% | 85% |

The floors are one-way ratchets. Raise them with `pnpm test:coverage:raise` or
`pnpm test:coverage:rust:raise` in the same PR that earns the increase; never edit a floor down.

## The hard constraint

**No test may exist only to move a number.** Concretely, a test is not acceptable if:

- its assertions are entirely about mocks, spies, or call counts rather than an observable outcome;
- it would still pass if the behavior under test were deleted, as long as the call shape stayed
  the same;
- it restates the implementation, so a safe refactor behind the same public contract breaks it;
- it proves a line executed without proving anything a user or caller can observe.

This constraint is what makes the Rust target hard, not laziness. See the next section.

## Rust cannot reach 85% through unit tests

Of the 11043 lines measured by `cargo llvm-cov`, the coverage that unit tests can honestly reach
tops out near **50%**. The remaining lines sit behind OS and network boundaries:

| Area | Lines | Uncovered | Notes |
| --- | ---: | ---: | --- |
| Browser / CDP automation | 2685 | 59% | needs a real browser process |
| Window shell | 1652 | 61% | needs a real window manager |
| Clipboard | 1113 | 61% | needs a real OS clipboard |
| Bootstrap / IO | 852 | 79% | process wiring, paths, logging |
| MCP client | 585 | 97% | needs a server to talk to |
| Updater | 1112 | 36% | needs network responses |
| Global shortcut | 477 | 35% | needs an OS-level hotkey |
| Pure logic | 1179 | 57% | **the only part unit tests can cover** |
| Database runtime | 1388 | 21% | mostly covered already |

Covering every testable pure-logic line would land Rust at about 50.0%. Everything above that has
to come from tests that exercise the real boundary — integration tests through `tauri::test`,
tests against a real SQLite database, and desktop E2E — because the alternative is a test that
asserts a mock was called, which is the one thing this project forbids.

So the Rust path is slower and more expensive than the frontend path. That is expected, not a
reason to lower the target; it is a reason to sequence the work.

## Planned sequence

Each item is one PR, one issue, one raised floor.

### 1. Frontend services: the largest honest gaps

The biggest uncovered files are real business logic with observable outcomes, so they can be
covered properly.

| File | Uncovered lines | Current |
| --- | ---: | ---: |
| `src/services/AgentService/task/center.ts` | 190 | 6.9% |
| `src/services/AgentService/task/projection/projection.ts` | 154 | 56.4% |
| `src/services/AgentService/execution/runtime.ts` | 109 | 12.8% |
| `src/services/AgentService/infrastructure/providers/ai-sdk/base.ts` | 103 | 30.4% |
| `src/services/AgentService/outputs/persistence.ts` | 93 | 63.1% |
| `src/services/AgentService/infrastructure/providers/reasoning/formats.ts` | 80 | 50.9% |
| `src/services/AgentService/infrastructure/attachments/storage.ts` | 59 | 29.8% |
| `src/services/AgentService/infrastructure/attachments/inspect.ts` | 51 | 16.4% |

`task/center.ts` and `execution/runtime.ts` are wiring singletons; cover them by driving a real
turn through the executor and asserting the user-visible result, not by asserting internal
collaboration.

Expected: frontend lines and statements into the low 80s.

### 2. Frontend views: `useSearchPage` and the search surface

| File | Uncovered lines | Current |
| --- | ---: | ---: |
| `src/views/SearchView/composables/useSearchPage.ts` | 161 | 62.7% |
| `src/views/SearchView/components/SearchBar/utils/tiptap.ts` | 142 | 47.0% |
| `src/views/SearchView/components/AskUser/AskUserQuestions.vue` | 107 | 56.3% |
| `src/views/SearchView/components/ConversationPanel/components/ToolCallItem.vue` | 85 | 47.2% |
| `src/views/SettingsView/components/General/GeneralShortcutSettings.vue` | 54 | 63.5% |

Expected: frontend lines and statements at or above 85%.

### 3. Branches: the lagging frontend metric

Branches sit at 65.2% while lines are near 76%, a 10-point gap. Closing it needs tests that drive
the untaken arm of each conditional — error paths, empty states, cancellation, retry — not more
happy-path tests. This is likely two PRs on its own.

### 4. Rust integration coverage

Move the boundary categories above from "untestable in unit tests" to "tested at the boundary":

- `tauri::test` for command parameter parsing, state wiring, and return shapes.
- The real SQLite harness for persistence paths.
- Real process spawning for the clipboard and bash-adjacent paths where a test-owned temp
  environment is enough, instead of mocking the OS call.

Expected: Rust lines from 45% toward 55-60%.

### 5. Desktop E2E expansion

The only honest way to cover window management, popup dispatch, tray behavior, and the browser
tool. Each E2E flow that exercises a real window also covers the Rust lines behind it.

Expected: this is where Rust moves past 60%, and it is the long pole.

### 6. Rust branch coverage, if we decide to pay for it

`cargo llvm-cov --branch` needs a nightly toolchain in the `rust-coverage` job. The summarizer
already renders a Branches row when a branch-enabled run feeds it one, so this is a toolchain
change in one job plus a floor entry — not a script change. Decide only after line and region
coverage are healthy; branch coverage on a poorly covered codebase mostly measures nothing.

## Definition of done for the target

- Frontend: all four metrics at 85% or above, floors raised to match.
- Rust: lines and regions at 85% or above, floors raised to match.
- No floor was ever lowered to get there.
- No test was added that would pass against a deleted implementation.

## Tracking

- #594 — policy, test cleanup, and the first coverage gates (landed).
- #598 — cargo-llvm-cov replacing tarpaulin (landed).
- Follow-up issues are filed per item above, in sequence, each raising its floor.
