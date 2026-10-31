# Analytics

Read this before changing the event registry, consent, the outbox, export/import
scrubbing, or anything that emits a product analytic.

The subsystem is a local-first product event pipeline: the WebView submits typed,
whitelisted metadata, the native runtime owns consent, identity, the session and a
bounded outbox, and one sender delivers each immutable event to the deployment
endpoint. Nothing here is business-critical: every failure path fails closed and
never blocks the user.

## Where it lives

| Piece | Path | Owns |
| --- | --- | --- |
| Frontend boundary | `apps/desktop/src/services/AnalyticsService/` | Event names, whitelist Zod schemas, shared fixtures, the typed submit call |
| IPC | `apps/desktop/src/services/NativeService/analytics.ts`, `apps/desktop/src-tauri/src/commands/analytics.rs` | The eight `analytics_*` commands |
| Native runtime | `apps/desktop/src-tauri/src/core/analytics/runtime.rs` | Consent, session, operation handles, ingress, sender, health, restart confirmation |
| Registry | `apps/desktop/src-tauri/src/core/analytics/events.rs` | Event whitelist, attribute kinds, priority |
| Typed SQL | `apps/desktop/src-tauri/src/core/analytics/store.rs` | `analytics_state` and `analytics_outbox` statements |
| Wire adapter | `apps/desktop/src-tauri/src/core/analytics/transport.rs` | Umami-compatible HTTP body, delivery classification, retry semantics |
| Snapshot scrub | `apps/desktop/src-tauri/src/core/database/runtime/analytics_snapshot.rs` | Export/import scrubbing and the restored consent choice |
| Settings UI | `apps/desktop/src/views/SettingsView/components/General/AnalyticsSection.vue` | Toggle, queue size, clear-pending action |

There is exactly one wire contract and it is native. The TypeScript side never
builds a wire body, computes an installation id or a session id, or decides that
an event is deliverable. Adding a second frontend transport is a drift bug, not a
shortcut.

## The registry

`ANALYTICS_EVENT_NAMES` and `ANALYTICS_EVENT_SCHEMAS` (TypeScript) and
`AnalyticsEventName`/`event_spec` (Rust) describe the same 19 events. The private
receiver (`TouchAI-org/touchai-analytics`, `src/touchai_analytics/protocol.py`)
holds the third copy. Both validators read the same fixtures:

- `apps/desktop/src/services/AnalyticsService/fixtures/analytics-events.v1.json`
  must be accepted by both.
- `.../fixtures/analytics-events.invalid.v1.json` must be rejected by both.
- `.../fixtures/analytics-days.v1.json` supplies the shared day boundary table:
  canonical `YYYY-MM-DD`, real Gregorian days, and years 1 through 9999. Year
  `0000`, short years and trailing whitespace or line breaks are rejected.

Attribute kinds are deliberately narrow: enum, canonical UUID, canonical UTC day,
release version, bounded integer and boolean. There is no free-form text
attribute. A version is the only value that can originate outside the codebase
(`from_version`/`to_version`) and it must match
`^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$` in both copies, so a path, URL, error string,
whitespace or vendor-qualified model id cannot pass. The rule is a shape check: a
bare alphanumeric-dash identifier that looks like a version is accepted.

Unknown event names, unknown keys, out-of-range scalars and incoherent cross-field
pairs (`unpriced_call_count > llm_call_count`) are rejected before persistence,
not stringified.

### How to add an event

1. Confirm the private receiver accepts the name and attributes; the receiver is a
   separate repository and the change is only complete with all three copies.
2. Add the name to `ANALYTICS_EVENT_NAMES` and `AnalyticsEventName::parse`.
3. Add the attribute spec to both registries with existing kinds only. New
   free-form text is not acceptable.
4. Add the event to the legal fixture and at least one rejection case to the
   invalid fixture.
5. Decide the ordering priority, whether the event is a user interaction, and
   whether it marks the first success day (see below).
6. Update this page if a bound, ordering rule or privacy invariant moves.

## Consent, identity and epoch

`analytics_state` is one row. It holds the consent status, whether the choice was
explicit, a local installation id, a consent epoch and the first-observed and
first-success days.

- A deployment default only applies while `consent_explicit = 0`; an explicit
  choice is never re-derived, even when the default or policy version changes.
- The installation id is a locally minted UUID. It is never derived from
  hardware, account, IP or machine name, and it is regenerated when it is missing
  (a restored snapshot carries none).
- Only a status-changing explicit choice (including an adopted restored choice)
  increments the local `consent_epoch`. Recording the same status as an explicit
  choice, clearing pending work, and re-deriving a non-explicit deployment default
  do not increment it; a new state row starts at 0. An old-epoch submission fails
  as `stale_epoch`, or `stale_operation` when its handle has been revoked, rather
  than being re-tagged. Native bindings are retired when collection or sending
  observes an imported epoch change.
- Withdrawing consent deletes the whole outbox and any pending-update metadata in
  the same transaction that flips the status.
- The outbox is bound to one deployment key (`settings.analytics.deploymentKey`).
  When the resolved endpoint or project id changes, queued rows are dropped before
  they can be flushed through another target.

## Session and operation handles

Native code owns the session. A WebView-supplied session id is never trusted.
`app.started` and `analytics.health_reported` are rejected from the WebView, and
`analytics.session_started` is ignored with `deduplicated`/`native_session_owned`
after the configuration, validation and enabled-consent gates. This is an
ownership response, not proof that a matching native row exists or receiver-side
deduplication; no WebView-authored session-start row is persisted.

- A genuine user interaction opens a session; passive events (exposure, health,
  update, startup) never start or refresh one. A session goes idle after 30
  minutes without an interaction.
- The `session_started` row and the interaction that opened the session commit in
  one transaction under the native writer lock. Session/handle resolution shares
  that lock, and a provisional id is not published before persistence, so another
  window cannot capture a start that fails or is cancelled.
- `analytics.session_started` has outbox priority 0. While its start is still
  queued, any due event that references the same session is held to the start's
  own retry instant instead of being sent, including events enqueued while the
  start is backing off, so the receiver never sees a reference before its session
  start is accepted. Transient, configuration and `Retry-After` failures all keep
  this guard. A rejected or expired start abandons its session: queued dependents
  are dropped transactionally, its operation handles are revoked and its active
  binding is released. A late handled event is rejected as `stale_operation`;
  independent events in the same pass can still send. Clearing pending work also
  retires the current session and handles so a later interaction needs a new
  start. Session starts cannot be evicted for capacity, including old rows with
  a legacy priority.
- `beginOperation` issues an opaque handle bound to the session and epoch in
  force when an operation started. A completion that arrives after another window
  opened a later session stays on the original session and epoch. Handles expire
  after 2 hours, the registry is capped at 256, and an unknown handle fails closed
  as `stale_operation` instead of borrowing the current session or a newer epoch.
  Supplied handles are rechecked under the writer lock, including the native
  startup-completion path; handle-less native lifecycle events remain supported.
- Render-only feature exposures are deduplicated per session and feature, and the
  dedup key is recorded only after the row persists. Before a session exists, a
  shared no-session key is used; this is local exposure suppression, not wire
  ingestion deduplication.

## Ingress, queue and retention bounds

| Bound | Value | Where |
| --- | --- | --- |
| Outbox rows | 10,000 | `store::MAX_EVENTS` |
| Outbox bytes | 16 MiB | `store::MAX_BYTES` |
| Single payload | 2,048 bytes | `store::MAX_PAYLOAD_BYTES` |
| Queue TTL | 72 hours | `store::TTL_MS` |
| Send batch | 50 rows | `store::SEND_BATCH_LIMIT` |
| In-flight ingress | 128 rows / 256 KiB | `INGRESS_MAX_ENTRIES`, `INGRESS_MAX_BYTES` |
| Pending-update metadata | 512 bytes | `PENDING_UPDATE_MAX_BYTES` |
| Session idle | 30 minutes | `SESSION_IDLE` |
| Operation handles | 256, 2 hours | `OPERATION_MAX`, `OPERATION_TTL` |
| Exposure dedup set | 4,096 keys | `EXPOSURE_MAX` |

Admission counts reserved but uncommitted work, so a burst cannot outrun the single
writer. A WebView submission reserves two rows and 4 KiB before it waits for the
writer, covering a possible native session start; passive native events reserve
their actual size. When the queue is full, only rows with a larger numeric
priority can be evicted, and session starts are always protected. Priorities are
`0` session start, `10` agent lifecycles, `100` everything else, `200` passive
health, surface, exposure, startup and update signals. A batch that cannot fit as
a whole rolls back instead of half-committing.

## Lifecycle and operations

1. Native setup records the process-start instant and the trusted startup source
   (the autostart plugin launches with `--minimized`).
2. `AnalyticsRuntime::initialize` ensures the state row, reconciles the deployment
   binding, resolves a pending update confirmation, records the observed version,
   and emits `app.started` once when sharing is on and the deployment can deliver.
3. The sender runs every 30 seconds or when the runtime is notified, single-flight,
   with a 12 second per-pass budget. Transport outcomes are explicit: accepted
   (row deleted), permanent rejection (row deleted and counted; a rejected session
   start also drops its dependent rows, then the pass continues with independent
   work), configuration failure or `Retry-After` or transient failure (that row is
   rescheduled and the current pass stops). Configuration retry is 5 minutes for
   the affected row, not a deployment-wide cooldown; other eligible rows can be
   examined on the next notification or 30-second tick. Transient backoff is
   jittered from 1 second to approximately 5 minutes. Every buffered row is checked
   against the live queue, consent status, epoch and expiry before delivery, so
   rows purged by a restore or clear action do not send from a stale batch. An
   HTTP request already in flight at withdrawal cannot be recalled.
4. The hourly health reporter emits real counters and queue depth. It never counts
   its own deliveries and never runs while sharing is off.
5. A successful `install_handoff` transition stores bounded pending metadata. The
   next start emits `restart_confirmed` and clears that metadata in one
   transaction only when the running target version, local consent epoch and valid
   operation id match. The transaction also compares the expected pending blob:
   repeated or overlapping resolution of that handoff cannot confirm it twice or
   consume a newer handoff. An unfinished update, a missing operation id, a
   same-version handoff or invalid metadata is cleared as stale on a provisioned
   start. Valid matching metadata is retained when consent is disabled or capacity
   rejects the event; an unprovisioned start retains metadata without resolving
   it. Other enqueue failures likewise do not consume it. A snapshot carries no
   pending handoff to confirm.
6. `analytics_track` validates, then queues. Validation happens before the consent
   gate so an invalid event is reported as rejected rather than disabled.

## Privacy invariants

Collected: event names, enum categories, buckets, canonical UUIDs, UTC days,
bounded durations/counts, app version, release channel, os family and
architecture.

Never collected: prompts, messages, file contents, file names or paths, URLs,
clipboard data, error strings, model names, provider credentials, window titles,
IP addresses or location. The wire body uses fixed non-geographic `hostname`/`url`
placeholders and the deployment proxy strips client IP and geo headers.

Export and import:

- An exported snapshot carries no installation id, consent epoch, queued event,
  pending-update metadata, observation days, observed version or deployment
  binding.
- It does carry the minimum consent state — `status` plus `consent_explicit` —
  alongside the non-identifying `policy_version` and a refreshed `updated_at`, so
  a backup taken after an explicit opt-out cannot be re-enabled by the deployment
  default when it is restored.
- Only a full restore adopts that choice, inside the import transaction. A
  chat-only import never changes analytics consent. The restored machine keeps its
  own installation id and local epoch; it adopts only an explicit restored choice
  and only when it has not made an explicit choice itself. A status change bumps
  that local epoch; adoption of the same status does not. A target with no analytics
  state row gets one with epoch 0, a fresh local identity and first-observed day
  instead of losing the choice. The exporting installation's epoch is never
  adopted. Existing local queued work is retained only if adoption does not opt
  out; an explicit local choice takes precedence over the backup.
- An adopted opt-out deletes the local outbox and pending-update metadata in the
  same transaction, so a later re-enable cannot send events queued before the
  restore.
- A restore never imports another install's queued events, and a fresh install
  mints a new anonymous installation id on its next start.

## Testing

Behavior lives in the Rust unit tests next to each module and in the TypeScript
service tests:

- `core/analytics/events.rs`: registry acceptance/rejection, version shape, day and
  UUID rules.
- `core/analytics/runtime.rs`: consent, session/operation binding, ingress bounds,
  sender outcomes, startup, health, restart confirmation, outbox send order.
- `core/analytics/store.rs`: state reconciliation, epoch rejection, queue bounds,
  deployment binding, restored consent.
- `core/database/runtime/analytics_snapshot.rs` and `import.rs`: export scrubbing
  and the backup/reinstall/restore flow.
- `apps/desktop/tests/services/AnalyticsService/`: fixture parity between the two
  validators and the submit boundary.

Tests follow `docs/testing/testing.md`: they assert what a user or caller observes
and their names start with `user`.

## Acceptance scenarios

- Given an undelivered session start, when delivery returns `Retry-After`, a
  transient failure or a configuration failure, then no dependent reaches the
  sender before that start is accepted, including dependents queued during backoff.
- Given a session start is rejected, expires, or is cleared, when pending or late
  events reference it, then they fail closed; an independent event or a new
  interaction can proceed without reusing that abandoned session.
- Given an operation was captured before opt-out, when consent is disabled and
  re-enabled or the handle expires, then a completion is rejected without a new
  session or queued row; handle-less native lifecycle events remain supported.
- Given a full backup with explicit opt-out and no explicit target choice, when
  import succeeds, then consent, outbox purge and pending-metadata purge commit
  together. Failure rolls them and the imported chat back. Re-enable cannot replay
  old events. Chat-only import changes no consent, and a missing state row does
  not lose the restored explicit choice.
- Given a successful handoff, when restart confirmation is retried from the same
  saved state, then only one confirmation persists; temporary delivery/queue
  unavailability retains the handoff instead of silently consuming it.
- Given an export, when the snapshot is inspected, then it retains only consent
  status/explicitness, `policy_version` and a refreshed `updated_at`, not identity,
  epoch, observation history, queued events, pending handoff or deployment binding.
