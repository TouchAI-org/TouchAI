# RFC #710: native MCP execution and persistence safeguards

Related to #710. This bounded slice drives the installed desktop UI, Core, Models,
the native MCP client, a loopback MCP server, Tools audit, and the application's
SQLite database. Model replies are controlled OpenAI HTTP/SSE responses. The
tests do not replace or directly invoke application workflows, tool execution or
persistence. Native window operations are used only to focus and switch windows.

## Acceptance scenarios

### Given an enabled local MCP tool and a temporary model failure

- **When** the user submits a prompt, the model calls the tool, and the first
  continuation request returns HTTP 503 before a following request succeeds,
- **Then** the user sees the final answer, the model receives the committed tool
  result on retry, SQLite holds one successful audit, and the server's effect
  ledger contains exactly one effect for that prompt.

### Given a server that disconnects after accepting a tool call

- **When** the user submits a prompt and the server records the effect but closes
  the connection before delivering its result,
- **Then** the user sees a terminal failure, SQLite records a failed tool audit,
  and neither Core nor the native MCP client repeats the uncertain effect. A
  subsequent independent prompt can complete after catalog reconnection.

### Given a completed remote effect whose audit cannot be saved

- **When** the user submits a prompt and the MCP server records the effect, takes
  a separate SQLite `BEGIN IMMEDIATE` write lock, and returns its successful
  result while holding the lock through the native writer's timeout,
- **Then** the user sees a persistence failure, the audit does not claim success,
  no model continuation or automatic retry replays the effect, and the ledger
  still contains exactly one effect after the lock is released. A fresh prompt
  can subsequently complete.

The persistence scenario deliberately expects a terminal failure: ambiguous
storage is not permission to retry a side effect. The temporary HTTP failure
scenario separately proves that an authorized retry after a committed checkpoint
does not repeat a completed effect. These do not establish crash recovery,
manual resend idempotency, or exactly-once execution across process restarts.

## Fixture boundary and isolation

- Use the pinned development dependency `@modelcontextprotocol/sdk` and its Streamable HTTP
  transport, listening only on `127.0.0.1` with an OS-assigned port.
- Insert only this fixture's enabled `mcp_servers` row, restart the app and click
  Connect in the real Settings window. E2E mode disables startup auto-connect.
  Readiness requires the native client to persist the actual tool catalog and
  clear the fixture server's initial error marker. Remove the catalog before a
  reconnect so stale rows cannot pass readiness. Cleanup removes this fixture's
  server and catalog; the next scenario starts a fresh native process.
- Record effects in a per-fixture JSONL ledger under the fixture's isolated
  `appRoot`; use no Bash tool, external service, or production account.
- Acquire a separate `node:sqlite` connection only to the fixture's isolated
  `databasePath`. Hold a write transaction without changing schema, triggers,
  settings, timeouts, or rows. Release it in cleanup even when assertions fail.
- An independent watchdog releases the lock if the UI does not reach failure;
  that condition fails the test and must never count as persistence coverage.
- Keep the MCP listener available after deliberately dropping its active sockets.
  A repeated call would append another ledger entry and fail the test; the
  fixture does not deduplicate or hide effects on behalf of production code.
- Read persisted message parts and turns directly as independent evidence. UI
  actions use the visible prompt editor; browser evaluation may read DOM but
  must not inject agent state or invoke private application APIs.

## Harness and execution

`test/support/agent-fixture.js` supplies `getAgentFixture()` and
`{ appRoot, databasePath, query(sql, ...bindings), execute(sql, ...bindings),
provider }`. The provider supplies `when(prompt, handler)`,
`respond(prompt, { tool: { name, args, id }, answer })`, and `requests`. Handlers
receive `{ body, respond }`; `respond.tool`, `respond.text`, and `respond.fail`
write real model HTTP responses. Continuations are identified by tool messages
after the latest user message.

`test/support/agent-ui.js` supplies `submitPrompt(prompt)`,
`waitForAnswer(text)`, and `waitForTurn(status)`. Submission focuses the main
window, populates the editor through its existing setup bridge, and presses
Enter. Do not use the bridge's `sendPrompt`: it waits for the whole turn and a
WebDriver timeout can resubmit the prompt.

`wdio.conf.js` registers this spec as a separate native session in the normal
`pnpm test:e2e` run. The fixture applies the current migration and seed artifacts
and configures synthetic model connections in a fresh app root. Node must support
`node:sqlite` (CI uses Node 22). The tests require the native application to open
that isolated database and use its existing loopback MCP HTTP transport.

The official `@modelcontextprotocol/sdk` is a pinned Desktop development dependency
used only by the test fixture. Its stateless Streamable HTTP transport uses a fresh
protocol server per HTTP request and JSON responses; no handwritten MCP protocol
implementation or production dependency is introduced.

A blocked catalog, unacquired write lock, absent failure UI, or unexpected
continuation is a test failure, never a skipped scenario. All three scenarios
passed against the Linux Debug application on 2026-11-19. The combined run and
remaining platform limits are recorded in [E2E results](rfc710-e2e-results.md).
