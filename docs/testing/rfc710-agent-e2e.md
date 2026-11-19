# RFC 710 Agent end-to-end acceptance

Issue: #710. These scenarios exercise the built Tauri application, its production
main-window Core, Models drivers, Tools pipeline and the existing SQLite schema.
The model server is a loopback OpenAI-compatible HTTP fixture. It scripts only the
external provider; it does not replace application services or renderer state.

## Scenarios

- Given a configured local provider, when the user sends a prompt, the streamed
  answer appears and the user/assistant messages, turn and attempt are saved.
- Given a completed turn, when the next prompt calls the settings tool, the
  provider receives the prior answer and actual tool result before continuing.
- Given a model question, when the user selects an answer in the real question
  panel, the tool receives that answer and the model completes the same turn.
- Given a setting change requiring approval, when the user rejects it, the saved setting
  stays unchanged and the model receives the rejection. When the user
  approves a separate call, the changed setting and its tool result are saved.
- Given a partial model stream, when the user presses Escape, the turn becomes
  cancelled durably and later provider output cannot change its terminal state.
- Given saved history, when the application is restarted and the session reopened,
  the saved answer remains visible and the next request includes prior context.
- Given two model connections, when the user selects the other connection, its
  request reaches the corresponding endpoint with only that connection's key.

## Execution and evidence

These specs are part of the normal `pnpm test:e2e` configuration. Each behavioral
spec receives a fresh app root populated from the repository's migration and seed
artifacts; the native application still runs its normal database startup. Fixture
credentials are synthetic. HTTP requests stay on loopback. Assertion failures fail
the normal E2E job; these scenarios have no optional skip or catch-and-pass path.
Existing visual specs and committed baselines remain enabled in the default run.

E2E assertions cover visible UI, actual external requests/effects and persisted
results. SQLite reads are independent of the renderer. Fixture SQL only prepares
isolated test data and does not change the application's schema or migrations.

A local Debug run is functional acceptance, not release performance acceptance or
proof of remote provider compatibility. The Windows E2E workflow must run the same
specs against its freshly built binary. Measured release P50/P95 and memory budgets
remain a separate acceptance requirement.

Measured native results, CI integration and remaining limits are recorded in
[E2E results](rfc710-e2e-results.md).
