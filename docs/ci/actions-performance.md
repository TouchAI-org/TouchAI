# Actions Performance Evidence

Tracking issue: [#726](https://github.com/TouchAI-org/TouchAI/issues/726).

## Status

Hosted comparison data was collected on 2026-11-02 for baseline
`114f801191445dd00bd60d524ecba1e7a3a4d591` and candidate
`04af39e81d43df77a3e2d47e372ebdacbd8a8089`. The candidate removed the
temporary duplicate frontend measurement job.

This report distinguishes observed job time from billed runner minutes. A
baseline `apt-get` step took 1,549 seconds, while the equivalent candidate step
took 26 seconds. That anomaly dominates the raw aggregate, so this report does
not claim the raw difference as an optimization gain.

## Hosted comparison

| Workflow | Baseline `114f801` | Candidate `04af39e8` |
| --- | --- | --- |
| CI | [41465954616](https://github.com/TouchAI-org/TouchAI/actions/runs/41465954616) | [41487462992](https://github.com/TouchAI-org/TouchAI/actions/runs/41487462992) |
| Desktop E2E Smoke | [41465954771](https://github.com/TouchAI-org/TouchAI/actions/runs/41465954771) | [41487462836](https://github.com/TouchAI-org/TouchAI/actions/runs/41487462836) |
| Security | [41465954581](https://github.com/TouchAI-org/TouchAI/actions/runs/41465954581) | [41487462905](https://github.com/TouchAI-org/TouchAI/actions/runs/41487462905) |
| Component Visual Tests | [41465954567](https://github.com/TouchAI-org/TouchAI/actions/runs/41465954567) | [41487462949](https://github.com/TouchAI-org/TouchAI/actions/runs/41487462949) |
| UI Preview | [41465949401](https://github.com/TouchAI-org/TouchAI/actions/runs/41465949401) | [41487462711](https://github.com/TouchAI-org/TouchAI/actions/runs/41487462711) |

CI jobs ran on `ubuntu-latest`; Desktop E2E ran on `windows-latest`.

### CI aggregate

These are sums of successful job elapsed time, not GitHub billing totals.
GitHub rounds billing separately for each job.

| Observation | Baseline | Candidate |
| --- | ---: | ---: |
| Successful jobs | 14 | 13 |
| Observed job-seconds | 2,379 | 845 |
| Observed runner-job minutes | 39.7 | 14.1 |
| Wall time, created to final job | 28m 10s | 3m 15s |
| Sum of queue intervals | 57s | 42s |

The job count fell by one because Rust Checks and Rust Coverage were
consolidated. The candidate also had a cold Rust cache while both baseline Rust
jobs restored warm caches. The baseline Rust Checks job included the anomalous
1,549-second `apt-get` step. Therefore the aggregate table is descriptive only.

### CI job timings

Values are observed seconds from the Actions API.

| Job | Baseline | Candidate | Relevant step detail |
| --- | ---: | ---: | --- |
| Rust Checks + Rust Coverage | 1,762 | 180 | Candidate cold Rust cache; baseline `apt-get` anomaly |
| Conventional Commits | 22 | 28 | Install 4s to 1s; total is too noisy for a claim |
| Frontend Quality | 98 | 146 | Install remained full-workspace |
| Frontend shards, sum | 363 | 372 | See shard table below |
| Frontend Tests merge | 32 | 36 | Desktop-filtered install; checkout remained full-depth |
| CI Tests | 30 | 37 | Install remained full-workspace |
| Site Build | 36 | 24 | Install 5s to 3s; build 4s to 4s |

Rust detail:

- Baseline Rust Coverage prepared in 43 seconds and ran coverage plus reporting
  in 45 seconds. Its cache was warm.
- Candidate Rust Checks prepared in 30 seconds and ran coverage plus reporting
  in 137 seconds. Its cache log reported `No cache found`.
- The consolidated job retained `cargo fmt --check`,
  `cargo llvm-cov --all-targets`, the Rust floors and the coverage artifact.
- The baseline Rust Checks job cannot be used as a normal preparation
  comparison because of the 1,549-second package-manager step.

### Frontend shards

All three shards contained 140 files. Vitest duration excludes runner setup,
dependency installation and artifact upload.

| Shard | Baseline job / Vitest | Candidate job / Vitest | Files | Tests |
| --- | ---: | ---: | ---: | ---: |
| 1/3 | 109s / 83.28s | 144s / 110.52s | 140 | 1,758 |
| 2/3 | 131s / 102.78s | 118s / 87.49s | 140 | 1,844 |
| 3/3 | 123s / 98.34s | 110s / 81.65s | 140 | 1,803 |

The candidate Vitest shard spread was 28.87 seconds. The slowest files were:

| Shard | Slowest file | Duration |
| --- | --- | ---: |
| 1/3 | `tests/services/BuiltInToolService/tools/webSearch/webSearchRouting.test.ts` | 7.341s |
| 1/3 | `tests/components/MarkdownContent-i18n.test.ts` | 2.531s |
| 2/3 | `tests/services/BuiltInToolService/tools/widgetTool/show-widget-renderer.test.ts` | 3.411s |
| 2/3 | `tests/views/SettingsView/usageDashboardLive.test.ts` | 2.538s |
| 3/3 | `tests/services/BuiltInToolService/tools/widgetTool/runtime-i18n.test.ts` | 2.179s |
| 3/3 | `tests/SettingsView/settingsBrowserSection.test.ts` | 1.892s |

No single file dominates a shard. Splitting the slowest files or adding shards
has no measured justification in this sample.

### Desktop E2E

The Windows job moved from 394 to 383 observed seconds. The build increased from
168 to 189 seconds while smoke tests fell from 81 to 56 seconds. Both runs
restored the same Rust cache key. The baseline `cargo install tauri-driver` was
already installed and took one second; the candidate verifies the
runner-provided binary with `--help` in one second. This is not credible
evidence of an end-to-end speedup.

### Validation retained

- Candidate `04af39e8` shard union: 420 files and 5,405 tests passed.
- Retained same-run equivalence at `78308c8`: the full run and shard union had
  the same 420 files and 5,405 tests, with no missing, extra or duplicate tests.
- Frontend coverage: statements 91.50, branches 84.94, functions 89.53, lines
  92.04. All global and path floors passed.
- Patch coverage: 0 changed lines, reported as 100 percent against the 85
  percent floor using base `05c3b1a0be0ceb4686135f85c2db4d85c372f016`.
- Rust coverage: lines 68.80 against floor 63; regions 69.78 against floor 64.
- Windows E2E, component visuals and UI Preview passed with the existing test,
  platform and visual-baseline inventories.
- No temporary full-suite measurement job exists in the candidate workflows.

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

## Decisions

Adopted:

- Consolidate Rust Checks and Rust Coverage into one setup and one all-target
  coverage execution.
- Install only root dependencies for Conventional Commits.
- Use workspace-filtered installs for Site Build and the frontend coverage merge.
- Verify and use the runner-provided Windows `tauri-driver`.
- Keep the existing three frontend shards and the native Vitest coverage merge.
- Keep `fetch-depth: 0` for patch coverage because it needs an exact merge base.

Deferred or rejected:

- Frontend Quality, shard and CI Tests installs remain full-workspace until each
  filtered-install variant has a retained resolution and equivalence proof.
- Rebalancing or adding frontend shards is deferred until a larger sample shows a
  dominant slow file or shard. The current slowest file is 7.341 seconds.
- A custom Linux image is deferred until the consolidated Rust job shows a
  material system-dependency cost after the `apt-get` anomaly is excluded.
- CodeQL sharding is rejected because no checked-in 37-query shard inventory or
  aggregate completeness gate exists.
- Third-party runners, `tsgo`, `node_modules` caching and global
  `isolate: false` remain rejected.

## Local baseline

Before implementation, with the committed lockfile:

| Command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` with external stores | Passed, pnpm 10.32.1 |
| `pnpm test:ci` | 5 files, 64 tests passed |
| `pnpm test:ci:typecheck` | Passed |
| `pnpm test:ui-preview` | 15 files, 176 passed, 2 pre-existing skips |
| `pnpm test:pr` | Not run as one complete command |
| `pnpm test:coverage:rust` | Not run locally |
| `pnpm test:e2e` | Not run locally; hosted Windows evidence used |

## Comparison limits

Each record identifies candidate SHA, workflow/run URL, runner image, cache
condition, queue/preparation/execution, required critical path, aggregate job
time, test/file inventory, coverage policy/result, and security query/source
inventory. A plans-only or last-commit-only change is not assumed to be a full PR
baseline: routing follows the aggregate PR diff.

Retain baseline results before pushing an optimized PR revision. Compare equivalent
application content and separate cold/warm observations. Failed runs remain visible
but are not reported as completed-suite speedups. Missing artifacts or scans that
only ran a skip gate are not successful optimization measurements.

Main-only event behavior cannot be proven by a PR run. Do not push main, merge,
delete caches, modify branch rules, or publish to manufacture evidence.
