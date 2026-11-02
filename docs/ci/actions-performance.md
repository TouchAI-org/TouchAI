# Actions Performance Evidence

Tracking issue: [#726](https://github.com/TouchAI-org/TouchAI/issues/726).

## Status

Investigation and implementation planning are complete. Optimization and hosted
verification are not complete. This report does not claim a measured speedup.

## Frozen investigation

Collected on 2026-11-01 for local source commit
`05c3b1a0be0ceb4686135f85c2db4d85c372f016`.

- 50 workflow runs, not 50 CI runs; the set includes five CI runs.
- 225 jobs and 1,087 completed, non-skipped step records.
- Three runs created no jobs; one job was still in progress when collected.
- 35 jobs have API/runner time anomalies. These are separate from measured steps.
- Separate main diagnostic sample: 30 runs and 174 jobs, not pooled into the 50.

Queue is job-created to job-started on the API clock. Dependency/orchestration
waiting is recorded separately. Preparation covers installs, caches, compilation,
database extraction, and artifact handling. Execution is tests, checks, or security
queries as identified in logs. Vitest includes transforms/imports/environment
startup; its parallel internal totals are not additive wall-clock phases.

Failed, cancelled, skipped, incomplete, and no-op analysis jobs are not successful
performance evidence. Small-sample percentiles describe only the sample.

| Job | Successful samples | Preparation, seconds | Execution/report, seconds | Interpretation |
| --- | ---: | ---: | ---: | --- |
| Frontend Tests | 3 | 21 median | 309 median | Candidate for native shards |
| Windows E2E | 1 | 733.3 | 34.7 | Preparation dominates; do not shard short execution |
| Rust Coverage | 5 | 96.9 median | 3.5 median | Installation/compilation dominates |
| Rust CodeQL | 1 actual analysis | 1188.9 | 970.1 | Both extraction and queries matter |

Across 108 completed jobs with recorded activity, queue median is 2 seconds,
descriptive P95 is 7 seconds, and maximum is 24 seconds. Two observed macOS build
queues were 2 and 3 seconds; this does not demonstrate account-level saturation.

In separate latest-10 main samples, CI has five cancelled runs, Security five,
and E2E four. Five main Windows builds wait a median 286 seconds before creation
then execute for a median 819 seconds; sums of independent medians are not a
measured end-to-end median.

Evidence:

- [Windows E2E sample](https://github.com/TouchAI-org/TouchAI/actions/runs/41286340130)
- [Rust CodeQL sample](https://github.com/TouchAI-org/TouchAI/actions/runs/41281946079)

## Preserved validation contract

- Required contexts: Conventional Commits, Dependency Review, CI Required,
  E2E Required. Merge queue check-response timeout is 15 minutes.
- Frontend global floors: statements 90, branches 84, functions 88, lines 91;
  every existing path-specific floor and the 85-percent PR patch floor remain.
- Rust line/region floors: 63/64. Nightly branch coverage is outside this issue.
- Keep all test inventories, native preview platforms, Windows E2E, and Windows
  Rust CodeQL with all 37 queries.
- Retain all genuine artifact dependencies, native startup checks, visual evidence,
  and existing release/deployment behavior.

## Local baseline

Before implementation, with the committed lockfile:

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` with external stores | Passed, pnpm 10.32.1 |
| `pnpm test:ci` | 5 files, 64 tests passed |
| `pnpm test:ci:typecheck` | Passed |
| `pnpm test:ui-preview` | 15 files, 176 passed, 2 pre-existing skips |
| `pnpm test:pr` | Not yet run; these focused baseline checks are not a replacement |
| `pnpm test:coverage:rust` | Not yet run |
| `pnpm test:e2e` | Not yet run; hosted native evidence required |

## Hosted comparison protocol

Each record must identify candidate SHA, workflow/run URL, runner image, cache
condition, queue/preparation/execution, required critical path, aggregate runner
minutes, test/file inventory, coverage policy/result, and security query/source
inventory. A plans-only or last-commit-only change is not assumed to be a full PR
baseline: routing follows the aggregate PR diff.

Retain baseline results before pushing an optimized PR revision. Compare equivalent
application content and separate cold/warm observations. Failed runs remain visible
but are not reported as completed-suite speedups. Missing artifacts or scans that
only ran a skip gate are not successful optimization measurements.

Main-only event behavior cannot be proven by a PR run. Do not push main, merge,
delete caches, modify branch rules, or publish to manufacture evidence. Update this
report with actual run results as the supervised batches complete.
