# Development

Read this when starting a task: how we reason, plan, fix, and test.

## First principles

Reason from facts and constraints, not from habit or from an implementation that may itself be wrong.

1. State the problem in one sentence; separate the symptom from the goal.
2. List the real constraints: platform, data, contracts, compatibility, performance budget, user expectations.
3. Name each assumption and check it against code, docs, upstream behavior, or a measurement. An unverified assumption is a risk, not a requirement.
4. Derive the smallest design that meets the constraints; prefer invariants and explicit contracts over conventions spread across callers.
5. Verify with evidence: a failing-then-passing test, a trace, a benchmark, a migration rehearsal, or a reproduced user flow.

Use it for design, root-cause work, performance budgets, and database decisions. It is not a license to rewrite working code.

## Occam's razor

Choose the simplest solution that meets the verified requirements.

- No new abstraction, service, state machine, dependency, cache, queue, or configuration switch until a real requirement or measurement demands it.
- Prefer deleting code, reusing an existing component, or tightening an existing contract over adding a parallel mechanism.
- When two designs meet the same acceptance criteria, choose fewer moving parts, fewer owners, fewer failure modes.
- Complexity is a cost every future change pays; a shortcut that creates a second source of truth is not simple.
- "Simple" means easy to reason about, not short to write.

## Libraries before hand-rolled code

> Implement with a mature library or framework, especially one already installed, instead of hand-rolling it. Hand-roll only when a significant reason proves it is the better option.

Occam's razor cuts toward the existing library: less code we own, fewer bugs, and behavior the ecosystem already exercises. Hand-rolled code is the larger mechanism, not the smaller one.

Check in this order before writing it yourself:

1. **An installed dependency.** Search `package.json`, `pnpm-lock.yaml`, and `apps/desktop/src-tauri/Cargo.toml`, then read its source under `node_modules` or the vendored crate to confirm the API.
2. **An existing repository utility or service.** Search `apps/desktop/src/utils/`, `apps/desktop/src/services/`, and `apps/desktop/src-tauri/src/` before adding a second implementation.
3. **A mature upstream package.** Apply the new-dependency rules below.

Hand-roll only for a significant reason: the library conflicts with a hard requirement (bundle size, latency, license, platform, CSP), cannot meet an invariant we must own (local-first storage, offline, a security boundary), is unmaintained or vulnerable, or the needed surface is a few lines and the dependency costs more than it saves.

When you hand-roll, say so in the PR risk notes: what you checked, what you rejected, and what breaks if it is wrong. "I did not check" is not a reason.

## Issue and worktree

1. **Issue first.** Classify the work (feature, bug, refactor, docs, RFC, CI/tooling, release). Search existing issues and reuse the matching one; otherwise create one from the repository template with the right labels (`kind:bug`, `kind:feature`, `status:triage`, or an architecture RFC for high-risk work). No code without an issue number; only pure wording, link, or comment-only docs changes may skip this, and only when the user scopes them that way.
2. **Worktree.** Every feature, bug fix, refactor, and similar task uses a fresh worktree, never the main workspace. One worktree, one issue, one PR.

```powershell
git fetch origin
git worktree add .worktrees/<issue-number>-<slug> -b <issue-number>-<slug> main
```

3. **Local data.** Copy the main workspace's `data` directory into the new worktree, including ignored state, unless the user opts out. Report copy failures before coding.
4. **Storage.** Keep heavy build, debug, cache, and temp output out of the repository and off the system drive (`<scratch>/target/<issue>` and `<scratch>/tmp/<issue>`); if no scratch location exists, ask.
5. **Ownership.** A worktree belongs to the session that created it. Never check out, clean, reset, or commit another session's worktree. Preserve unrelated changes; never revert user edits.

## Before writing code

- Read the relevant source in full, not search snippets.
- Read the nearest tests and `docs/testing/testing.md`.
- For `feat` and `fix`, write the acceptance scenario first, then the failing test, then the code. If BDD and TDD do not fit, say why in the PR.
- Keep the diff inside the issue. A side fix gets its own issue and commit.
- If the requirement is ambiguous or touches an RFC-first area, stop and ask.

## Bug fixes

> Fix a bug at its cause, reasoning from first principles and established best practice. Do not patch over the symptom.

1. Reproduce the reporter's exact case on their surface: same provider, model, platform, build, input, and settings.
2. Capture evidence: failing output, trace, log, database row, or screenshot.
3. Add a regression test that fails on current code and passes after the fix.
4. Keep asking why until the answer is a broken invariant, wrong contract, wrong assumption, or missing boundary, not "the value was wrong here".
5. Fix at the owning layer. Fix every affected sibling path in the same change, or file an issue for each one left behind.
6. Read the dependency's real types/source or vendor docs instead of guessing.
7. Remove the cause. No retries, sleeps, catch-and-ignore, broad fallbacks, or weakened tests to hide it.

A red test on `main` is a bug to fix now or a separate issue with evidence, not a baseline.

## Code quality

- TypeScript strict; no `any` unless the boundary needs it and the reason is documented.
- Vue 3 Composition API with existing composable patterns; clean up listeners, observers, timers, and subscriptions on unmount and window close.
- Rust: explicit errors, no `unwrap()` on user input or I/O, no blocking work in async paths without justification.
- Never swallow errors. If a failure changes what the user sees or stores, surface it, log it with context, and define the recovery path.
- Reuse existing utilities and services. Check `node_modules` or crate sources for external API types instead of guessing. See [Libraries before hand-rolled code](#libraries-before-hand-rolled-code).
- New dependencies need a reason, a license check, and lockfile review.
- Logs must not contain API keys, tokens, passwords, full prompts, clipboard contents, or file contents.

## Comments

Comments explain only what the code cannot express, and stay brief. Write them in English.

- Good: the reason for a non-obvious workaround, an invariant a function preserves, the constraint behind a magic value.
- Never: comments restating the code, changelog-style notes about edits, positional markers such as `// here` or `// added in v1.2`, line-number references, or commented-out code. Delete dead code.
- Delete the comment when a name or structure can carry the meaning; prefer renaming or extracting over explaining.

## Testing

| Command | Use |
| --- | --- |
| `pnpm test:pr` | Full PR gate: quality checks, unit tests, Rust tests, frontend coverage, site build |
| `pnpm test:e2e` | Desktop E2E smoke; required for startup, window, search, popup, settings, and E2E harness changes |
| `pnpm test:coverage:rust` | Rust coverage locally; CI runs the same command in the Rust coverage job, so reproduce a CI coverage failure with it |

- BDD then TDD: acceptance scenario first, then the failing test, then the code. Name tests in the `user` + Given / When / Then convention in [testing.md § Naming Tests](../testing/testing.md#naming-tests).
- Test behavior, not implementation: return values, state changes, emitted events, visible DOM. Not private variables or call counts. If a rewrite behind the same public contract keeps the test green, it was testing behavior; if it breaks, it was testing implementation.
- Mock only system boundaries: Tauri IPC, network, OS services.
- Every fix ships a regression test that fails without it; every feature covers happy path, edge case, and error path.
- Frontend tests live under `apps/desktop/tests/`, mirroring `apps/desktop/src/`. Rust unit tests live in `#[cfg(test)]`; Rust integration tests in `apps/desktop/src-tauri/tests/`.
- Control time, timers, randomness, temp directories, and network responses. Tests never touch the real user database or live app configuration.
- A check that was not run is listed as "not run" with the reason. Never claim a command passed when it did not run. Fix a flaky test's cause; do not retry it green.

## Stop and ask

Ask before: any database structure change (see [product-rules.md](./product-rules.md#database)); deleting, rewriting, or irreversibly migrating user data; deploying, publishing, tagging, or changing release configuration; deleting functionality that looks intentional; introducing a new architecture, cross-boundary abstraction, or high-impact dependency; resolving conflicting requirements or overriding a rule in `AGENTS.md`; proceeding when a required check cannot run and the risk is unclear.
