# Context management

Status: implementation submitted for review under [RFC #760](https://github.com/TouchAI-org/TouchAI/issues/760). The maintainer authorized local implementation before issue/PR creation on 2026-11-08. RFC acceptance, complete human code review and the outstanding validation below remain pending. No database, persisted JSON, retention, permission, or CSP changes are required.

## Problem and constraints

TouchAI currently loads the complete transcript in `session/transport.ts` and sends it on every model/tool step. Model rows already contain `context_limit` and `output_limit`; usage already separates fresh input, cache reads, cache writes, and output. The missing piece is a bounded model-facing projection. The transcript remains the source of truth.

Use the existing AI SDK 6 provider adapters, token estimator, checkpoint/retry loop, and call ledger. A provider-specific opaque checkpoint would require a new persisted representation and account affinity. That is intentionally deferred. A small projection policy belongs in the existing execution layer: none of the installed SDKs can own TouchAI's transcript boundaries, cancellation, model switching, and accounting together.

## Research snapshot

Sources were retrieved on 2026-11-08. Branch heads are moving targets; the following revisions identify the code actually inspected. Search results and extension claims were not treated as shipped behavior.

| Project | Inspected revision | Relevant behavior | Application to TouchAI |
| --- | --- | --- | --- |
| pi (`badlogic/pi-mono` now redirects to `earendil-works/pi`) | `a4ccccbd64d4ccea1644f5a07bb94ef09075b219` | Default 16,384-token reserve and 20,000-token recent tail; cut before user/assistant messages, never inside tool call/results; merge previous summary. The inspected main branch still serializes standalone summaries and disables cache writes for them. | Preserve complete tool exchanges and cumulative task state. Do not attribute a cached-compaction extension or an unmerged commit to pi core. |
| OpenCode | `c33eaa170ed5093c08f1684862a695aae036dcda` (`dev`) | V2 shares normal request preparation with compaction; stable tools/system/history followed by the summary instruction. Reserve defaults to 15% with a 16k floor. Native compaction and optional speculative summaries coexist. Cache policy places at most four breakpoints on tools, system, and conversation tail. | Preserve the request prefix; use explicit Anthropic breakpoints and implicit OpenAI caching. Avoid continuous mutation of historical tool output. |
| Magpie (`yetone/magpie`) | `d32a7a70cb7fc5c51c839ee26f1baf4ff825420e` | Gateway normalizes usage and cache routing; tuning replays actual call growth, cache TTL, summary cost and post-compaction rereads. Native sealed checkpoints retain their writer/account affinity; invalid routing is refused rather than silently dropping context. | Measure total cost including summarization and cache rewrite, not hit rate alone. Do not implement account-bound native checkpoints in a provider-neutral text contract. |
| Codex | `33b3f80a0935e51a49cbbda7d6473ef757d4241b` | Local/remote compaction, retained recent context, model/window-aware triggers, cancellation-aware speculative compaction, and generation-checked installation. Completed speculative calls remain billable even when discarded. | Validate a summary against the exact source prefix, publish it atomically, count every call, and preserve retry/cancellation boundaries. Speculative calls are deferred until measured savings justify extra spend and lifecycle complexity. |

Primary sources:

- [pi compaction implementation](https://github.com/earendil-works/pi/blob/a4ccccbd64d4ccea1644f5a07bb94ef09075b219/packages/coding-agent/src/core/compaction/compaction.ts) and [reference](https://github.com/earendil-works/pi/blob/a4ccccbd64d4ccea1644f5a07bb94ef09075b219/packages/coding-agent/docs/compaction.md).
- [OpenCode compaction](https://github.com/anomalyco/opencode/blob/c33eaa170ed5093c08f1684862a695aae036dcda/packages/core/src/session/compaction.ts), [cache policy](https://github.com/anomalyco/opencode/blob/c33eaa170ed5093c08f1684862a695aae036dcda/packages/ai/src/cache-policy.ts), and [V2 cache reuse report](https://github.com/anomalyco/opencode/issues/43249).
- [Magpie replay tuning](https://github.com/yetone/magpie/blob/d32a7a70cb7fc5c51c839ee26f1baf4ff825420e/internal/tune/tune.go) and [native compaction affinity](https://github.com/yetone/magpie/blob/d32a7a70cb7fc5c51c839ee26f1baf4ff825420e/internal/gateway/native_compaction.go).
- [Codex asynchronous compaction](https://github.com/openai/codex/blob/33b3f80a0935e51a49cbbda7d6473ef757d4241b/codex-rs/core/src/session/async_compaction.rs).
- [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching) and [compaction](https://developers.openai.com/api/docs/guides/compaction): exact rendered-prefix identity matters; a cache key is a routing hint, not a cache-hit guarantee. Standalone `/responses/compact` output is a canonical replacement window, not merely a text summary. Model generations have different TTL/write-price semantics, so do not hardcode a universal discount or retention extension.
- [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching): changing `tool_choice` invalidates message caches; changing thinking mode/budget always invalidates message caches and can also invalidate tool/system caches on some models. Cache markers alone are insufficient when request settings change.

## Design

1. **Budget each inference step.** Account for system text, tool schemas, history, attachments, output reserve and estimation error. Reuse provider input usage (fresh + cache read + cache write) as evidence when available. Unknown limits do not silently become invented model capabilities.
2. **Stable requests.** Canonicalize tool order and schema object keys at the SDK boundary. Keep unchanged messages unchanged. Route OpenAI requests with a stable conversation key; mark bounded Anthropic cache breakpoints without imposing a paid long TTL on every gateway.
3. **Compact at safe boundaries.** Above the budget, summarize the older prefix and retain the recent tail plus the latest user request verbatim. Keep tool calls with all their results. Long tool runs can compact older rounds without losing the active request.
4. **Reuse the warm prefix.** Send the original system, tools and selected typed history, then append a summary instruction. Tools are disabled for execution during summarization. If old imported history cannot fit in one summary call, consume complete groups in bounded batches; never silently truncate user content or split a tool exchange.
5. **Atomic, disposable summaries.** Only install a completed, nonempty, bounded summary that reduces context and fits the budget. Empty/truncated/failed/cancelled summaries preserve the previous projection. A bounded in-memory cache stores summaries and SHA-256 prefix evidence, not another full transcript. History edits, model/provider changes and expiry invalidate reuse. Restarting reconstructs from the complete original transcript and may require another summary call.
6. **Accounting and failures.** Summary requests use the same call ledger as ordinary inference. Do not expose summary text as the assistant's answer or execute its tool requests. An oversized indivisible request returns an actionable localized error. Automatic network retry continues to use existing checkpoints.

## Implemented policy

The projection lives in `apps/desktop/src/services/AgentService/execution/context.ts`; `executor.ts` owns the summary stream and records its usage. `infrastructure/providers/ai-sdk/cache.ts` applies provider settings after the existing message/attachment conversion. No new runtime dependency is introduced.

- Output reserve is the model's declared output limit, capped at one quarter of its context window; absent output metadata uses 16,384. Input budget subtracts this reserve plus `min(16,384, context × 15%)`. Thus a 1M-window/65,536-output model keeps its 65,536 output allowance. Unknown context limits disable automatic compaction.
- Text estimates reuse TouchAI's existing CJK-aware estimator, include tools and attachments, and start with a 1.25 multiplier. Observed fresh + cached input can raise that multiplier with 10% headroom. Estimates are not exact tokenization, particularly for images and native documents.
- Keep a recent tail targeting `min(20,000, input budget × 30%)`, every system instruction, and the latest user request verbatim. The active user request may be pinned ahead of the tail during a long tool run. Tool calls and their results are indivisible. A request that cannot fit without breaking these rules fails explicitly.
- When the complete live prefix still fits, append a summary instruction to it. Otherwise process the covered history in complete, bounded batches. Summary output normally has an 8,192-token ceiling and all summaries have a 32,000-character acceptance limit. Anthropic retains inference's output/thinking allowance and automatic tool choice to avoid invalidating its warm prefix; actual tool execution remains disabled in the summary executor.
- Summary reuse requires the same session/provider/model and SHA-256 evidence for the covered history and request context. Check the evidence both before generation and before installation. Preserve normalized string/text-part equivalence after transcript reload. A failed replacement leaves the previous valid summary available.
- At most 16 summaries remain in memory, with a 30-minute lifetime and LRU eviction. Summary text is bounded by approximately 1 MiB of UTF-16 payload across all entries; this is a bound on summary text, not a measured process-memory budget. Token estimates use weak keys and do not retain another transcript. Provider usage calibration also has a 16-entry cap.
- OpenAI receives an opaque conversation routing key stable within an executor's lifetime. Generic compatible endpoints rely on their implicit prefix caching; unsupported cache parameters are not injected. Anthropic gets at most four ephemeral breakpoints: last tool, system, and up to two recent user/tool messages. No paid one-hour retention is forced.
- Summary calls receive distinct attachment-delivery request indexes and ordinary call records. Reported usage is retained even when cancellation arrives with the final chunk. Unreported usage stays unknown. Summary text, reasoning and tool proposals never become the visible answer.
- Compaction emits a live lifecycle event into the existing task projection. A centered status divider shows a spinner and “Compacting context”, then changes in place to an inward-arrow icon and “Context compacted”. Multi-batch summaries share one marker; replaying an ID already present in the live timeline updates that marker. Failure, cancellation, retry and task termination remove pending spinners. During compaction the ordinary answer loader is invisible and hidden from assistive technology while retaining its normal layout space; its tip timer pauses. Pending compaction prevents automatic window shrinking.
- The divider is a new `components/ui/status-divider` primitive using existing `muted-foreground` at 60% opacity and `border` roles, with explicit Source Han Serif typography at medium (500) weight, English/Chinese labels, a polite live status and reduced-motion support. Its one-pixel rule is vertically scaled to half a CSS pixel for a lighter hairline. Increased-contrast preferences restore the full muted foreground and unscaled rule. Storybook covers completed, loading and both Chinese states under a sans-serif parent, so the app shell cannot silently supply the wrong typeface. Both labels update with the app locale, including a language switch during compaction. It adds no settings or controls.
- The maintainer requested a shadcn-style neutral conversation surface after reviewing the initial screenshots. `conversation-surface` in `styles/tailwind.css` maps the existing roles to white, near-black and light gray within the panel. User bubbles, attachment frames, request statuses, copy/regenerate controls and the conversation toolbar consume those roles. Markdown has an inherited foreground token for the conversation body; other surfaces retain its existing default. No theme setting, palette dependency or global brand-token replacement is introduced.

Visual scope is **breaking** for the conversation panel and the new divider. Affected call sites are `ConversationPanel/index.vue`, `UserMessage.vue`, `AssistantMessage.vue` and `ConversationToolbar.vue`; `ActionButton.vue` is used only by these user/assistant messages. The shared Markdown foreground falls back to its previous values outside this panel. [Native screenshots and their provenance](context-management-evidence/README.md) accompany this design; packaged visual baselines remain a merge requirement.

Summary text is lossy model output, not a new source of authority. It is labelled as historical data and cannot grant approval; original system instructions and the current user request remain authoritative. This reduces instruction mixing but does not make arbitrary model summaries immune to prompt injection.

## Deliberate limits

Summaries are disposable and are rebuilt after restart or expiry; persisted transcripts and checkpoints keep their existing shape. There is no native opaque checkpoint, speculative/background compaction, new settings screen, manual compaction command, or silent truncation of oversized tool results. Unknown/stale model metadata and provider-specific image tokenization can still cause provider context errors; this version does not repeatedly guess a smaller window and retry billable calls. Updating model metadata or choosing a larger model remains the recovery path.

Timeline markers are also disposable and are excluded from the persisted message-part schema. Reloading stored history, including the current task center's new-turn bootstrap, does not restore their original positions. If a later request reuses an in-memory summary, its completed marker appears before that request's answer. Deduplication applies to markers already present in the live snapshot; it does not promise a durable historical compaction log.

The current executor appends messages without modifying already-issued message objects; weak-keyed token estimates rely on that invariant. Fingerprint verification still checks covered content on reuse. Extremely large imported or multimodal histories require release/WebView measurements of serialization and hashing before claiming the latency budget is met.

## Acceptance scenarios (written before tests)

- Given a conversation within budget, when the next step starts, then it sends the same history and makes no summarization call.
- Given long history, when the budget is reached, then the next request contains a compact summary, the exact latest request and complete recent tool exchanges; stored history is unchanged.
- Given a long tool run within one user turn, when older tool rounds exceed the budget, then they can be summarized while the active request and newest exchange remain intact.
- Given a completed summary, when the user continues the unchanged session, then the summary is reused; editing its covered history or changing provider/model invalidates it.
- Given oversized imported history, when compaction runs, then every summarized message is included in a bounded batch; no call/result pair is split.
- Given a cancelled, failed, empty, truncated, or tool-calling summary, when it finishes, then no invalid projection is installed and tool execution does not occur.
- Given cacheable requests, when tool discovery order varies or a new turn is appended, then stable provider prefixes, reasoning options and cache routing are preserved.
- Given a summary call, when the turn completes or fails, then its actual input/cache/output usage is included in the existing ledger.
- Given system instructions inside old history, when that history is compacted, then those instructions retain their system role.
- Given a model with a large output allowance, when context is budgeted, then inference retains that allowance when the window permits it; summary generation has a separate bounded output budget.
- Given history changes while a summary is being generated, when the summary completes, then it is rejected and a later request rebuilds from the edited history.
- Given compaction and inference both send attachments, when their requests are recorded, then each has a distinct delivery request index in the existing manifest.
- Given an Anthropic request with reusable history, when compaction runs, then tool choice and reasoning budget remain consistent with inference; the executor rejects summary tool calls without executing them.
- Given compaction starts during a conversation, when the user watches the timeline, then a subtle divider with a spinner and localized “Compacting context” label appears at that position, with no duplicate answer-loading indicator.
- Given compaction is the latest visible activity, when it finishes and inference starts waiting for the first response token, then the waiting area keeps the same height and bottom spacing; only the appropriate loading indicator is visible. Verify the rendered geometry at both 420px and 750px widths.
- Given a summary is installed, when the operation completes, then that same divider becomes “Context compacted”; replaying the same summary into a timeline that retains its marker does not create a duplicate.
- Given compaction fails, is cancelled, or its task terminates, when the timeline settles, then no compaction spinner or false success remains. Completed markers stay in the live task snapshot; the existing persisted transcript format is unchanged.
- Given the app shell uses its default sans-serif font, when a compaction divider is displayed, then its Chinese label is painted in the product's Source Han Serif font and its text and rules use neutral shadcn-style `muted-foreground` and `border` roles in both loading and completed states. This typography/color adjustment is verified in the rendered browser rather than with class-name assertions.
- Given the conversation contains user text, assistant text and compaction status, when it renders, then its surface is white, the user bubble is light neutral gray, the body text is near-black and secondary controls are neutral gray. These presentation changes use a scoped mapping of existing semantic roles and retain the current layout and interaction behavior.

## Validation and performance budget

Use behavior tests for projection, safe boundaries, invalidation, limits, cancellation and provider HTTP payloads. Run existing execution/provider/history suites, type checks and lint. Measure cold/warm projection preparation on fixed fixtures and retained summary size. The release acceptance budget remains at most 5% P50/P95 and steady-state memory regression against `3e70e4db1038dc0600e4746b23ba23f54bf41496` on the same installed release build. Synthetic timings establish local algorithm cost only; they do not establish Tauri end-to-end latency or real provider hit rates. Report missing release measurements explicitly.

Cache hit ratio is `cacheRead / (freshInput + cacheRead + cacheWrite)` over actual provider reports. Include summary calls, cache writes and output cost in comparisons; missing usage is unknown, not zero-cost success. No real-provider savings percentage is claimed without a controlled trace.

Manual validation is reproducible with `node apps/desktop/scripts/check-context-management.mjs`. It compiles the existing source in memory and uses a fixed synthetic fixture; it makes no network request by default. Add `--live --database <absolute TouchAI database path>` to read only the configured Magpie/DeepSeek provider, replace only Tauri HTTP with Node fetch, and send synthetic content through the actual adapter. It never reads conversation rows or writes provider settings. This validates the provider integration, not an installed Tauri desktop build.

The 2026-11-08 live trace used `ai/deepseek-v4.1-flash` with a unique synthetic prefix and a deliberately reduced 16,000-token test window:

| Request | Fresh input | Cache read | Cache write | Output | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| Warm original history | 6,135 | 0 | 0 | 92 | Requirements recovered |
| Summarize original prefix | 256 | 6,016 | 0 | 1,770 | Complete summary |
| Answer from projection | 1,842 | 0 | 0 | 66 | Requirements recovered |
| Continue using the same summary | 84 | 1,792 | 0 | 40 | Requirements recovered; no second summary |

Every answer asserted the exact JSON values `codename = Cedar`, `budgetCredits = 7300`, and `mayDeleteBackups = false`. Every call reported usage. The first request after compaction pays for a new prefix, as expected; the next continuation can reuse it. This trace demonstrates continuity and cache reuse, not a general savings percentage or a comparison against a non-compacting baseline.

### Native desktop smoke test

On 2026-11-08, a cached Windows `TouchAI.exe` debug host (`target-pr730/debug`) loaded this worktree's Vite frontend. An isolated profile imported only the authorized Magpie provider, seeded 18 synthetic history messages into the existing schema, set a 16,000-token context / 4,096-token output limit, and disabled built-in tools. The E2E bridge submitted through the normal search flow. Native database/HTTP, execution, compaction and rendering were live; no status or response was injected.

The initial run entered compaction at 1.1 seconds, completed compaction at 46.1 seconds, and finished successfully at 96.2 seconds including capture overhead (93.9 seconds persisted turn duration). Three LLM calls reported 12,508 fresh input, 2,048 cache-read, zero cache-write and 2,231 output tokens. The answer retained Cedar, the 7,300-credit limit and the prohibition on deleting backups. These are observations from one diagnostic run, not a latency benchmark or a controlled savings comparison.

Native painted-font inspection confirmed Source Han Serif SC VF Medium at weight 500. Switching the actual locale changed the label between Chinese and English. After visual review, the label/icon opacity was reduced to 60% and the rules to 0.5 CSS pixels; increased-contrast preferences restore full muted foreground and 1px rules.

A controlled native layout check then reproduced a 46px height change during the transition from compaction to answer waiting, at both 420px and 750px. Keeping the normal loader invisible preserves its layout space: both waiting states measured 90px, with zero visible dots during compaction and three afterwards. The geometry assertion failed before the fix and passed afterwards. Those measurements used injected states, separately from real-provider validation.

[The committed screenshots](context-management-evidence/README.md) show the final loading and completed treatments from separate real native requests. The latest loading capture's request entered compaction, but the capture script timed out after 240 seconds waiting for completion; it is not counted as a successful end-to-end run. Earlier native runs completed successfully. The executable was not rebuilt from this branch, and the captures predate synchronization with the main branch's window/overlay work. Packaged E2E evidence for the synchronized PR head is still required.

### Local checks

Before main synchronization, the combined execution/provider/attachment/history/prompt/output/projection/usage and UI lifecycle regression passed: **53 files, 882 tests**. Source `type:check` and `test:typecheck` passed. Earlier focused runs overlap this suite and are not added to its count. The checks after main synchronization are recorded in the PR.

The rendered component checks covered 420px and 750px widths, both status states, no horizontal overflow, locale changes, live-status attributes, reduced motion, increased contrast and actual painted fonts. A failed font check reproduced Microsoft YaHei fallback before explicitly setting `font-serif`. These checks and native screenshots do not replace full Storybook or packaged desktop visual regression.

The standalone synthetic benchmark used 123 input messages and produced a 9-message projection, estimated at 4,704 tokens within a 16,304-token input budget. Across 30 cold and 60 warm preparations, cold P50/P95 was **9.117/35.959 ms**, warm **2.770/37.593 ms**. This measures Node algorithm cost, not a release/WebView baseline or a process-memory budget.

`pnpm test:pr` was executed and **failed in its first stage**, `test:ci:typecheck`, because the shared local installation cannot resolve `@actions/expressions` and `@actions/expressions/result`. The chained repository CI tests, complete desktop quality/unit/coverage/Rust checks and site build did not execute. Dependencies and lockfiles were not changed to conceal the environment gap.

**Outstanding:** complete `pnpm test:pr`, Rust checks/tests/build, frontend coverage, full Storybook visual regression, packaged desktop E2E and release P50/P95/memory comparison. The machine exposes only a space-constrained system drive and no off-system build scratch. This PR changes no native code. CI and release measurements must establish the missing acceptance evidence before merge/release; local source, component and provider checks are not substitutes.

Reproducible focused commands:

```powershell
pnpm --filter @touchai/desktop exec vitest run tests/services/AgentService/execution tests/services/AgentService/infrastructure/providers tests/services/AgentService/infrastructure/attachments tests/services/AgentService/session tests/services/AgentService/prompt tests/services/AgentService/outputs tests/services/AgentService/task/projection tests/services/UsageService tests/components/AssistantMessage-reasoning.test.ts tests/views/SearchView/assistantMessageShell.test.ts tests/SearchView/autoShrinkPolicy.test.ts tests/composables/useAgentSessionModel.test.ts --configLoader runner --maxWorkers 2 --silent=passed-only
pnpm --filter @touchai/desktop type:check
pnpm --filter @touchai/desktop test:typecheck
node apps/desktop/scripts/check-context-management.mjs
node apps/desktop/scripts/check-context-management.mjs --live --database <absolute TouchAI database path>
pnpm test:pr
```
