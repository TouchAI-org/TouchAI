# Selective rollback validation

Issue #778 restores the conversation palette and provider request policy from before
PR #762. Context compaction, durable summaries, source verification, output/thinking
budgets, local token calibration and the compaction status appearance remain.

The two images use synthetic text and attachments. They show the restored message,
attachment and action colors at [420px](conversation-420.png) and
[750px](conversation-750.png). They are browser rendering evidence; they do not
establish native window behavior or release performance.

## Isolated layer checks

The staged tree was exported independently from the later Skills and search layers.
On 2026-11-11, that tree passed full source/test Vue TSC, scoped ESLint/Prettier and
112 tests across these five suites:

- `tests/services/AgentService/execution/context.test.ts`
- `tests/services/AgentService/execution/context-persistence.test.ts`
- `tests/services/AgentService/execution/executor.test.ts`
- `tests/services/AgentService/infrastructure/providers/ai-sdk/context-options.test.ts`
- `tests/components/MarkdownContent-i18n.test.ts`

The test run used the repository Vitest configuration with an external cache and
temporary directory, one worker and the default test timeouts. An earlier run on a
slower temporary volume exceeded the crash-recovery test's five-second timeout.
Temporary timing showed recovery finished before cleanup; moving the scratch
directory outside the repository to the faster volume let the unchanged suite pass.
No assertion or production behavior was relaxed to address that environment issue.

## Remaining acceptance

The PR remains Draft. The focused results above do not replace final-head full CI,
frontend/Rust coverage, desktop E2E, release P50/P95 and memory measurements, or human
code review. Removing explicit provider cache hints may change cache hit rates and
input cost; automatic provider caching remains available.
