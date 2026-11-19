# RFC #710 Implementation Addendum

Related to [accepted RFC #710](https://github.com/TouchAI-org/TouchAI/issues/710).
This local record precedes implementation. It records the user's updated design
authorization, not human code review or delivery authorization.

## Authorization And Baseline

- The user explicitly approves the architecture in this addendum and requests
  one implementation worker through the Codex harness in T3 Code. The parent
  owns supervision, independent review, and delivery. Worker configuration and
  checkout recovery evidence remain in the task's external implementation log.
- Implementation continues from pinned baseline
  `c903654181dc79b76ed1e5ec691af43941e6853c` in the isolated task checkout.
- No commit, staging, push, issue/PR mutation, merge, tag, or release is authorized.
  User review status: not reviewed; reviewed by: pending.
- Other source checkouts and shared dependencies remain read-only.
- Database impact: none. Native SQLite, transactions, backups, schema, migrations,
  persisted JSON/blob shapes, retention, deletion, and backfill remain unchanged.
- Security impact: no CSP/capability/scope/allowlist/approval widening. Directed
  application clients reuse existing native event and operation contracts.
  External data never becomes instructions.

## Ownership And Dependency Matrix

Exactly two new root business packages are authorized:

| Owner | Responsibilities | Forbidden dependencies/ownership |
| --- | --- | --- |
| `@touchai/models` | Neutral model/message/tool-declaration/stream contracts, provider protocol drivers, encoding, streaming, normalized usage/errors, capabilities/catalog, upload/cache through injected host I/O | Agent loops/tools execution, Desktop imports, user model selection, credentials storage, Desktop paths/SQL, pricing dashboards |
| `@touchai/agent-core` | Task/turn/attempt consistency, existing unlimited execution loop and concurrency, decision waits, cancellation/retry/checkpoints/recovery, budgeting/legal compaction, deterministic prompt assembly | Provider drivers, Desktop imports, ORM/SQL, credentials, discovery/MCP/OS execution, Vue/Pinia/windows, Widget rendering |
| Desktop `modules/agent` | Session/task facade, committed history, safe projections | A second loop, exposing secrets/checkpoints/internal prompt snapshots |
| Desktop `modules/models` | User provider profiles and secrets, model configuration/default selection, metadata freshness | Provider driver implementations or an implicit default provider |
| Desktop `modules/tools` | Sole registry/config authority; controlled builtin/MCP validation, authorization, approval, cancellation, execution and results | Core registration authority, MCP overriding builtins/trusted intents |
| Desktop `modules/skills` | Discovery, parsing, loading, invalidation, management | Agent loop ownership |
| Desktop `modules/attachments` | Draft/resource references, file consistency, existing cleanup | New persisted shape or cleanup policy |
| Desktop `modules/settings` | Preferences and existing single-writer/sync protocol | Other modules' business configuration authority |
| Desktop `modules/search`, `usage`, `scheduler`, `updates`, `analytics` | Retrieval/indexes/interactions; consumption/cost; persisted automation; update state; typed product events | Core scheduling, native installer/analytics delivery/identity/consent ownership |
| `app/workflows` | Cross-module coordination via public capabilities, agent/data-management workflows | Internal state mutation or a second loop |
| `app/composition` | Typed creation-time registration, instance assembly/lifetimes | Business state, globals/service locators, import-time timers/listeners/connections |
| `adapters` | Translate package contracts to narrow Desktop capabilities | Business policy or whole-service/store/DB-handle injection |
| `platform`, `database` | Designated I/O capabilities and existing native contracts | Business modules or UI dependencies |
| UI/stores/composables | Narrow `app/api` commands, queries and events | Module internals, SQL, raw native access, privileged credential readers |

Business modules never import one another, including type-only imports. Consumer-
owned narrow interfaces are bound in composition or cross-module workflows. Pure
business code has no I/O dependencies. Neutral helpers and reexports are checked
transitively, not treated as escape hatches.

Public package entries: `@touchai/agent-core` and `/contracts`;
`@touchai/models`, `/contracts`, `/catalog`, and explicitly reviewed provider
entries. Neutral entries must not eagerly load SDK drivers. `agent-core` imports
only neutral model contracts; models never imports agent-core. No extra business
packages or `*-runtime` branding are approved.

## Lifetime And Execution Invariants

- Main-window assembly is the only execution/settings host. Secondary windows
  remain clients and must not create fallback Core instances.
- Creation-time dependencies are complete and instance-scoped. Core events are
  outputs. Desktop owns shared provider connections/services; Core owns tasks.
- Freeze matching declarations and execution bindings per turn. Configuration
  changes apply at subsequent boundaries; revocation is rechecked before effects.
- One tool registry rejects duplicate names. Computer control is an ordinary
  builtin. Ask-user waits belong to Core; skill/model switches are validated
  control requests. Tools receive scoped callbacks, never the whole Core.
- Preserve tool names/schemas, `_meta`, exclusions/retries/timeouts, concurrency,
  unlimited iterations and local-vs-remote cancellation semantics.
- Await persistence barriers. Observations do not imply durable success. Progress
  stays coalesced; semantic/terminal output cannot be dropped or attach to a later
  attempt. Failed saves and unknown side effects cannot blindly replay tools.
- Model messages, execution events, and UI DTOs remain distinct. Widget processing
  stays in tools, DOM/sandbox rendering stays in presentation.

## BDD Acceptance Scenarios

1. Given a configured connection, when the user streams text, reasoning,
   multimodal content and tool declarations, then the existing provider protocol,
   usage/errors and bounded upload/cache behavior remain compatible.
2. Given multiple OpenAI-compatible endpoints or two assembled Core instances,
   when the user runs tasks and refreshes one connection, then credentials,
   execution, cache, waits and cleanup do not leak to the other instance.
3. Given a turn's model/tool snapshot, when configuration changes during the
   stream, then emitted declarations match execution bindings for that turn;
   revocation still prevents new effects and subsequent turns see new config.
4. Given existing builtin names, when an MCP server declares a collision or trusted
   control intent, then registration fails rather than overriding execution or
   authorization. Builtins and MCP use one controlled execution pipeline.
5. Given a pending decision keyed to task/attempt/call, when the user submits
   duplicate, stale or late approval/question replies, then only the live decision
   settles once; cancellation releases every pending wait independently of UI.
6. Given slow or failed storage, when the user finishes/retries/cancels a task,
   then durable success is reported only after the barrier, terminal state wins,
   old attempts cannot write late progress, and completed/unknown effects are not
   automatically replayed.
7. Given existing history and attachments, when the user restores/reopens,
   switches models, compacts context or shows a Widget, then legal boundaries,
   persisted serializers, attachment consistency and rendering are unchanged.
8. Given the main host is unavailable or not ready, when a secondary window issues
   a command, then it fails through the existing bounded client protocol without
   becoming an execution/settings owner or exposing privileged credentials.
9. Given an architecture violation via an alias, Vue script, dynamic import,
   reexport, type edge, local JS-to-TS import or glob, when CI analyzes the graph,
   then direct/transitive boundaries and runtime cycles fail. Missing roots,
   empty graphs and unresolved constrained local imports fail closed. New paths
   are automatically discovered and no baseline legalizes forbidden edges.
10. Given extracted source, when workspace checks/coverage/CI select a change,
    then both packages remain in build/typecheck/test/overall and patch coverage,
    required gates run and no coverage floor decreases.
11. Given the same release device/profile/WebView, when affected startup,
    streaming, search/settings/window flows are measured before and after, then
    P50/P95 and steady-state memory regress by at most 5%.
12. Given production helpers, module I/O and neutral package entries, when they
    import privileged state, frameworks, any Node builtin spelling or a provider
    SDK, then their own role rejects the edge even without a current caller.
    Only the exact main-host assembly may obtain the Core creation entry.
13. Given a Desktop attachment and connection-scoped cache, when the provider
    resolves a cache hit or miss, then the neutral message carries no database
    identity, local path, persisted manifest or execution timeout policy, while
    the Desktop adapter preserves the existing persisted manifest byte shape.
14. Given tracked Desktop edits and new, unstaged Core and Models sources, when
    the user runs the patch coverage command from Desktop or the repository
    root, then all three owners contribute to the same 85% floor. Missing
    coverage for a new source counts against the floor. Git-ignored files stay
    outside the patch and the working tree and index keep their original state.
15. Given a presentation API, when it reaches SQL, a provider driver, a workflow
    implementation or an unreviewed native binding directly or through helpers,
    then the gate rejects it. Existing presentation bridges admit only their
    reviewed source, target and named bindings. Workflow contracts remain usable
    without admitting workflow execution. APIs, workflows and adapters cannot
    depend on UI state or owner construction.
16. Given separate publishers and subscribers for one window event, when the
    publisher sends before and after unsubscription, then the subscriber receives
    only the first payload through the native event boundary.
17. Given a native settings window and a skill name with repeated characters,
    when the E2E driver returns to the main window and enters a skill query, then
    the main window receives focus and the complete text before the unchanged
    completion, disable, restore and delete assertions run.
18. Given the product replaces a failed WOFF2 face with TTF, when either native
    font acceptance entry runs, then it waits for the product owner and verifies
    the final asset source and painted glyphs without substituting test fonts.

## Stages And Evidence

| Stage | Status | Evidence |
| --- | --- | --- |
| 0. Baseline/addendum/source/gate inspection | Complete | Clean pinned fast-forward; RFC read without mutation; prior resolver/graph/cycle source inspected; baseline cache/stream: 15 tests passed |
| 1. Models extraction | Source and local checks verified | Provider protocols, neutral contracts/catalog, connection isolation, upload resources, selection/discovery/metadata and settings-only profile administration are connected; package source/test typechecks, build, lint and full coverage pass |
| 2. Desktop ownership/tools/capabilities | Source and local checks verified | Unified builtin/MCP pipeline, actual tool factories, Search/Usage/Scheduler/Analytics/Updates owners, clipboard drafts, committed audit and main-owned data management replace legacy services; behavior suites and coverage pass |
| 3. Core extraction/adapters | Source and local checks verified | Actual bootstrap/session commands reach the sole Core; legacy execution implementations are removed; native streams, history, settings tool continuation and cancellation pass |
| 4. Narrow UI/client APIs | Source and local checks verified | Per-window commands cover production views; ordinary preferences reject business keys at runtime, credentials and administrative writes stay settings-only, and secondary windows cannot construct owners; native settings and skill flows pass |
| 5. Old-path removal/gates/integration | Local gates verified | The 1650-file graph has zero violations and cycles. Full V8 passed 620 files / 7340 tests and all coverage floors; patch coverage is 93.09%. Repository CI passed 16 files / 487 tests. Workspace typechecks, both package builds, Desktop Vite, offline Site and native debug builds passed. |
| 6. Parent acceptance/review | Local review and scoped native acceptance verified; release acceptance pending | Parent gate probes, coverage, real Agent/settings/skills and cancellation checks pass. Full platform/visual E2E, a release build and comparable P50/P95/memory evidence remain open. The metadata staging path is synchronized in the final cleanup; current-main integration and remote checks remain pending. |

Checks use existing dependencies and serial, bounded test/typecheck processes.
Machine-specific storage limits, commands, configurations and evidence paths
remain in the task scratch record. The following milestones record the evidence
available at each stage. The table gives the latest verification status.

### Focused Evidence

Parent review reproduced five additional false-negative gate fixtures.
The existing 22 tests passed in the parent's focused run, but that is not complete
architecture acceptance. New regressions and current implementation results are
recorded separately; parent evidence is never substituted for current checks.

These checks used Node 26.13.0 with one Vitest worker. Resolved versions were
TypeScript 6.0.3, Vitest 4.1.12, AI SDK 6.0.301, OpenAI SDK 3.0.124 and
Vue/compiler-sfc 3.5.43.

- The baseline Provider cache and stream suites passed 2 files / 15 tests in
  7.37 seconds.
- RED: `packages/models/tests/connections.test.ts` initially failed because the
  public package entry did not exist. After the protocol/host transplant, the
  same suite had 3 passing and 2 failing behaviors: caller header mutations
  changed outbound headers; upload rejection on one connection disabled another.
- All five Models connection tests passed in 0.71 seconds after creation-time
  config cloning and bounded connection-local upload state.
- `node node_modules/typescript/bin/tsc -p packages/models/tsconfig.json --noEmit`:
  passed. No emit/build or SDK version change.
- Gate RED: the first legal graph CLI probe failed with missing
  `tooling/architecture/check.mjs` before gate implementation.
- The first 17 behavioral CLI probes in `tests/ci/architecture/repository.test.ts`
  passed in 22.51 seconds. These probes exercise isolated graph fixtures.
- Parent-probe RED: the expanded `repository.test.ts` had 8 failing / 23 passing
  tests (35.90 seconds): non-main creation, module I/O Vue state, three bare Node
  builtin forms, the unreferenced SQL helper and two third-party SDK contracts.
  The historical worker log is `graph-parent-red.log`.
- Parent-probe GREEN: the same serialized Node26 CLI suite now has 31 passing
  tests (35.25 seconds), including exact main-assembly creation and all builtin
  spellings. Neutral external dependencies are positively declared by ownership
  metadata, not excluded using a list of known SDK brands. Log: `graph-parent-green.log`.
- Neutral-media RED: `packages/models/tests/transport.test.ts` had 4 failures
  because the old encoder required Desktop `meta.alias` and durable records.
  Log: `transport-red.log`.
- Neutral-media GREEN: connections plus transport suites now have 9 passing tests
  (1.09 seconds). Cache HIT, MISS and repeat HIT cover two endpoints/credentials;
  transport outputs contain only neutral observations; semantic fallback is
  supplied by the host; cancellation prevents fallback generation/cache writes.
  The historical worker log is `transport-green.log`.
- Neutral models typecheck: `node node_modules/typescript/bin/tsc -p
  packages/models/tsconfig.json --noEmit` passes after removing Desktop attachment
  IDs/paths/manifests, per-request connection selectors, UI language assembly and
  execution timeout ceilings from package contracts. Log: `neutral-models-type.log`.
- Desktop models/transport GREEN: the serialized Node26 command with
  `baseline.vitest.config.mjs` and `tests/modules/models/connections.test.ts`
  plus `tests/adapters/models/transport.test.ts` passes 2 files / 4 tests
  (5.88 seconds). Log: `desktop-models-green.log`. This includes cache HIT
  isolation and disabled-profile revocation before network effects.
- The first full Desktop typecheck exhausted its heap. The later Desktop Type
  And Caller Verification milestone records the successful full-project run.
- Unified tools RED: `tests/modules/tools/registry.test.ts` failed to load the
  missing public tools entry (`tools-red.log`). GREEN: the same serialized
  command passes 6 behaviors (1.28 seconds; `tools-green-initial.log`): duplicate
  names/trusted controls, frozen matching bindings, live revocation, metadata
  collision handling, common validation and exclusions. Builtins/MCP integration
  is not yet complete.
- Shared schema validation uses the already installed Ajv 8.20.0 (MIT,
  `sideEffects: false`), not a handwritten JSON Schema engine. Its existing
  runtime compilation is permitted by the current CSP; no CSP change is made.
  Package/lockfile ownership is recorded in the integration stage.
- Additional BDD/TDD pipeline scenarios: Given an asynchronous approval or
  remote effect, When the user cancels/disposes or revokes authorization, Then
  local waits settle without claiming remote cancellation and late success is
  ignored. Given a completed effect, When its save barrier fails, Then it is
  not reported as durable success and its side effect remains non-replayable.

At this stage temporary model compatibility forwards still routed old callers
to the new owner. Stage 5 removed them and the legacy per-call model assembly.

### Core And Pipeline Milestone

- Pipeline RED: cancellation/disposal waits and failed audit persistence had
  3 failing / 1 passing regressions (`tools-pipeline-red.log`). GREEN: registry
  and pipeline suites have 2 files / 10 passing tests (2.46 seconds;
  `tools-pipeline-green.log`). This is not builtin/MCP integration evidence.
- Core RED: public lifecycle/decision tests could not resolve the absent Core
  entry (`core-red.log`). Initial implementation exposed an occupied-conversation
  cleanup race (11 passing / 1 failing; `core-green-initial.log`); cleanup now
  precedes completion resolution. Isolated Core typecheck passes (`core-type.log`).
- The first expanded Core run had 17 passing / 1 failing (`core-current.log`):
  a new compaction test forced a specific cut instead of testing the retained
  legal boundary. The assertion now checks the saved boundary against the
  verbatim retained history and latest request; the original algorithm is not
  changed to satisfy an arbitrary test cut.
- Additional acceptance: Given provider streams that ignore abort, When the
  user cancels/disposes, Then local task state and leases settle and late chunks
  cannot update a completed attempt. Given Core provenance and summaries, When
  a provider receives messages, Then only neutral transport fields are present.
  Given a large concurrent tool round, When the user answers its questions, Then
  every live question can settle without a new concurrency limit.
- At this milestone production still used legacy loops, waits, provider forwards
  and global registration. The production integration milestone records their
  replacement. Native E2E, coverage and performance still require measurement.
- Desktop persistence acceptance: Given an atomic start/terminal/tool-result
  write, When SQLite rejects the identity/status update or its result target is
  absent, Then the caller receives failure, rolled-back records remain unchanged,
  and no success/checkpoint acknowledgement is emitted. A later authorized write
  may succeed after the storage fault is removed. Regression fixtures use only
  shipped migrations in in-memory SQLite through the existing native IPC harness.
- Core boundary RED: 3 failing / 18 passing (6.28 seconds;
  `core-boundaries-red.log`) proved abort-ignoring streams retained tasks,
  checkpoint provenance leaked into provider input, and the new decision cap
  refused four live questions. GREEN: the same four files have 21 passing tests
  (5.67 seconds; `core-boundaries-green.log`); Core `tsc --noEmit` also passes
  (`core-boundaries-type.log`). No new concurrency cap remains.
- SQLite barrier RED: all three new behaviors fail because the caller receives
  success after rejected status/identity writes or a missing result target
  (`persistence-barriers-red.log`, 20.44 seconds). GREEN: the new suite and the
  existing rollback regressions have 2 files / 12 passing tests (36.75 seconds;
  `persistence-barriers-green.log`). The successful run used `apps/desktop` as
  its working directory so the SQLite harness could locate the migration journal.
- Adapter acceptance: Given stored message identities, summaries and media,
  When a task enters Core or switches provider connections, Then its neutral
  references are opaque, local metadata never becomes a package field, and the
  Desktop boundary can reconstruct the unchanged checkpoint/summary/media
  records. Unknown resource references fail closed rather than resolving a path
  or another task's attachment. Disposal invalidates the task's resource mapping.
- Tool integration acceptance: Given an invalid, excluded or revoked call, When
  the model requests it, Then the same controlled pipeline saves its rejected
  call/result before returning and never starts an effect. Given connected MCP
  tools at a turn boundary, When the catalog changes, Then the next snapshot sees
  it while existing declarations keep matching bindings; no MCP registration can
  override builtins or supply a trusted control intent.
- Timeout acceptance: Given a tool's configured default, When a model omits a
  timeout or suggests an invalid value, Then the pipeline leaves the default
  intact; only a valid suggestion is clamped to the frozen advertised ceiling.
- Current tool integration RED: the catalog and rejected-call audit regressions
  fail (2 failing / 13 passing, 7.30 seconds; `tools-integration-red.log`). The
  timeout default regression independently fails (0.90 seconds;
  `tools-timeout-red.log`), returning 600000 for an omitted suggestion.
- Desktop message/checkpoint adapter: all three initial behaviors pass in
  `tools-integration-red.log`; the tool failures in that run are separate.
- Actual repository graph, before production integration: 1492 source files,
  1721 violations, zero runtime cycles, no parse/source errors. Counts:
  UI boundary 1226; legacy path 282; neutral boundary 98; platform boundary 87;
  module entry 8; module I/O 5; raw native invoke 2; unresolved local 5;
  unresolved dynamic 8. Evidence: `architecture-before-integration.json` and
  `architecture-before-integration.log`. No ignored baseline is introduced.
- Tool/adapter GREEN: the registry, pipeline and message adapter now have 3
  files / 18 passing behaviors (5.16 seconds;
  `tools-adapter-integration-green.log`), with no tool-default timeout change.
- Resource-lifetime RED: 2 failing / 3 passing (2.46 seconds;
  `agent-adapter-lifetime-red.log`) exposed a retained WeakMap key whose media
  binding had been pruned, and an unchecked foreign summary part. Those cases
  are included in the GREEN evidence above; disposed content also fails closed.
- Failed-start COMMIT RED: a newly created session id remained cached after
  rollback (`persistence-start-commit-red.log`, 3.12 seconds). GREEN: the real
  SQLite persistence/rollback suites have 2 files / 13 passing behaviors (5.66
  seconds; `persistence-start-commit-green.log`). The id is published only after
  the existing transaction commits; no schema/transaction boundary changes.
- The actual persistence implementation now lives in Desktop agent I/O at
  `modules/agent/persistence/projector.io.ts`; all old imports are migrated,
  with no compatibility file at the old persistence path. It no longer imports
  the legacy executor's checkpoint type. Other legacy dependencies still need
  migration to consumer-owned capabilities; this is not full boundary acceptance.
- Core/Desktop persistence adapter RED: the public adapter was absent
  (`core-desktop-persistence-red.log`). GREEN: adapter, message and SQLite suites
  have 3 files / 11 passing behaviors (7.81 seconds;
  `core-desktop-persistence-green.log`). Real Core completion waits for the shipped
  atomic save; a rejected terminal write yields `PERSISTENCE_FAILED`, never a
  completed task or a new retry attempt. Stored checkpoint bytes omit opaque
  Core keys and prompt contents.
- Dynamic registration acceptance: Given a catalog-owned MCP descriptor, When
  its mutable source or control identity changes after a turn is prepared, Then
  the captured execution remains untrusted MCP and cannot issue a builtin control
  request. Snapshot preparation captures both descriptor identity and callbacks.
- Audit integration acceptance: Given a task-scoped call and the shipped SQLite
  writer, When an invalid/revoked/approved/executed call settles, Then its existing
  log payload is saved before acknowledgement, audit content remains redacted,
  presentation payloads remain intact, and receipts cannot cross task/attempt
  boundaries. Missing/rejected save targets fail closed; checkpoint/disposal
  releases completed receipts without dropping in-flight writes.
- Conversation identity acceptance: Given a new conversation whose identity is
  assigned by the committed start barrier, When another request targets that
  conversation while its task is active, Then Core refuses a second task and
  releases the newly assigned identity only after the first task settles.
- Builtin composition acceptance: Given the shipped tool configuration rows and
  an instance-created builtin descriptor, When a turn is prepared and the user
  edits its configuration, Then the advertised declaration and approved effect
  keep the same captured configuration while later turns see the edit. Disabling
  the tool revokes new effects immediately. Duplicate descriptor names fail
  before configuration synchronization or execution.
- Scoped builtin acceptance: Given an upgrade chain or a question tool, When the
  user approves or replies, Then the captured upgrade target cannot change to a
  different connection and the question uses only its task-scoped callback.
  Revoked targets and cancelled scopes never issue a control request or accept
  a late reply. No import creates a registry, connection, timer or execution host.
- Skill binding acceptance: Given the enabled skill metadata advertised at a
  turn boundary, When a name is activated after discovery/configuration changes,
  Then it resolves only to the advertised path, rechecks enabled availability,
  and never silently loads a replacement path. Model context and the existing
  persisted activation summary remain distinct. Core budget rejection still
  traverses the controlled tool audit/result pipeline.
- Designated capability acceptance: Given a public module creation/capability
  entry, When composition binds its own I/O implementation, Then designated
  database/platform access is permitted only behind that entry. A pure domain
  caller or contract reexport cannot inherit it, and an `.io` name cannot grant
  direct native SDK or presentation permissions. Native command payloads,
  cancellation and HTTP backpressure remain unchanged when platform ownership
  moves; raw invoke stays confined to its exact native bridge.
- Read-effect acceptance: Given an approved local path derived from the current
  Desktop directory, When that default changes while approval is pending, Then
  the effect reads only the approved path. A rejected read never emits content
  or attachments. Filesystem operations are designated platform capabilities;
  attachment creation is a consumer-owned callback, not a sibling-module import.
- Shell-effect acceptance: Given a captured shell configuration, When the model
  requests a timeout or the user cancels during native cleanup, Then the original
  timeout/allowlist/approval contract is retained, explicit native cancellation
  still runs, local completion never claims the remote effect stopped, and late
  deltas cannot update the cancelled scope.

### Continuation: Builtin Binding And Identity

- Dynamic MCP descriptor mutation RED: 1 failing / 8 passing
  (`tools-registration-mutation-red.log`). Capturing descriptor identity and its
  preparation callback yields 3 files / 19 passing tool/adapter behaviors
  (`tools-registration-mutation-green.log`, 4.74 seconds).
- Real tools-owned SQLite audit RED: 4 failures for the absent public audit
  (`tools-audit-red.log`). Audit/registry/pipeline GREEN: 3 files / 18 tests
  (`tools-audit-green.log`, 6.27 seconds). The later preparation/semantic/input
  contract batch also passes the same 18 tests (`tools-contracts-current.log`,
  7.17 seconds). Existing enum values are preserved; no stored shape changes.
- New committed-conversation RED: 1 failing / 11 passing
  (`core-conversation-red.log`). The first fix exposed the existing requested-key
  reservation regression (`core-conversation-green.log`, 1 failing / 21 passing).
  Both requested and committed identities now stay reserved through completion.
  Current Core GREEN: 4 files / 22 tests (`core-conversation-current.log`, 1.33
  seconds), with the recorded serialized package test command.
- Builtin registration RED: 3 failures for the absent public capability
  (`builtins-red.log`). GREEN with registry/audit/pipeline: 4 files / 21 tests
  (`builtins-registry-green.log`, 16.46 seconds); scoped `tsc --noEmit` passes
  (`builtins-registry-type.log`). Tests use the shipped schema in in-memory SQLite.
- Instance-created question/upgrade-model RED: 3 missing-capability failures
  (`builtin-controls-red.log`). GREEN with registration: 2 files / 6 tests
  (`builtin-controls-green.log`, 4.55 seconds); scoped typecheck passes
  (`builtin-controls-type.log`). Upgrade lookup is a consumer-owned capability;
  declarations, semantic text, approval and controls share a captured target.
- Production wiring, remaining builtin/MCP migration, old-path deletion, real
  repository graph acceptance, CI and both coverage gates are still unfinished.
  This milestone is not full architecture or native/E2E/performance acceptance.
- The pending scoped Read/control/skill/registration command has now settled:
  4 files / 10 tests pass (`scoped-builtin-green.log`, 8.51 seconds) and the
  scoped TypeScript command exits 0 (`scoped-builtin-type.log`). Read approval
  and execution share the captured default directory; old Read/Bash production
  implementations still await composition and deletion.
- Architecture fixture GREEN after designated-I/O correction: 35 tests pass
  (`gate-designated-io-green.log`, 33.53 seconds). This includes the five parent
  false-negative scenarios; it is not a passing whole-repository graph.
- Additional control acceptance: Given an activated skill, When the next model
  request begins, Then the model remains unchanged and receives the private
  skill context while history retains its existing summary. Given the task's
  activation budget is exhausted, When another activation is requested, Then
  the same tools audit/result pipeline records the rejection without loading
  more instructions; Core never synthesizes an unaudited tool result.
- Web-effect acceptance: Given a public URL or a captured search configuration,
  When a redirect targets a private host or configuration changes before the
  effect, Then the existing URL policy remains enforced and the advertised
  search endpoint remains bound. Disabling that provider prevents new requests;
  search engine protocols and persisted configuration bytes do not change.
- Skill/Core control RED: 2 failing / 2 passing (`core-skill-controls-red.log`)
  and Desktop budget RED: 1 failing / 2 passing (`tools-skill-budget-red.log`).
  GREEN: Core 4 files / 24 tests (`core-skill-controls-green.log`, 1.13 seconds)
  and Core typecheck passes. Desktop control/pipeline/skill/shell batch passes
  4 files / 13 tests (`builtin-shell-skill-green.log`, 8.62 seconds).
- Bash factory RED: 2 failures (`bash-factory-red.log`). The first transplanted
  run had an incomplete test native mock that hid the SQLite bridge; it is not
  behavioral evidence (`bash-late-red.log`). Corrected boundary mock RED exposes
  late cancelled output (1 failing / 1 passing; `bash-late-current-red.log`).
  Effect callbacks now reject cancelled scopes; native cancel and unknown local
  outcome remain unchanged, and the coalescing timer is cancelled on abort.
- Web factory RED: 4 failures (`web-factories-red.log`). GREEN with shell:
  2 files / 6 tests (`web-shell-green.log`, 4.61 seconds), scoped typecheck exits
  0 (`web-shell-type.log`). A prior shell scoped typecheck caught an unused type
  import; that import is removed rather than weakening compiler settings.
- Computer-control acceptance: Given two created control instances or an
  advertised driver binding, When approval/configuration/driver selection
  changes, Then session grants stay instance-local, effects use the captured
  non-revoked driver/configuration, and revocations prevent new native effects.
  Computer control remains one ordinary builtin in the unified tool pipeline.
- Activity-lifetime acceptance: Given a task with multiple tool rounds, When an
  individual effect finishes or is cancelled, Then native activity remains bound
  to that task until task cleanup. A native stop cancels only that scoped task;
  disposal cancels only this instance's invocations and rejects late successes.
- Browser-binding acceptance: Given the browser configuration captured with the
  advertised tool, When homepage/fingerprint settings change during approval,
  Then execution retains the captured request. New denial or confirmation rules
  are rechecked before each native effect, and an existing-session chooser is
  still the single scoped decision. Screenshot transport suppresses inline bytes
  and retains the existing attachment reference and redaction behavior.
- Settings-outcome acceptance: Given an approved preference mutation, When the
  authoritative owner reports an unknown or recovery-required outcome, Then the
  tool retains that uncertainty instead of reporting a completed effect that
  could be blindly replayed. Read/search behavior stays compatible through the
  same public pipeline and shipped configuration/schema.
- MCP-connection acceptance: Given a connected catalog at a turn boundary, When
  timeout/schema configuration changes, Then declarations and native effects
  retain the same captured binding. Reconnection, disabling a server/tool or
  changing its endpoint revokes old effects. A local abort settles as unknown,
  never claims remote cancellation and never materializes late result resources.
  Tool synchronization retains the existing atomic transaction and disabled
  choices; duplicate native names are rejected before that transaction.

### Continuation: Controlled Effects And Widget Ownership

- Computer binding RED: 2 failing / 1 passing
  (`computer-binding-current-red.log`) exposed mutable screenshot configuration
  and execution through a newly selected driver. Task activity RED: 1 failing /
  4 passing (`computer-lifetime-red.log`); Core task scope RED: 1 failing / 12
  passing (`core-task-scope-red.log`). GREEN: Desktop computer/shell/control 3
  files / 10 tests (`computer-lifetime-green.log`, 6.96 seconds); Core 4 files /
  25 tests (`core-task-scope-green.log`, 1.24 seconds). Core and scoped Desktop
  typechecks pass after typing the captured computer callbacks explicitly.
- Browser factory RED: 3 failures (`browser-factory-red.log`). Settings outcome
  RED: 2 failing / 6 passing (`browser-settings-current-red.log`). GREEN:
  browser/settings/file-search/computer 4 files / 13 tests
  (`desktop-builtin-current-green.log`, 9.31 seconds) and scoped typecheck passes
  (`desktop-builtin-current-type.log`).
- MCP factory RED: 3 failures (`mcp-factory-red.log`). GREEN with registry and
  pipeline: 3 files / 17 tests (`mcp-registry-current.log`, 7.11 seconds), scoped
  typecheck passes (`mcp-registry-type.log`). These are isolated factories, not
  evidence that the production global registry/manager has been removed.
- Widget baseline first could not resolve the installed morphdom raw source
  (`widget-baseline.log`); its stream file passed 9 tests but validation did not
  load. The task-only Vitest configuration now permits those exact read-only
  dependency directories; no application CSP/filesystem capability changes.
  Current baseline passes 2 files / 28 tests (`widget-baseline-current.log`,
  2.09 seconds). Missing Widget factory RED: 4 failures
  (`widget-factory-current-red.log`, 2.98 seconds).
- Widget acceptance: Given acknowledged markup within the existing restrictions,
  When the tool executes, Then it emits the existing Widget event but only its
  semantic summary reaches model history. DOM inspection and opaque sandbox
  rendering stay in presentation; tools own parsing, validation and drafts.
  Rejected markup, cancellation and late results never create a ready Widget.
- MCP cleanup/race acceptance: Given a saved connection or an in-progress native
  disconnect, When its implementation changes during authorization or the user
  closes the host, Then no stale effect starts, mismatched catalogs are withheld,
  and local cleanup settles within the existing five-second bound without
  claiming the remote connection stopped. Late native completion cannot publish
  into a disposed host.
- Production integration, old-path deletion, whole-repository gate acceptance,
  CI and both coverage gates remain unfinished. Native/build/E2E/performance
  validation remains pending. The approved branch is unchanged at the pinned
  base; no staging, commit or remote mutation has occurred.
- Prompt privacy acceptance: Given live instruction fragments and a summarized
  Desktop prompt snapshot, When Core assembles a model request, commits a start
  or tool checkpoint, or retries, Then the model receives the deterministic live
  instructions but saved/published checkpoints retain only the supplied safe
  snapshot. Private skill and system text is never copied into those records.
- Model lease acceptance: Given concurrent tasks using the same unchanged user
  profile, When a turn acquires/releases its connection, Then it retains a stable
  connection identity without closing another task's lease. The last release
  removes the instance, disposed leases reject late work, and edited endpoints,
  drivers or credential/configuration snapshots cannot execute through an old
  binding. Cache HITs remain profile/resource scoped, not model-id scoped.
- API entry acceptance: Given an ordinary UI API and a module's host-only creation
  or credential capability, When the import graph is checked, Then that API
  cannot acquire the host entry directly or through a helper. Its module-facing
  entries are explicitly `public`/`contracts`; composition, workflows and
  adapters retain the reviewed host entries. UI DTOs remain explicit whitelists.

### Continuation: Pending Validation And Main-Host Integration

- MCP race/cleanup RED: 2 failing / 4 passing
  (`mcp-lifetime-current-red.log`); the expanded authorization race also failed
  in `mcp-widget-current.log`. The final MCP file has 6 passing behaviors.
- Prompt privacy RED: 1 failing / 4 passing (`core-prompt-current-red.log`).
  GREEN: Core 4 files / 26 tests (`core-prompt-current-green.log`, 1.19 seconds).
  Live instructions are task-private; durable checkpoints keep the host snapshot.
- Model revocation/lease RED: 5 failing / 3 passing
  (`models-lease-current-red.log`). GREEN: the Models file has 8 passing behaviors,
  including cache-HIT connection isolation and shared active-lease cleanup.
- Current Desktop GREEN: 8 files / 111 tests (`models-widget-mcp-green.log`,
  18.10 seconds). The recorded Node26 command runs the Models connections,
  MCP, Widget factory, validation, skill acknowledgement, renderer, sandbox and
  Widget-stream suites with one worker and the task-only baseline config.
- API role-entry RED: 2 failing / 36 passing (`gate-api-current-red.log`,
  35.79 seconds). Ordinary API imports of host-only `index`/`create` entries
  were accepted. The gate fix restricts those imports to safe public/contracts
  entries. A current GREEN rerun and scoped typechecks are pending at this record.
- Widget effects now belong to tools; iframe/DOM rendering belongs to
  `components/widgets`. Temporary old-to-new Widget forwards remain only until
  stage 5 deletion. The old execution Widget stream still coexists and must go.
- Main-host acceptance: Given the main or a secondary/unknown window, When the
  application bootstraps, Then only the explicitly identified main host can
  assemble Core, Providers, tools and settings execution. Clients keep the
  existing event/command transport and never create fallback execution hosts.
- Task-facade acceptance: Given committed conversation history and scoped model,
  tools and persistence adapters, When a user starts, cancels, approves, replies,
  retries or switches models, Then one Core task owns attempts and decision
  state. Safe projections retain current UI behavior; a failed save is not
  acknowledged as success, and unknown effects cannot be silently replayed.
- Production still uses the legacy TaskCenter/runtime/executor. Models selection,
  complete module ownership, narrow client APIs, old-path deletion, actual graph
  acceptance, CI and coverage remain unfinished. No native/build/E2E/performance
  acceptance is inferred from these focused tests.
- Current gate fixture GREEN: 38 tests (`gate-api-current-green.log`, 35.80
  seconds), using `node node_modules/vitest/vitest.mjs run --config
  vitest.ci.config.ts --configLoader runner --maxWorkers 1
  --no-file-parallelism tests/ci/architecture/repository.test.ts` in the recorded
  bounded Node26 environment. Whole-repository acceptance is still open.
- Current Core `tsc -p packages/agent-core/tsconfig.json --noEmit` exits 0
  (`core-prompt-current-type.log`). Expanded scoped Desktop typecheck initially
  rejects two untyped lease parameters (`models-widget-current-type.log`);
  explicit provider request types fix them. Tools, Models and Widget TypeScript
  now pass the task-only `models-widget.tsconfig.json` check
  (`models-widget-current-type-green.log`). This is not full Desktop typechecking.
- Provider-error compatibility acceptance: Given an edited connection binding
  or a retryable HTTP status wrapped in the existing normalized error, When a
  caller makes the next request, Then Desktop reports its existing invalid-config
  state for the revoked binding and Core preserves the existing bounded retry
  classification. Authentication and unknown effect outcomes remain non-retryable.
- Scoped tool-host acceptance: Given a frozen tools snapshot and a Core call
  scope, When an approval, question, cancellation or media result crosses the
  adapter, Then callbacks retain the same task/attempt/message identity, private
  media keys cannot resolve another task's attachment, and only neutral tool
  declarations reach Models. Desktop timeout metadata and attachment records
  never become package contract fields; the baked `_meta` schema stays intact.
- Model selection ownership acceptance: Given no default model or several user
  connection profiles, When the Desktop model capability selects a default or
  explicit model, Then missing configuration is a normal typed business state;
  the returned host-only snapshot belongs to that exact profile and no ORM row
  crosses into Core. Safe summaries exclude credentials and configuration bytes.
  A profile edit or disable revokes an old target before new effects, and existing
  default-selection transactions stay atomic and byte-compatible.
- Task model-binding acceptance: Given two tasks and a captured model-upgrade
  target, When a task acquires/releases a connection or another task attempts to
  resolve its target key, Then connection leases may share only the unchanged
  physical profile; model target keys and resource mappings remain task-owned.
  Editing the target profile revokes its old key without replacing it implicitly.
  Releasing a model at a switch does not dispose task-wide messages/audit/activity.

### Continuation: Core Host Translation

- Core retry classification RED: 1 failing / 13 passing
  (`core-retry-compatibility-red.log`). GREEN: 4 files / 27 tests
  (`core-retry-compatibility-green.log`, 1.25 seconds). Wrapped retryable HTTP
  statuses retain the existing bounded retry behavior.
- Scoped tools adapter RED: 2 failing / 3 passing
  (`core-tools-binding-current-red.log`). GREEN with the pipeline and task model
  bindings: 3 files / 13 tests (`core-tools-bindings-green.log`, 7.39 seconds).
  Host and call-scope callbacks retain their creation-time identities; valid
  objects failing a business schema do not increment protocol-parse errors.
- Models selection GREEN with connections: 2 files / 11 tests
  (`models-selection-green.log`, 4.53 seconds). Task model bindings were RED for
  the absent workflow (`task-model-bindings-red.log`), then pass in the current
  combined adapter command. Explicit selection, profile revocation and atomic
  default updates use the existing tables and transactions.
- Model-stream adapter RED: absent adapter (`core-model-stream-red.log`). GREEN
  with task bindings and connections: 3 files / 13 tests
  (`core-model-stream-green.log`, 6.79 seconds). The actual installed OpenAI
  driver receives the profile-scoped cache HIT while Desktop preserves numeric
  identities, paths and manifest fields. Revocation prevents network effects.
- Expanded scoped adapter/workflow typechecking reaches two incompatible legacy
  Widget bridge contexts (`agent-host-type.log`, exit 2). This is an integration
  dependency still to remove, not a successful full Desktop typecheck. No cast,
  compiler relaxation or coverage exclusion is used to hide it.
- Main integration scenarios: Given a committed task and the real Core host,
  When a view attaches, cancels, approves, replies or returns after hiding,
  Then projection state derives only from Core outputs and no Desktop resolver
  or second execution loop owns the decision. Configuration/resources are
  scoped to the main host; closing a client cannot close another task's lease.
- Discovery ownership scenario: Given the same shipped skills and attachments,
  When the main host prepares a turn, Then filesystem discovery/materialization
  remains Desktop-owned, pure parsing/limits stay independent of platform I/O,
  and existing prompt/attachment records retain their serialized shape.
- Production still uses the legacy execution path. Main assembly, narrow APIs,
  module isolation, legacy deletion, actual graph acceptance and CI/coverage are
  unfinished. Native builds/E2E/performance remain pending.

### Continuation: Main Host Assembly

- Skills/prompt migration GREEN: 11 files / 71 tests, 15.87 seconds
  (`skills-prompt-migration.log`). Core TypeScript exits 0
  (`core-continuation-type.log`). These are current focused checks, not full
  Desktop/native acceptance.
- Given two task-owned model targets, When authorization checks a target, Then
  it requires the owning task identity; an unchanged physical connection never
  grants another task access to that target.
- Given a Core persistence adapter created with scoped callbacks and language,
  When its caller later replaces the options, Then committed history uses the
  creation-time bindings, not replacement callbacks or mutated language data.
- Given a malformed tool call to an unavailable/excluded tool, When the
  controlled pipeline records its rejection, Then it retains the existing
  protocol-parse failure classification before tool availability classification.
- Given main, secondary or unknown native window identity, When assembly is
  requested, Then only the real main window constructs execution authority;
  other windows cannot impersonate main through route or caller-provided labels.
- Given a real Core task and the Desktop history/presentation host, When a user
  observes, approves, replies, cancels or returns to a task, Then all decision
  identities and terminal success come from Core outputs and committed barriers.
  The facade stores display records only, with no resolver or second loop.
- Current main/facade GREEN: 2 files / 9 tests (`main-sessions-green.log`, 5.73
  seconds). The command selects `tests/adapters/agent/main-host.test.ts` and
  `tests/modules/agent/sessions.test.ts` with the recorded Node26 Desktop config.
- Task-scoped authorization, immutable persistence callbacks and malformed-call
  classification RED: 3 failing / 10 passing (`main-binding-red.log`). GREEN:
  4 files / 16 tests (`main-binding-green.log`, 9.57 seconds).
- Legacy history/projection baseline: 22 files / 226 tests
  (`session-projection-baseline.log`, 45.51 seconds). This baseline does not
  validate the new projection implementation or production Core integration.
- Scoped main/facade TypeScript initially exits 2
  (`main-sessions-type-initial.log`), reaching the two legacy Widget-context
  incompatibilities through the agent persistence entry. That dependency must
  be removed; the compiler settings are not relaxed.
- Given a committed completion and a failing cleanup observer, When task
  resources are released, Then passive reporting cannot turn durable success
  into a rejected completion or change the terminal projection.
- Given a presentation subscription that cannot be established, When a session
  starts, Then it releases its subscriptions and cancels its Core task instead
  of retaining a hidden execution task or partially attached view.
- Session cleanup RED: 2 failing / 9 passing (`session-cleanup-red.log`). GREEN:
  2 files / 11 tests (`session-cleanup-green.log`, 5.31 seconds), with the same
  main/facade command. Failed attachment to presentation cancels and releases the
  Core task; diagnostics failures cannot change a committed completion.
- Given task-owned history and staged attachments/usage, When a start or terminal
  checkpoint is written through consumer-owned capabilities, Then only narrow
  attachment-record writes participate in the same native transaction, failed
  commits retain no history/usage changes, and all existing serialized snapshot,
  checkpoint, delivery-manifest and LLM-call bytes remain unchanged. Agent
  persistence does not import attachment/tool/usage business implementations.
- Narrow persistence capability RED: 3 failures (`persistence-capabilities-red.log`),
  including unintended native reads instead of the supplied staged capability.
  GREEN with the main/facade suites: 3 files / 14 tests, 6.69 seconds
  (`persistence-capabilities-current.log`). Attachment-record callbacks join the
  existing transaction; supplied serialized bytes survive unchanged.
- Broader persistence/storage continuation: 4 files pass, 3 files fail; 69 tests
  pass and 19 fail, with one suite failing import resolution (17.02 seconds,
  `persistence-ownership-current.log`). This is RED evidence, not acceptance.
  It exposes a migrated extension-parser regression, a stale Skill import and
  old test doubles that intercept superseded Usage/Attachments entries.
- Given a mixed-case image extension, When a Desktop draft is created, Then its
  original MIME inference remains unchanged. Given committed history and usage,
  When persistence tests run, Then assertions inspect real in-memory SQLite
  outcomes through the native boundary, not obsolete internal helper calls.
  Refused identity/terminal writes must reject and roll back, never masquerade
  as durable success; absent tool-result targets must report failure without
  adding assistant text. No user database or configuration is used.
- Attachment content/storage and Usage calculation/serialization now have
  Desktop module owners. Attachment caches still require creation-time lifetime
  ownership; prompt serialization and diagnostics still have legacy dependencies.
  Production Core integration and whole-repository gate/CI/coverage are unfinished.
- The first real-database persistence rerun has 106 passing / 3 failing tests
  (`persistence-ownership-green-attempt.log`, 21.01 seconds). Two new assertions
  incorrectly named a removed table; the shipped attachment association is a
  message part and will be asserted through that existing shape. The third
  exposes overlapping duplicate start writes on one persistence instance.
- Given duplicate starts for the same task writer, When the calls overlap or
  repeat after commit, Then one start barrier writes one prompt/turn/attempt and
  advances the attempt generation once. Failed starts remain retryable after
  the storage fault is removed; the native transaction protocol is unchanged.
- Duplicate start RED: 2 failing / 39 passing (`persistence-start-red.log`,
  5.24 seconds): a repeated start advanced the attempt generation, and overlapping
  starts opened overlapping writes. The task writer now owns one start promise
  and reuses its committed prompt provenance. Native transaction locking is not
  modified. The old 41-test persistence suite now asserts real SQLite rows and
  payloads, with no internal Query/Usage/Attachments helper mocks.
- Persistence/storage GREEN: 7 files / 109 tests (`persistence-ownership-green.log`,
  22.86 seconds) with the recorded bounded Desktop Vitest command selecting
  `tests/modules/agent/persistence-capabilities.test.ts`,
  `tests/modules/agent/persistence.test.ts`, `tests/adapters/agent/persistence.test.ts`,
  `tests/services/AgentService/outputs/persistence-rollback.test.ts`,
  `tests/services/AgentService/outputs/persistence.test.ts`,
  `tests/services/AgentService/reasoning-persistence.test.ts`, and
  `tests/services/AgentService/infrastructure/attachments/storage.test.ts`.

### Continuation: Prompt Transport And Committed Audit Authority

- Worktree/branch/base remain the approved values recorded above. This is
  continuation of the same implementation, with no delegation or remote writes.
- Prompt composition, instruction text, locale binding and transport reconstruction
  now belong to `app/workflows/agent`. Prompt serialization and consistent history
  reads belong to Desktop Agent. There are no forwards at the deleted prompt,
  language-context or session-transport paths. Models adapters use a Desktop-only
  envelope; neutral provider contracts never gain local paths or history records.
- Language formatting is pure and explicitly bound to the workflow's locale.
  Agent's serialized editor document contract no longer imports Tiptap. Existing
  document/snapshot JSON is not rewritten. Scoped main/facade TypeScript passed
  before these moves (`main-sessions-type-green.log`).
- Prompt/history/transport GREEN: 10 files / 44 tests, 24.01 seconds
  (`prompt-history-current.log`). The bounded Desktop command selects language,
  skills, prompt transport, session transport/context recovery/read model, message,
  model-stream, persistence and Models transport adapter suites. Scoped TypeScript
  initially found the historical optional support-status value; its consumer-owned
  type now preserves that absence rather than changing serialized bytes.
- Given a staged request for an occupied conversation, When main assembly rejects
  the new start, Then its staged resources are released and the existing task is
  unchanged; a later request remains possible. No staging entry is an execution host.
- Given a task's committed start and tool-message barrier, When a tool requests
  audit admission, Then only that task/attempt/message/session identity is accepted.
  Uncommitted, superseded and terminal scopes cannot start audit/effects. Receipt
  release follows committed checkpoints, not passive stream observations.
- Given an invalid Widget call and its filtered presentation, When Core executes
  the raw provider stream, Then validation still records the rejected call/result;
  presentation filtering never removes calls from the authoritative execution input.
- Given the original document/code extensions and MIME hints, When attachment
  inspection runs after the ownership migration, Then PDF, structured text and
  source code retain their classification. Tests exercise the real inspector and
  reader with only the native filesystem boundary replaced by fixture bytes.
- Given a captured model with no tools or an aborted attachment read, When the
  caller requests a hallucinated tool or late file bytes arrive, Then no hidden
  tool binding or subsequent file effect runs. Local cancellation settles without
  claiming the native read stopped; noncancelled media remains byte-compatible.
- At this point the production main-host wiring, UI APIs, module isolation,
  old-path removal and actual repository graph check were still unfinished.

### Continuation: Cancellable Preparation And Production Assembly

- Collected the pending bounded Desktop command selecting workflow, main-host,
  persistence adapter, tool registry/audit, materialization, inspection and content:
  8 files / 62 tests passed in 18.87 seconds (`main-workflow-preparation-current.log`).
  This validates the integrated fixture, not production bootstrap or native E2E.
- Given an abort-ignoring model/config/history read during main preparation,
  When the user cancels or closes main, Then the local task and its resources
  settle without waiting for the remote/native read; late completion cannot
  start a model request, a following tool preparation or a new file effect.
- Given an approved model switch, When Core acquires the next frozen model/tool
  binding, Then task-wide history/audit/resource mappings survive the lease
  switch and committed history and safe projections use the selected model.
- Preparation cancellation RED: 2 failing / 5 passing integration behaviors
  (`preparation-cancellation-red.log`); GREEN: 5 files / 37 tests in 14.19 seconds
  (`preparation-cancellation-current.log`). Expanded scoped TypeScript includes
  the real main workflow, model bindings, audit and attachment readers and passes
  (`main-workflow-type.log`). Full Desktop TypeScript remains environment-blocked.
- Given stored history with tools, retries, cancellation or Widgets, When the
  user reopens it through the Desktop Agent history capability, Then the same
  ordered presentation is reconstructed using consumer-owned attachment,
  translation and tool-presentation interfaces; history reads contain no provider
  credentials and do not instantiate a loop or registry.

### Recovery: Production Main-Window Integration

The frozen in-progress source is restored at the pinned baseline without staging.
The preceding milestone logs are historical worker evidence, not current checks.

- Given production window startup and a configured user connection, when the
  user submits a session command, then the installed Provider, existing Core,
  unified builtin/MCP pipeline and unchanged SQLite barriers execute that request.
  The published result and projection contain no credentials or checkpoints.
- Given pending startup capabilities, when the user submits or cancels a request,
  then only the necessary readiness barriers are awaited and cancellation cannot
  leave a hidden task or start an effect after the wait settles.
- Given a secondary or unidentified native window, when its route resembles main
  or it requests execution, then it stays a bounded client and cannot construct
  Provider, tool, Core or settings-owner fallback instances.
- Given closing main or a detached view, when cleanup runs, then main cancels and
  releases its owned execution resources while a detached view cannot stop another
  task or dispose a shared connection.
- Given a failed optional warm-up or unavailable diagnostics, when a main request
  crosses readiness, then diagnostics cannot convert the best-effort warm-up into
  a startup failure. Real preparation or save failures still reach the caller.
- Given a task that fails before its caller awaits completion, when the caller
  observes its terminal projection and later awaits the result, then the original
  failure is preserved without an unhandled rejection or a hidden retry.
- Current production entry: `main.ts` -> `app/bootstrap/index.ts` ->
  `app/bootstrap/agent.ts` -> main-only `app/composition/main.ts` ->
  `assembleAgentHost` / `createMainAgentWorkflow` -> existing Core, installed
  Provider drivers, unified tools and unchanged SQLite persistence. Main session
  composables use this injected API rather than the legacy task singleton.
- Production-bootstrap GREEN: `tests/app/bootstrap/agent.test.ts` passes all 10
  behaviors with the actual startup entry, installed SDK/Core/full builtin
  assembly and shipped SQLite migrations. The native event, filesystem catalog
  and network boundaries use controlled fixtures. Readiness RED exposed a
  diagnostic exception changing an optional warm-up outcome; the same regression
  is green after isolating passive diagnostics. These are not native E2E results.
- Scoped production TypeScript includes the startup entry, actual main/tool
  composition, workflow/observations and existing adapters and passes with no
  emit. Legacy source/caller removal, actual repository gate, whole-workspace
  checks, coverage, native E2E and release performance remain unfinished.
- Given a saved Provider base path and protocol selection, when settings previews
  its endpoints or the real driver starts discovery/generation, then both use the
  same neutral catalog calculation without constructing a Provider just for UI
  preview. Custom gateway paths and existing driver defaults remain unchanged.
- Given a slow committed-history read, when the user cancels before execution,
  then no task or model effect starts after the native read finishes and the next
  request can use that same session.
- Given a durably completed turn, when its final model is recorded as used, then
  only that model's existing last-used field changes; a failed bookkeeping write
  cannot change the committed answer or trigger another model request.
- Given existing MCP tool history, when the user reopens a session, then server
  labels come from the Tools-owned catalog without loading another tool registry.
- Given configured default and alternative models, when the search bar queries
  them through its ordinary app API, then display metadata is preserved but no
  credentials, endpoint configuration or executable Provider is returned.
- Given saved Provider settings, when a settings client refreshes available
  models, then the existing main Models instance uses the saved profile and
  returns only neutral discovery metadata over a directed, bounded client query.
  A secondary window never constructs a Provider; a missing main host times out
  without a fallback or automatic retry. Administrative discovery of a disabled
  profile remains available without authorizing Agent execution on that profile.
- Given a discovery query or Provider failure, when a client cancels, closes or
  receives a reply, then its listener/timer/request lifetime is released, replies
  reach only that concrete window, and upstream error bodies or credentials do
  not cross the public boundary. Malformed requests cannot start network effects.
- Given a saved MCP server and main's unified tools instance, when settings
  connects or disconnects it or main performs its existing post-paint startup
  connection, then subsequent real Agent turns use that same captured catalog.
  UI status events are projections, not a second registry/cache authority. A
  missing main host yields a bounded, non-retried command failure; a client does
  not execute a native connection or an MCP tool locally.
- Given a settings connection command, when main confirms the native operation
  and catalog synchronization, then the button settles from that acknowledgement,
  not from a second UI-owned wait or a dropped command failure. Reconnect waits
  for confirmed disconnection before issuing one new connection.
- Given a pending settings command, when the panel closes or selects another
  server, then its local wait and busy state settle without claiming that the
  shared native connection was cancelled. A following panel can observe main's
  actual status and issue another command.
- Given saved model capabilities and the existing metadata cache, when main or
  settings refreshes the catalog, then the main Models owner shares one bounded
  request, preserves conditional requests and native transactions, and applies
  the existing matching/precedence and serialized fields before the next turn.
  Closing a client detaches its wait, not another client's shared catalog update.
- Given an aborted main lifetime and a late metadata response, when that response
  arrives, then it cannot replace the cache or start another storage operation.
  The bundled snapshot remains lazy and seeds only the existing empty-cache path.

### Legacy Execution Behavior Migration

- Given a saved conversation and the production main entry, when the user runs
  successive tool rounds, retries a temporary model failure or changes model,
  then one Core task owns the attempt and its committed history; completed tool
  effects are not replayed and secondary clients cannot acquire execution.
- Given a failure before or after visible output, when the request retries or
  the user cancels during backoff, then the view retains committed output only,
  reports localized progress, releases live decisions and ignores late output.
- Given a tool timeout hint, invalid arguments or unavailable tool, when the
  model calls it, then the unified pipeline preserves the original `_meta`,
  timeout, audit, schema and authorization behavior without another dispatcher.
- Given reasoning, Widgets, summaries or attachment resources, when the user
  streams, reopens or retries, then presentation and existing persisted bytes
  remain compatible without exposing credentials, live instructions or internal
  checkpoints through the ordinary session API.
- Given imported history and a known or unknown model budget, when compaction
  runs, then system instructions and the latest request survive, complete tool
  exchanges stay together, summaries commit before use and rejected or cancelled
  summaries cannot become the next request's context.
- Given a refused committed-history read, when a session command starts, then no
  task or model effect is admitted, the caller receives a safe persistence error
  rather than SQL/input details, and a following request can use that session.
- Given duplicate session requests, retained terminal views and independent
  subscribers, when production commands race startup or a window detaches, then
  Core admits only one task per session, other sessions remain live, observations
  cannot change execution, and the existing five-minute view retention expires.
- Given the user dismisses a live question, when the scoped builtin receives that
  decision, then the task settles as cancelled rather than an uncertain effect,
  no following model/effect starts, decisions are released, and that session can
  accept a later request. Other tasks and unknown external effects stay unchanged.
- Given a large Widget argument burst that pauses, when its pacing interval ends,
  then the latest validated draft reaches the existing production view without
  another model chunk; final arguments, cancellation and retry cannot publish an
  older deferred draft into a finished or newer attempt.
- Given slow or rejected replaceable progress saves, when the stream advances or
  closes, then only one save is active, pending progress coalesces, the semantic
  terminal write retains every segment, and late output cannot write into a
  closed task or a later attempt.
- Given the shipped older browser target without signal aggregation, when the
  user submits, cancels, refreshes metadata or manages MCP, then actual main and
  bounded clients preserve their cancellation/deadline behavior without a new
  browser requirement or retained per-request listeners.
- Given a conversation identity assigned by the committed start barrier, when
  the user retries or follows up in that session, then model cache/calibration
  routing stays stable for that conversation and separate from other sessions.

Legacy runtime tests are migrated by observable scenario, not by preserving
obsolete executor mocks or a second production constructor. Scenarios that
previously acknowledged a failed start/terminal save are revised to the approved
durable barrier contract. The migration map and current focused results are
recorded before deleting the corresponding legacy source and tests.

### Removed Task Authority And Test Ownership

The production session command path no longer imports the legacy task center.
Its duplicate task registry, decision resolvers, notification scheduler and
projection tree are removed, not kept as compatibility facades. Core owns every
wait and attempt; Desktop retains display-only records. Runtime/executor and
Provider forwards are separate remaining removals, not claimed complete here.

| Former tests | Current behavioral owner and equivalent coverage |
| --- | --- |
| `task/center-lifecycle`, `task/center-views` | Production `app/bootstrap/agent-lifecycle.test.ts`, `app/bootstrap/agent-runtime.test.ts`: readiness races, history failure, session identity, concurrent sessions, cancellation, subscriber isolation, completion and five-minute retention |
| `task/center-interactions`, `task/interactions` | Public Core `decisions.test.ts`, production `agent.test.ts` and `agent-lifecycle.test.ts`: duplicate/stale/foreign replies, reused call identity, retry-gap/terminal late callbacks and independent cancellation |
| `task/center-notifications`, `task/task-view-contract` | Desktop `modules/agent/projection/view.test.ts`, production lifecycle/runtime: coalesced running output, immediate terminal status, safe whitelisted views and model summaries |
| Nine moved projection suites and `task/projection-approvals` | `modules/agent/projection/`: unchanged lifecycle, retry, cancellation, reasoning, compaction, tool result and locale behaviors; approvals observe issued identities instead of owning promises |
| `task/projection/widgets` | `modules/agent/projection/widgets.test.ts`: display-only upsert, final replacement, identity retargeting, removal, failed-draft cleanup and hidden tool calls; validation/drafts are tested in Tools and production |
| `task/projection/widget-publication`, `task/projection/widgets-draft-throttle` | Production `agent-widget-stream.test.ts` and Tools `widget-stream.test.ts`: leading/trailing updates, final precedence, cancellation/disposal, per-call pacing and bounded retention; no assertions on parser calls or a second timer owner |

All former paths in this table are relative to `tests/services/AgentService`.
Current Desktop paths are relative to `apps/desktop/tests`; Core paths are
relative to `packages/agent-core/tests`. A pre-aborted request now admits no task,
and a failed durable barrier rejects rather than reporting success, as approved.

### Production Analytics Behavior Migration

- Given reasoning or tool arguments before display-ready body text, when the
  production stream advances, then first-output analytics waits for body text
  and records it only once across retries and tool rounds.
- Given a live approval or remote tool wait, when the user cancels, then typed
  observations retain the phase at the cancellation instant, record each local
  tool/approval outcome once and never claim the remote effect stopped. A remote
  server's own error does not become user cancellation.
- Given failed and successful provider attempts, when the task finishes or
  cancels during retry backoff, then every started call contributes once to the
  request's usage/pricing coverage. Missing usage is not fabricated zero usage.
- Given an approved model upgrade and its committed tool checkpoint, when the
  upgraded request retries, then the next calls stay on that model, the completed
  switch/tool/approval contributes once, and the user's saved default is unchanged.
- Given a failed durable terminal barrier or an unavailable analytics channel,
  when the request settles, then the public result remains the authoritative
  persistence outcome and telemetry cannot delay, retry or change it.

### Main Settings Ownership Migration

- Given production main startup and an ordinary preferences client, when the user
  changes a preference through settings or an approved Agent tool, then both use
  the same creation-time single writer and existing persistence/compensation protocol.
- Given Tools-owned browser/search configuration containing saved credentials,
  when an ordinary window reads preferences, then no business configuration or
  credentials enter its snapshot; only the settings administration client receives
  that configuration through the existing directed settings channel.
- Given closing main, detaching a store, or reopening a secondary client, when
  disposal runs, then only main releases the writer, detached projections cannot
  close another caller's owner, and unavailable clients never construct a fallback.
- Given an editable browser/search draft and a settings administration projection,
  when another client commits a different field, then the panel keeps its local
  edits, incorporates the committed field, and saves through the same owner.
- Given a saved builtin configuration, when settings disables that tool, then the
  next production turn omits its declaration and the main registry rechecks
  revocation before effects. An ordinary window has no administration capability.
- Given the builtin settings panel and its main-owned administration client, when
  the user changes a tool or opens its logs, then the panel observes committed
  main results, keeps unrelated tools unchanged, and cannot fall back to local
  SQL when main closes. Late log reads cannot replace another selected tool.
- Given a settings draft with an acknowledged write still pending, when the
  user closes the panel, then that authorized write may finish but no detached
  autosave or late projection can submit a later draft.
- Given a settings command in the production Agent path, when preference
  initialization is delayed or cancelled, then no model request or settings
  effect begins before readiness and cancellation cannot start a late task.
- Given an approved settings command and a failed native or storage boundary,
  when the owner can confirm restoration, then the tool reports the unchanged
  value; an unconfirmed effect instead stops Core without replay or private
  failure text. Locale, validation, approval and saved-with-sync-warning
  behaviors use the same production writer, not a test-only global owner.
- Given builtin configuration controls and a native picker or model query,
  when the settings panel edits, refreshes, closes or becomes disabled, then
  narrow application capabilities supply safe results and late results cannot
  edit detached controls or replace a newer model list.

### Ordinary API And Core Dependency Regressions

- Given a Core entry or a package-local helper, when it imports an external
  dependency not explicitly declared as neutral, then the repository gate
  rejects it; installed Provider SDKs remain Models-owned rather than becoming
  legal through an unrecognized package name.
- Given an ordinary API, when it reexports main assembly directly, through an
  API helper, or through a type/dynamic edge, then the gate rejects the authority
  escape even when the UI only imports a path named `app/api`. The composition
  root may still construct the host and inject safe commands into that API.

### Metadata Persistence Boundary Migration

- Given discovered models or a refreshed metadata catalog, when metadata is
  synchronized, then Models owns candidate matching and upstream precedence,
  while designated database capabilities own SQL and the existing transaction.
  New rows, recorded declarations and synchronized columns commit or roll back
  together; custom metadata and persisted JSON bytes retain their existing rules.
- Given a catalog replacement that fails while synchronizing models, when the
  native transaction rejects, then the previous catalog, aliases, freshness
  statistics and model rows remain available for a later successful refresh.

### Usage Query And Maintenance Ownership

- Given saved request usage and an ordinary settings dashboard, when the user
  filters, ranks or reads the archived trend through the usage API, then the
  same query results reach the view without UI imports of SQL or database rows.
- Given startup usage maintenance, when its existing deadline is due, then the
  Usage owner runs the unchanged rollup and existing optional detail policy;
  the designated database capability owns SQL and a failed run leaves startup
  usable. No retention default, transaction or persisted shape changes.

### Search Window Ownership

- Given production main startup, when independent search surfaces query or
  activate a result, then one assembled Search host supplies isolated sessions,
  freezes each result's provenance and rejects obsolete actions. Closing one
  surface never cancels another surface or changes its provider registrations.
- Given a secondary window or disposed main search host, when a caller requests
  a search session, then it cannot construct a replacement registry. Existing
  in-flight native queries settle locally and late results cannot revive them.
- Given skill drafts and file references, when the user selects a result, then
  consumer-owned search contracts preserve current skill filtering, path identity,
  click ranking and accepted-reference history without sibling-module imports.

### Window Event Capability Migration

- Given a Search, Settings or Tools event client, when the caller subscribes,
  unsubscribes or publishes an allowed topic, then the existing native event name,
  payload and failure behavior remain unchanged without a global business locator.
- Given a runtime value outside that client's declared topics, when a caller
  attempts a subscription or publication, then the client rejects it before native
  delivery. A public path or a TypeScript cast cannot grant another capability.
- Given font readiness and window shell initialization, when native state arrives,
  then the designated platform owner preserves the existing font/geometry behavior
  without reaching business modules through neutral utilities.

### Computer Control Administration Ownership

- Given production main and a settings client, when the user changes computer
  control configuration, then the existing main Tools instance persists the same
  bytes and invalidates its own grants/bindings; settings creates no execution
  instance and cannot invoke arbitrary driver tools through administration.
- Given overlapping preference changes, a driver download or a closed client,
  when an administrative operation settles, then confirmed writes keep their
  existing ordering, errors remain observable, and detached waits cannot publish
  a later result or retry an unknown native effect.
- Given a secondary window without main, when it requests computer administration,
  then it fails within a bounded deadline without native or database fallback.

### Clipboard And Attachment Draft Ownership

- Given independent main-window lifetimes, when a shortcut clipboard snapshot
  is consumed twice, then each lifetime accepts it once without sharing a
  mutable duplicate guard. Secondary windows receive no clipboard-reading host.
- Given a clipboard read that finishes after main closes, when native returns
  data or a browser paste file, then the detached caller receives cancellation
  and cannot start attachment persistence or publish a late draft.
- Given explicit browser paste data and a failed native clipboard read, when
  the user pastes, then existing whitespace, safe HTML conversion, file caching
  and attachment records retain their current behavior and serialized shape.

### MCP Catalog And Administration Ownership

- Given production main and settings clients, when the ordinary main projection
  reads the MCP catalog, then it receives names, enabled state and declarations
  without connection commands, environment variables, URLs or headers. Only the
  directed settings administration client can read or change saved configuration.
- Given a saved MCP configuration or tool setting, when settings edits it, then
  Tools owns validation and the same existing database operation; saved JSON
  strings, deletion semantics and live execution revocation remain unchanged.
- Given a detached settings client, failed write or repeated request identity,
  when a response arrives, then it cannot create a fallback writer, reveal a
  private database/native error, or repeat an acknowledged mutation. A later
  explicit request can succeed after the boundary failure is removed.

### Model Configuration Administration Ownership

- Given ordinary main, tray and settings clients, when model configuration is
  requested, then only the settings administration capability can read saved
  credentials or edit profiles; ordinary model selection remains a safe catalog.
- Given provider or model edits, when settings saves them through main, then
  Models owns validation and default-provider rules while the existing native
  database transactions, deletion behavior and serialized configuration remain.
- Given a failed write, detached client or invalid runtime patch, when settings
  submits a change, then saved rows remain consistent, internal errors stay
  private and a later explicit valid change can succeed.
- Given the actual AI settings panel after its main host closes, when an edit
  is submitted, then no local database fallback saves it; the panel reports a
  bounded failure and a subsequent host lifetime can load the unchanged profile.
- Given model metadata freshness and an ordinary client, when the client asks
  whether the catalog is missing or when it last changed, then the existing main
  Models owner supplies only those values. A detached client or absent main
  cannot read local SQL or obtain a metadata persistence capability.
- Given an admitted configuration write and another queued change, when main
  closes before the second change starts, then the first native operation may
  finish but the queued change cannot begin after its owner lifetime ends.


### Production Models Administration Evidence

The actual AI settings panel and its eight model/provider components no longer
import database queries or row types. Settings receives the privileged profile
client from production bootstrap; ordinary clients retain safe model selection.
Metadata freshness and missing-catalog queries now use the main Models instance,
and the ordinary metadata API exports no persistence writer.

- Panel lifetime RED: editing after main closed changed the saved endpoint through
  the view's direct SQL import. GREEN: the actual panel preserves the saved row and
  reports a bounded localized failure, with no fallback writer.
- Owner lifetime RED: a queued profile edit began after main disposal. GREEN:
  admission closes before shutdown waits; an admitted native write may finish,
  while a queued change cannot begin. The owner also bounds pending writes.
- Production integration: six files / 35 tests passed, covering model
  administration, metadata, actual panel layout/configuration analytics, detached
  panels and native default transaction rollback. Four form/locale files / 46
  tests passed separately. These are focused results, not whole-suite totals.
- Scoped production TypeScript and targeted Desktop ESLint passed. Native default
  selection SQL is unchanged; its typed refusal removes the database's i18n import.
- Actual graph: 1718 files / 369 reports (214 UI, 129 legacy paths, 25 unresolved
  imports, one database-to-i18n boundary). There are no parse/source errors or
  runtime cycles. The graph remains failing; no baseline or exclusion was added.

### Data Management Workflow Migration

- Given production main and a settings client, when the user reads history
  statistics or clears one existing history category, then the Agent-owned data
  capability performs the same queries and deletion operations; settings never
  reads SQL or constructs a maintenance owner.
- Given a chosen backup path or import mode, when settings confirms the operation,
  then one main workflow calls the unchanged native backup/import contract once.
  A successful import records the same versioned restart notice bytes. Cancelled
  pickers, malformed or duplicate commands and absent main cannot cause fallback
  writes or replay an unknown native effect.
- Given an admitted backup/import and a detached client, when native finishes,
  then the authorized operation may finish, but detached progress cannot reopen
  a dialog and no further native or database operation is admitted after disposal.
- Given a saved import notice and the main search surface, when startup consumes
  the notice, then it preserves the existing delete-before-notify order, active
  language and legacy raw-text fallback. Settings and tray receive no startup
  storage capability; a closed main lifetime cannot consume another notice.
- Given the bounded command history is full or an old backup command arrives,
  when Settings requests another effect or repeats the old envelope, then main
  refuses admission until space expires and never replays a completed effect.

### Production Data Management Evidence

The existing main composition now creates one data-management workflow. Settings
receives its directed client from production bootstrap. The actual panel uses
that client for statistics, history clears, backup/import and relaunch; it no
longer imports SQL, backup owners, persisted marker helpers or the process plugin.
Agent owns history maintenance. The native database capability retains the exact
export/import payloads and native transaction ownership. Import-success marker
serialization moved into the workflow without changing its bytes.

- Initial production RED: seven behaviors failed because the production settings
  client exposed no data-management capability. GREEN covers real bootstrap,
  SQLite, picker cancellation, both import modes, safe native failures and absent
  main, with no local maintenance fallback.
- Replay RED: the 65th command evicted completed history and was admitted. GREEN
  refuses admission at capacity and rejects expired envelopes, so duplicates
  cannot replay a completed effect through history eviction or expiry. Native
  effects already admitted may finish; shutdown prevents subsequent marker writes.
- Production regression batch: six files / 54 tests passed, including actual
  bootstrap, data-management commands, panel lifecycle and localization, backup
  localization and existing startup notices. Detached results do not revive
  dialogs; successful imports preserve restart-notice bytes and the countdown.
- Removed the unused global startup-readiness registry. Its four behavior tests
  now exercise the instance-scoped readiness factory used by real bootstrap;
  all four passed. Startup-notice consumption still has a legacy service caller
  and remains an explicit migration item.
- Scoped production TypeScript, the actual data-management Vue view check,
  targeted Desktop ESLint and formatting passed.
  That milestone's graph had 1727 files / 347 reports: 194 UI-boundary, 128 legacy-path
  and 25 unresolved-local reports, with no parse/source errors or runtime cycles.
  The graph remains failing; no exclusions or baseline were added.

### Production Analytics And Updates Ownership

- Given independent window lifetimes, when one product observer exhausts its
  stalled native admission budget, then other windows retain their own bounded
  observations. Disposed observers release late handles without emitting.
- Given ordinary product clients, when they inspect their capability, then raw
  event submission and consent mutations are absent. Settings alone receives
  the privacy-choice capability; native still owns identity, consent and delivery.
- Given real main bootstrap and a Settings client, when both request updates,
  then one existing controller performs the native check and both observe its
  state. Settings sends directed commands without constructing another controller.
- Given a selected update, when Settings downloads or installs it, then main
  preserves package identity, the original operation identity and native handoff
  payload. Existing quiet hours, retry timing and reminder-history bytes remain.
- Given closing main during a native check, when its late result arrives, then
  no detached completion writes preferences or publishes state. Auxiliary windows
  cannot initiate updater effects and receive no preference administration.

The production entry now assembles instance-scoped Analytics and the main Updates
owner. Product views receive narrow observations, Settings receives directed
update commands, and the old Analytics/Updates singleton implementations are
removed. The updater controller and reminder behavior were moved and injected,
with native install, consent, notification and persisted contracts unchanged.

- Analytics focused batch: ten files / 128 tests passed, covering all 19 shared
  event fixtures, bounded admission, consent epochs, ordering, provider edits,
  copy actions and history selection through real main bootstrap and SQLite.
- Updates owner batch: twelve files / 133 tests passed, including four new real
  bootstrap scenarios and existing recovery, lifecycle, reminder and handoff tests.
- Updates view batch: four files / 96 tests passed. Views now exercise the real
  Settings client with its peer supplied at native event delivery.
- Current actual graph: 1746 files / 249 reports, comprising 112 UI-boundary,
  111 legacy-path and 26 unresolved-local reports. No parse/source errors or
  runtime cycles. That historical graph still failed; no baseline or exclusion was introduced.

### Independent Parent Gate And Data Management Review

- Given a UI import of bootstrap or main startup through static, reexport, type
  or dynamic edges, when the repository gate checks it, then it rejects that
  direction even if the startup file currently has no privileged dependencies.
  Five fixtures failed before the parent fix; all 60 architecture fixtures passed
  afterward. Earlier Core SDK and API-constructor probes also reject their escapes.
- Independent parent production verification passed two files / 16 tests for
  Data Management and ordinary preference access. Reviewed command replay,
  disposal and persistence paths produced no additional confirmed finding.
  This is focused evidence, not whole-refactor acceptance.

At that review milestone, legacy execution/builtin removal and remaining test
migration were still pending. Later milestones below supersede that source-work
status. Native E2E and release P50/P95/memory acceptance remain unverified.


### Main-Owned Startup Notices And Per-Window Presentation

- Given a saved restart marker, when the actual main client consumes notices,
  then preferences load first, simultaneous consumption shares one operation,
  deletion precedes notification and existing marker bytes/legacy text survive.
  Settings receives no consumption capability. Closed main cannot consume a
  later marker; a storage refusal retains it for a later attempt.
- Given each native window identity, when bootstrap supplies presentation
  commands, then only main receives search geometry, shortcut and reminder
  operations; Settings receives its own chrome and diagnostics administration;
  Tray receives show/settings/quit/menu operations; Glow receives feedback only.
  UI receives no native handle, arbitrary command invoker or arbitrary topic.
- Given a closing presentation lifetime, when a listener registers late or a
  native event arrives afterward, then the listener releases immediately and
  detached observations and later effects are refused. Existing native payloads
  and renderer geometry ordering remain unchanged.

The production bootstrap provides these instance capabilities. Search geometry,
Settings chrome/shortcut diagnostics, Tray and Glow no longer import the native
facade or Tauri SDK. File presentation/index assets and reveal actions now use
Search's existing owner. The old Startup service implementation and callers are
removed; its localization and legacy-marker regressions use actual main/SQLite.

- Window/Search caller batch: ten files / 241 tests passed, covering panel drag
  and resize, lifecycle, Settings controls/shortcut capture, asset loading and
  result actions. This is focused evidence, not a whole-suite total.
- Combined startup, Updates, window role, Tray, Glow and Search lifecycle
  verification passed 21 files / 207 tests after the obsolete whole-native mock
  was replaced by native command boundaries. Earlier partial batches are
  historical and are not added to this result as a whole-suite total.
- Scoped window capability, Search owner and value-contract TypeScript passed.
- Current actual graph: 1758 files / 136 reports: 110 legacy-path and 26
  unresolved-local; zero UI-boundary reports and no parse/source errors or
  runtime cycles. It remains failing; no baseline or exemption was added.

That milestone still required legacy execution/builtin removal and equivalent
test migration. Later milestones below record that removal and workspace wiring.
Native E2E and release P50/P95/memory acceptance remain required and unverified.

### Current-Owner Behavior Migration

- Given saved tools, model profiles and a UI locale, when descriptors, approvals
  and history are read through the current production owners, then schemas stay
  locale-independent and visible labels, durable history and uploaded resources
  retain the existing behavior. Legacy implementation tests are being migrated
  before their duplicate implementations are removed.
- Given an MCP connection or completed remote tool effect, when optional status,
  catalog bookkeeping or attachment conversion fails, then the original native
  connection failure remains diagnosable, committed catalog rows stay atomic and
  usable text results survive. These regressions use SQLite and native responses;
  database and attachment business owners run for real.

Current focused batches passed separately: encoding/search/shell seven files /
115 tests; read/search/skills/provider eleven files / 137 tests; history eight
files / 99 tests; package uploads/transport/connections three files / 42 tests;
tool localization/schema four files / 16 tests; MCP formatting two files / 56
tests. These are focused results, not a combined whole-suite count. The graph at
that milestone was the failing 1758-file / 136-report graph; the current status
table and later evidence supersede it.

### Legacy Removal And Workspace Integration

- The real production call path is `main.ts` -> `app/bootstrap` ->
  `initializeAgentWindow` -> main-only `assembleDesktopMainAgent` ->
  `createMainAgentWorkflow` -> `assembleAgentHost` -> existing Core. It uses the
  installed Models drivers, unified Tools pipeline and unchanged SQLite barriers.
  The old task center, runtime, request executor and legacy service tree are
  removed. No compatibility forward or secondary execution authority remains.
- Retained behavior suites now use current owners. Actual root startup tests
  mount the production app/router with SQLite; Settings localization uses real
  directed clients and components; automatic update scheduling uses actual main
  assembly. Retired private-class suites were compared against current-owner
  behaviors before removal. Their implementation assertions are not acceptance.
- Actual source graph after legacy removal: 1644 files, zero violations, parse
  errors, source errors or runtime cycles. No production exclusion or baseline
  was added. The final 1648-file graph below includes the later adapter edits.
- Normal workspace source/test typechecks include both packages. The normal
  Desktop test command includes all package suites in a separate Node project.
  Package build checks source without emitting duplicate SDK artifacts; Desktop
  bundles the private source packages. Frozen lockfile validation with the
  repository's declared pnpm version passed without changing resolved versions.
- CI classifies package and architecture changes as Desktop changes and checks
  the actual repository graph before its fixtures. Overall coverage includes the
  extracted source with the existing global floors 90/84/88/91 and moved owner
  floors unchanged. Patch coverage measures Desktop plus both packages at 85%.
- At the legacy-removal milestone, 15 files / 456 repository CI tests passed, including all 60
  architecture fixtures. Package source/test typechecks and package/tooling lint
  passed. Normal package plus production-main batch: 15 files / 190 tests passed
  before the latest adapter regression; focused retry/transport 13 tests and
  workspace/shard contracts 51 tests passed separately. These counts overlap and
  are not a whole-suite total.
- Given a saved connection changes before another network effect, when Core or
  a Desktop model caller uses its frozen binding, then the Desktop adapter must
  preserve the configuration refusal through installed SDK causal wrappers.
  All three regression surfaces failed before the adapter fix. Cancellation
  remains cancellation, and the refused request makes no network effect.
- Given the normal patch-coverage command and absolute package report paths,
  when it applies its declared repository root, then covered extracted lines
  remain covered. The regression failed before correcting the script's doubled
  parent-directory root. Missing extracted coverage still fails the 85% floor.
- At this milestone, a settings-panel test-helper typecheck exhausted its
  bounded heap. Main-source and repository-CI typechecks passed. Later
  milestones record the complete frontend suite and both Desktop typechecks.
- Release configuration remains out of scope. Its metadata-snapshot staging
  line still names the removed legacy path; this requires explicit maintainer
  coordination before a release. No forward was restored to preserve that path.

### Full Frontend Caller Verification

- The first complete normal frontend run collected 620 files: 570 passed and
  50 failed, with 6920 passing and 241 failing tests plus 13 collection failures.
  This is failing evidence, not acceptance. Current-owner test callers are being
  corrected without reintroducing legacy owners or implementation mocks.
- Given a standalone title bar without an injected window capability, when it
  renders or its close control is pressed, then it remains harmless and renders
  without constructing or resolving a native window. The retained two behavior
  tests failed before the optional presentation-input fix; the six normal
  title-bar behaviors already passed. This preserves the previous standalone
  component behavior while all native effects stay behind the injected API.
- Given main or Settings components under test, when they use preferences,
  clipboard drafts, search, updates or MCP administration, then their fixtures
  provide the actual production clients and shipped SQLite owner. Native event
  delivery remains at the Tauri boundary; ordinary clients cannot publish
  privileged business events.
- Current normal frontend rerun passed all 620 files / 7339 tests. This includes
  both extracted packages and the current production bootstrap/SQLite suites.
  The preceding 50 failing files also passed together as a focused 541-test
  batch. Those overlapping results are not added into a larger suite total.
- Current actual graph passed with 1648 files, zero violations, parse errors,
  source errors or runtime cycles. Current main-source, both package source/test
  and repository-CI typechecks passed. A transitive scheduler test-helper check
  exhausted its heap at this milestone.
  Smaller caller diagnostics use the installed TypeScript/Vue language tools,
  preserve all dependency types, and report their exact selected scope.
- The former Event Service split its runtime event declaration enum into the
  public event-contract entry. Both that entry and native event delivery retain
  the former 90/100/100/90 owner floor. The CI floor-preservation regression
  failed before adding the declaration entry; no coverage floor was reduced.
- The unused model-workflow constructor wrapper was removed after confirming
  there are no source or test consumers. Production model selection, connection
  leases and transport continue through the existing task binding workflow.

### Desktop Type And Caller Verification

- Given the same published builtin declarations in two UI locales, when the
  user reads the model-facing schemas, then the read tool has an object schema
  and the complete schemas match across locales. The prior test compared two
  `undefined` values. The object-schema assertion failed before the test read
  the public `input_schema` field.
- The provider form and builtin toggle supply the `0 | 1` flags required by the
  current write APIs. The MCP composable exposes its existing connection-error
  result to both buttons. Desktop keeps its ES2020 target with native error
  cause declarations for the extracted source packages. Vitest uses the Promise
  declarations for its Node 22+ runtime.
- The gated source graph passed across 1648 files with zero violations, parse
  errors, source errors or runtime cycles. The migrated caller and production
  bootstrap regressions passed 31 files / 579 tests. These suites overlap the
  full frontend run.
- The Vue language checker found zero diagnostics in individual-file batches
  covering all 759 Desktop production files and all 649 Desktop test/helper
  files. The full project then passed both normal `vue-tsc --noEmit` checks,
  with 2642 compiler files for Desktop source and 3468 for the test project.
  Both package source/test projects and repository CI types passed separately.
- The scheduler retains the baseline's in-memory task registrations. The
  baseline has no persisted scheduler table or settings format. Persisting new
  schedules would require a separately approved storage contract.
- Both root commands `pnpm type:check` and `pnpm test:typecheck` passed. Each
  included both source packages and the normal Desktop project. The two package
  build scripts also passed. The full frontend rerun after the caller fixes
  passed 620 files / 7339 tests.
- The Desktop production Vite build transformed 5382 modules and emitted the
  application entry, assets and Monaco worker. The build reported chunks over
  500 kB after minification. Bundle size and build time do not measure runtime
  P50/P95 or steady-state WebView memory.
- The offline Site build emitted two static pages and the Pagefind search index.
  Astro warned that the `i18n` collection was missing or empty. The Rust
  workspace passed `cargo fmt --all -- --check` against the Desktop manifest.
- Given an extracted package, session or MCP owner changes, when the repository
  classifies the affected area, then the existing label reaches its new source
  path. All four routing tests failed on the deleted service paths and passed
  with the current ones.
- Given covered and untouched files in Desktop, Core and Models, when the
  installed V8 provider runs the normal project patterns and coverage policy,
  then the report includes all six files with the corresponding hit counts.
  The fixture's 50% line coverage fails the existing 91% global floor.
- Repository CI passed 15 files / 460 tests, including all 60 architecture
  fixtures. UI-preview tooling passed 17 files / 217 tests. Workspace formatting
  passed. ESLint reported zero errors across Desktop, packages, architecture
  tooling and repository CI, with 42 Desktop warnings.
- Product acceptance still requires the actual overall and patch coverage
  reports, native E2E and comparable before/after release P50/P95 and memory
  measurements against the 5% budget.

### Local Patch Coverage Inputs

- The local patch command originally counted zero of the 60 untracked Core and
  Models sources. Six CLI cases failed across repository-root and Desktop
  invocation, including cases where missing package coverage let the gate pass.
- The command now combines the merge-base diff with Git's nonignored untracked
  sources. Both coverage suites passed 35 tests. The real checkout input
  inventory included 409 new Desktop sources, 16 Core sources and 44 Models
  sources. The actual graph again passed across 1648 files. The root
  `pnpm test:typecheck` rerun passed both packages and the Desktop test project.
- The full frontend suite then passed 620 files / 7341 tests, including the
  production bootstrap, both packages and the patch coverage CLI regressions.
- The 85% patch floor and the global and per-owner floors still apply. Actual
  percentages require the complete workspace V8 report.

### Parent Boundary And Native Acceptance

- The parent reproduced 16 API-boundary escapes before restricting database,
  provider, workflow and unreviewed native access. Platform presentation bridges
  now admit exact source/target/binding combinations. Neutral metadata encoding
  remains available without granting provider SDKs. APIs, workflows and adapters
  reject dependencies on UI state and owner construction.
- Five additional CLI cases reproduced raw `invoke` access through the Tauri
  root `core` export, including namespace, reexport and dynamic-import forms.
  They now fail outside the designated native adapter; unrelated root Tauri
  capabilities remain available to platform code.
- Repository CI passed 15 files / 485 tests, including 85 architecture fixtures.
  The actual 1648-file graph has zero violations, parse errors, source errors or
  runtime cycles. Repository test types and scoped gate/test lint passed.
- Product source and frontend test hashes still match the worker's verification
  record. The native debug build with the current production frontend bundle
  passed using the locked dependencies and the shared Cargo target. Rust emitted
  62 warnings; Rust sources and the database schema remain unchanged.
- Native behavior smoke and full workspace V8 coverage are being measured.
  Debug build success does not satisfy the release P50/P95 and memory budget.

### Parent Validation Harness Follow-up

- Given the metadata public entries, when repository CI checks their eager
  dependencies, then the same two assertions cover the complete source graph
  in Node. Static source analysis belongs with the architecture tests rather
  than the browser behavior suite and its V8 product instrumentation.
- The first completed V8 run passed 619 files / 7339 tests, but metadata graph
  setup exceeded its 60-second hook budget and skipped two assertions. It did
  not emit a coverage report and is not a passing coverage result. Moving the
  static assertions to repository CI preserves them without raising the timeout,
  excluding product sources or changing coverage floors.
- Native diagnostics reproduced a default `Alt+Space` collision with the
  isolated Openbox session. Removing only that session's window-menu binding
  allowed the unchanged product to save the language successfully. No product
  shortcut, settings recovery policy or native permission was changed.


### Parent Coverage And Native Execution Acceptance

- The complete V8 run measured 619 files / 7339 passing tests with zero skips.
  Statements 91.58%, branches 85.06%, functions 92.41%, and lines 93.10% meet
  the unchanged global floors. Patch coverage was 93.0878% across Desktop and
  both packages, including 469 eligible untracked sources.
- That run still failed the window-events owner function floor: 13/14 functions.
  A behavior test now publishes through a separately created event capability,
  observes its payload, unsubscribes, and confirms later delivery stops. The
  focused event suites pass 6 tests; full coverage is being rerun before claiming
  that the owner gate passes. Production event code and coverage policy did not
  change.
- The parent compared every staged index entry to HEAD; their paths, modes and
  object IDs match. The raw index hash change reported by validation is not a
  staged source change. A subsequent metadata-test hash difference was the
  parent's recorded Prettier invocation, not an unexpected code edit.
- Native Linux/WebKit verification with the built debug application passed two
  actual Agent flows using an isolated database and local OpenAI-compatible
  protocol fixture. The first request renders and persists its answer and
  completed attempt. The second retains conversation history, executes the
  settings-read tool through the unified pipeline, continues the model stream,
  and commits its tool result and completed turn in the same session.
- These native results establish production wiring, not remote-provider
  compatibility or release performance. Release P50/P95 and memory comparison
  remain pending.

### Parent Final Local Verification

- The complete V8 rerun passed 620 files / 7340 tests with zero skipped tests.
  Statements 91.58%, branches 85.06%, functions 92.43% and lines 93.10% pass
  every unchanged global and owner floor. Window events now covers all 14/14
  functions. Patch coverage passes at 16606/17838 changed lines, or 93.09%,
  including all 469 eligible untracked product sources.
- All 1621 captured frontend source/test/config hashes and every coverage policy
  hash match the start of that run. V8 still warns while parsing three type-only
  files; TypeScript emits no executable statements for them. The unchanged
  patch gate conservatively counts their 205 physical lines as uncovered.
- Repository CI passed 16 files / 487 tests, and its TypeScript project passed.
  The current 1650-file architecture graph reports zero violations, parse/source
  errors and runtime cycles. UI-preview tooling passed 18 files / 228 tests,
  including the font helper's 11 regressions.
- Native cancellation now has direct evidence: after partial model output the
  user presses Escape, SQLite records cancellation, and later provider output
  cannot appear in the UI or replace the cancelled state.
- Native prompt/settings verification passed 13 tests, covering multiline input,
  preference persistence, bilingual search and skill selection, disable, restore
  and deletion. Three platform/visual assertions were excluded from this Linux
  run; it is scoped behavior evidence, not the complete native or visual suite.
- Native RED evidence exposed two E2E assumptions: WebDriver context selection
  did not focus the native window, and WebdriverIO's chord-oriented `keys()`
  dropped a repeated character in the fixture name. The skill helper now waits
  for native focus and uses the driver's text-entry API. The original behavior
  assertions pass without changing the product or the fixture name.
- Font-helper regressions fail before waiting for the product-owned WOFF2-to-TTF
  fallback and preserving its final CSS source. Native settings verifies actual
  glyphs in both windows. The independent font spec also reproduced an early
  network failure; it now uses the same readiness/glyph check before inspecting
  the final source, and its native rerun passes. No test substitutes a font data
  URL or changes product CSP.
- Database schemas, migrations, persisted formats and Rust sources are unchanged.
  There is no release-profile binary on this machine, and available storage does
  not accommodate baseline and candidate release builds alongside the protected
  shared caches. Before release, measure both on the same device/DPI/WebView and
  prove affected cold/warm P50/P95 and steady-state memory stay within 5%.
- The final cleanup synchronizes the release workflow with the metadata generator
  at `apps/desktop/src/modules/models/metadata/snapshot.json`. A regression checks
  that the generated snapshot is included in the workflow's staging command.
  Release targets, permissions, environments and publishing conditions are unchanged.

## Final cleanup and current-main integration

Given the main composition uses Core streaming and main-owned interactions,
when the refactor is prepared for review, then no test-only legacy Desktop
provider adapter or promise-based approval helper remains in production. The
live stream binding-revocation, discovery recovery and interaction-store
regressions remain covered.

Given the model metadata snapshot moves with the Models module, when release
refresh stages the generated snapshot, then it stages the same path used by the
metadata generator. Release targets, environments, credentials and publishing
conditions stay unchanged.

Upstream reading-width and queue/steering features added after the pinned
baseline must be preserved before this branch is mergeable with current main.

Cleanup verification before the current-main merge: the two gate/release suites
pass 101 tests; repository test types and focused lint pass. The actual graph
contains 1658 files with zero boundary violations, parse errors, source errors
or runtime cycles. The live Desktop cleanup regressions pass 41 tests.

Package review removed an unused internal token estimator and redundant private
attachment-state wrappers. Four real Models-stream-to-Core regressions first
failed because reasoning-end metadata was discarded. Core now retains closing
OpenAI encrypted content and Anthropic signatures in the next tool round,
checkpoint and terminal output, with visible or empty reasoning. Focused Core
(56 tests), Models (42 tests), package source/test types and scoped lint pass.


### Current-main Integration Acceptance

The delivery branch incorporates `main@3e3c5560e3a697472cb38ced8d1feca4984759cf`,
including conversation reading width (#803) and queue/steer (#796). The Core
extraction must preserve those already-shipped contracts. Migration `0006`, its
journal/snapshot, the database schema and the pending-message queries are copied
unchanged from that main commit; this integration introduces no new stored shape.

- Given a saved reading width, when another window loads a settings snapshot,
  then it receives the same width and the conversation uses that width.
- Given a running response, when the user queues, edits, reorders, promotes,
  removes or clears pending messages, then the main-owned queue preserves the
  published command semantics and persists the same pending-message payload.
- Given immediate steering, when the next safe non-tool chunk arrives, then Core
  closes the current model request, saves the partial assistant segment and
  starts the continuation without cancelling the task. An already-started tool
  call and all sibling tools/approvals finish before priority delivery.
- Given failed queue storage or cancelled startup, when the user explicitly
  resumes or clears the queue, then a stale asynchronous write cannot duplicate,
  lose or resurrect a message. Retired empty sessions and disposed asynchronous
  loads release their in-memory state.
- Given selected skills in a queued message, when delivery retries or the task
  restores history, then private skill content stays transport-only while the
  existing input snapshot remains recoverable.
- Given an isolated native E2E application, when the harness changes a model or
  shortcut, then it uses the same Settings-to-main administration and settings
  commands as the product; it cannot write directly to SQL from SearchView or
  register an OS shortcut behind the settings owner's snapshot.

Verification results for this integration are recorded separately from the
pre-integration full-coverage and native results above. Earlier passing counts
are not evidence for the newly merged queue paths.


### Parent current-main validation

- Core 9 files / 82 tests, backend 13 files / 229 tests and UI 26 files /
  480 tests pass across the recorded focused batches. Repository CI passes
  16 files / 495 tests, including the old PR review regressions.
- The real dependency graph covers 1681 files with zero boundary violations,
  unresolved source/parse errors or runtime cycles. Drizzle error unwrapping
  now belongs to `database/errors.ts`; pending-message persistence consumes that
  capability instead of importing the ORM exception into the module.
- All 18 obsolete source/test files restored by the main merge were removed
  only after mapping their new assertions to Core, bootstrap, session and
  projection suites. Real SQLite output and attachment/storage regressions
  remain. Upstream queue payloads and migration 0006 are preserved unchanged.
- Production frontend and native Debug builds pass. The final integrated native run
  passes eight Core scenarios, all three MCP scenarios, all seven data management
  scenarios and all three queue-recovery scenarios. One queue/steer scenario
  passes before dragging and cleanup fail, preventing the remaining 18 cases.
- Native acceptance remains incomplete: Linux/WebKit drag text selection,
  expanded-window cleanup and a model selector outside the viewport fail.
  Drag CSS and the Rust resize owner match main; the resize composable now uses
  injected window APIs. These remain open
  acceptance findings, not waived checks. Exact results and reproduction are
  in `docs/testing/rfc710-e2e-results.md`.
- Earlier full frontend and coverage totals describe the pre-integration
  candidate. Published-head CI must rerun the complete matrix, including
  coverage, native Windows E2E and visual assertions. Release P50/P95 and
  memory acceptance against the 5% budget remains unmeasured.


### Final review: pending preparation cancellation

Given a claimed pending input is awaiting attachment or selected-skill I/O, when
the user cancels or closes its owner, then cancellation retains the durable input
and does not report it as invalid. Given the user clears a claimed input while
attachment persistence preparation is pending, when preparation completes, then
no transaction inserts that input and Core receives no delivered message. Claim
and cancellation checks occur immediately before the delivery transaction starts;
a delivery already accepted into a transaction retains its atomic settlement.

Four new real-workflow/SQLite regressions reproduced both review findings before
the fix. Cancellation is now checked before classifying preparation errors as
invalid inputs. The persistence owner rechecks the claim after attachment I/O
and again after transaction admission. Two further admission-wait cases cover
clear/cancel while waiting for another transaction. All 101 tests in the four
affected suites pass; the aggregate backend evidence is 13 files / 229 tests.
The rebuilt final candidate passes 22 native cases; dragging and cleanup
fail and stop the remaining queue/steer cases. Native acceptance remains
explicitly failing/incomplete.


### Published-head CI follow-up: endpoint and resolver safety

- Given a saved Provider endpoint contains a long run of internal slashes, when
  the caller previews its API targets, then the gateway path stays exact and
  normalization completes in bounded linear work.
- Given a TypeScript glob alias contains literal replacement metacharacters,
  when the architecture gate expands it, then only the literal target directory
  is scanned. Unsupported multiple-wildcard alias targets fail closed.
- Given a transient model response arrives after the initial virtual-clock
  advance, when the production task retries, then the regression follows its
  observable completion and still verifies frozen prompts and durable attempts.

The delayed-response and long-path regressions failed before the fixes, and all
43 tests in their two suites pass with the CI shard coverage configuration.
Three resolver regressions first failed on literal substitution, exact aliases,
and invalid wildcard targets; all 94 architecture tests now pass. The Models
suite passes all 77 tests, and CI/workspace test typechecks pass. The endpoint
normalizer uses a three-line suffix scan instead of adding a string utility
dependency; the resolver reuses the installed TypeScript pattern parser.
Existing coverage floors and native acceptance requirements remain unchanged.


### Published-head Windows E2E setup recovery

Given multiple specifications configure models through Settings in one native
WebDriver session, when each setup closes Settings through its visible close
button, then a later setup can open a fresh native Settings window, configure
the model through main, and return to the main window. Closing only the WebView
through WebDriver must not leave a native window that later setups cannot reach.
The existing streaming-scroll scenario uses the same Settings-owned model
administration helper as the queue scenarios.

The first published Windows run on `564f94ed` reports 67 passing and 28 failing
cases/hooks; the setup failures prevented the remaining specification groups
from running. Three boundary regressions reproduce the stranded-window and
cleanup failure behaviors before the fix and pass afterward. A real
Linux/WebKit smoke on the existing `564f94ed` integration binary also completes
two successive model configurations and verifies that both Settings windows are
released. This confirms the changed E2E harness, not the full new product build
or Windows acceptance; CI must rebuild and rerun the complete matrix.

The full E2E/preview tooling suite passes 21 files / 244 tests after the harness
repair. Final Windows execution and CodeQL confirmation remain pending CI.
