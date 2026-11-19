# RFC 710 E2E acceptance results

Issue: #710. The permanent specifications run the production Tauri application,
main-window Agent Core, Models drivers, Tools pipeline and native SQLite storage.
The additional acceptance code does not change product sources, database schemas,
migrations, native permissions or visual baselines.

## Native coverage

| Specification            | Cases | Observable contracts                                                                                                                                                                         |
| ------------------------ | ----: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent-core.e2e.js`      |     8 | Saved streamed answers; history and real settings-tool continuation; questions; approval and rejection; cancellation with late output; app restart; model endpoint and credential isolation. |
| `agent-tools.e2e.js`     |     3 | Actual MCP discovery and execution; model retry without repeated effects; disconnect after an effect; audit write failure; recovery through a fresh prompt.                                  |
| `data-management.e2e.js` |     7 | Settings statistics; cancelled and confirmed cleanup; real backup; conversation-only and full import; corrupt import rejection and subsequent recovery.                                      |

Final combined native verification on 2026-11-20: **18 passed, 0 failed, 0 skipped**
across all three specifications in one invocation, in **3 minutes 10 seconds**.
WDIO exited 0. The six fixture protocol/health regressions also pass within the
full UI-preview tooling suite: **19 files / 234 tests**.

Repository CI also passes **16 files / 491 tests**. Its TypeScript project,
scoped ESLint, formatting, whitespace and frozen offline lockfile validation
pass. The 15 captured test/configuration/dependency input hashes match the final
validation run; the index remains unstaged.

Each specification gets a fresh application root and database created from the
current migration journal, SQL, seed and guard artifacts. The native application
still performs its ordinary startup. Assertions combine visible UI, independent
SQLite reads and actual model/MCP request or effect observations. Model responses
are scripted only at the external HTTP/SSE boundary. The MCP server uses the
pinned official SDK and records each effect without deduplicating it for the app.

## CI integration and failure detection

The normal `pnpm test:e2e` command now includes these three specifications in
addition to the existing 13 visual/smoke specification files. The existing Windows
workflow builds the candidate application first, uses Node 22 and runs that
command. Its `E2E Required` job checks the native job's outcome. Package changes
already trigger the workflow. Existing visual assertions and baselines remain
registered; no scenario uses a skip, retry-to-green or catch-and-pass path.

The tests wait for both durable terminal state and the rendered conversation
log to stop being busy before continuing. Model selection uses the visible
trigger after its position stabilizes; it does not retry a missed action.

The fixture deliberately rejects unexpected model traffic. Its health assertion
runs in a Mocha `after` hook: WebdriverIO's `afterSession` hook logs exceptions
without necessarily failing the worker. A native negative control sent an
unregistered request after startup; Mocha reported a failed hook and WDIO exited

1. The provider fixture also has a permanent HTTP regression for an unexpected
   request after a successful answer.

The dependency guard still rejects the obsolete WebdriverIO download chain. The
MCP SDK separately requires `ip-address` through `express-rate-limit`; the guard
now traces the actual WebdriverIO dependency graph and also rejects vulnerable
`ip-address` versions globally. The locked version is 10.7.6; GitHub's reviewed
advisories on 2026-11-20 cover versions through 10.7.3, including
[GHSA-rxp7-6hxx-x8q5](https://github.com/advisories/GHSA-rxp7-6hxx-x8q5).

## Reproduction and evidence

Run the complete configured E2E suite from the repository root:

```sh
pnpm test:e2e
```

A focused run can use the Desktop WDIO command with `--spec` and the corresponding
file. `TOUCHAI_E2E_SKIP_BUILD=1` is valid only with a binary built from this
worktree. `TOUCHAI_E2E_RUNTIME_ROOT` optionally places isolated databases, requests
and ledgers outside the checkout. No machine-specific path is required by CI.

Local verification uses Linux/WebKit and the existing matching Debug binary,
with serialized native runs under a memory limit. Logs, runner configuration,
isolated SQLite databases, model requests and MCP effect ledgers are retained in
`/dev/shm/touchai-710-9049b4ad/rfc710-native-e2e-lt0k95j8`. The negative control is
`negative-control.log`; the final combined run is `e2e.log` and `result.txt`.
Tooling/CI logs live in the sibling `logs/` directory.

## Scope limits

- The full Windows/WebView2 CI run, including the original visual specifications,
  has not been executed for this uncommitted worktree. Local functional success
  does not establish a passing remote CI result.
- Backup/import bypass the OS file picker and send the real Settings-to-main
  command. Native backup/import, transactions and database contents are exercised.
  Picker widgets, import-mode selection, progress/toast behavior and the automatic
  restart after import are not covered by these cases.
- The normal history-restoration case restarts the native application; it does
  not prove recovery from an abrupt process crash. Tool cases do not establish
  manual-resend idempotency or exactly-once effects across process crashes.
- Remote model/provider compatibility and release P50/P95/memory comparison
  against the 5% budget remain separate acceptance work.

Scenario details: [Agent](rfc710-agent-e2e.md), [MCP tools](rfc710-tools-e2e.md),
[data management](rfc710-data-management-e2e.md).
