# Conversation style restoration validation

Issue #778 restores only the conversation presentation from before PR #762.
Provider cache hints, deterministic tool/schema ordering, context compaction,
durable summaries, source verification, output/thinking budgets, token calibration
and the compaction status appearance retain their existing behavior.

The two images use synthetic text and attachments. They show the restored message,
attachment and action colors at [420px](conversation-420.png) and
[750px](conversation-750.png). They are browser rendering evidence; they do not
establish native window behavior or release performance.

## Isolated layer checks

On 2026-11-11, the maintainer clarified that the restoration applies only to styles.
Restoring the original provider-cache tests first produced three expected failures
for the removed OpenAI routing key and Anthropic cache markers. Restoring the
affected runtime and test files exactly from the PR base then passed 112 tests
across these five suites, independently of the later Skills and search layers:

- `tests/services/AgentService/execution/context.test.ts`
- `tests/services/AgentService/execution/context-persistence.test.ts`
- `tests/services/AgentService/execution/executor.test.ts`
- `tests/services/AgentService/infrastructure/providers/ai-sdk/cache.test.ts`
- `tests/components/MarkdownContent-i18n.test.ts`

The complete source/test Vue TSC check also passed. The two rendered layout cases
passed at 420px and 750px, including the unchanged compaction indicator.

The test run used the repository Vitest configuration with an external cache and
temporary directory, one worker and the default test timeouts. An earlier run on a
slower temporary volume exceeded the crash-recovery test's five-second timeout.
Temporary timing showed recovery finished before cleanup; moving the scratch
directory outside the repository to the faster volume let the unchanged suite pass.
No assertion or production behavior was relaxed to address that environment issue.

## Remaining acceptance

The PR remains Draft. The focused results above do not replace final-head full CI,
frontend/Rust coverage, desktop E2E, release P50/P95 and memory measurements, or human
code review. This layer makes no provider, runtime, database or permission-contract
changes relative to its base.
