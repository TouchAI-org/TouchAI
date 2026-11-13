# Analytics

Read this before changing the event registry, consent, session or operation
handles, delivery, or analytics export/import behavior.

Analytics is a local-first, best-effort product signal. It must never block a
user action, and every failure path fails closed. Native owns identity, consent,
session state, validation, queueing, and delivery. The WebView submits only
typed event attributes.

## Ownership

| Piece               | Path                                                  | Owns                                                        |
| ------------------- | ----------------------------------------------------- | ----------------------------------------------------------- |
| TypeScript boundary | `apps/desktop/src/services/AnalyticsService/`         | Event names, typed schemas, submit API                      |
| IPC                 | `NativeService/analytics.ts`, `commands/analytics.rs` | The analytics commands                                      |
| Native runtime      | `core/analytics/runtime.rs`                           | Consent, sessions, operations, validation, delivery         |
| Event registry      | `core/analytics/events.rs`                            | Event names and attribute rules                             |
| State               | `core/analytics/store.rs`                             | Consent and small metadata in the existing `settings` table |
| Delivery queue      | `core/analytics/`                                     | Bounded native queue and sender integration                 |
| Transport           | `core/analytics/transport.rs`                         | Delivery protocol and response classification               |
| Backup scrub        | `core/database/runtime/analytics_snapshot.rs`         | Export/import privacy rules                                 |
| Settings UI         | `SettingsView/components/*/AnalyticsSection.vue`      | User privacy choice only                                    |

The WebView must not build a wire envelope, choose a session id, or deliver
events directly. There is one native transport path.

## Event Contract

There are exactly 19 registered events. The TypeScript and Rust schemas, plus
the private receiver registry, must agree before an event is shipped.

- `apps/desktop/src/services/AnalyticsService/events.ts`
- `apps/desktop/src-tauri/src/core/analytics/events.rs`
- `TouchAI-org/touchai-analytics`, `src/touchai_analytics/protocol.py`

Shared conformance cases live in `apps/desktop/tests/fixtures/analytics/`:

- `analytics-events.v1.json` must be accepted by both validators.
- `analytics-events.invalid.v1.json` must be rejected by both.
- `analytics-days.v1.json` covers the shared UTC-day boundary rules.

These are test vectors, not runtime assets and never user data. Keep the fixture
metadata independent from the product wire protocol version.

Attributes use only bounded enums, canonical UUIDs, UTC days, release versions,
integers, and booleans. Free-form text is forbidden. Unknown events, unknown
keys, out-of-range values, and incoherent field combinations are rejected before
queueing.

A release version must match `^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$`. The native
install-handoff path derives versions from the running package and the validated
updater command, not from the WebView. A value outside the 64-character wire
shape is omitted from the emitted attribute. Pending restart metadata may retain
the exact shaped value up to 200 characters so a long valid SemVer can still be
confirmed after restart; that local value is never emitted as an attribute.

### Add an Event

1. Add the event to the private receiver contract.
2. Add the name and schema to both TypeScript and Rust registries.
3. Add one valid case and at least one invalid case to the shared fixtures.
4. Define its ordering priority and whether it is a user interaction.
5. Add behavior tests in both languages.
6. Update this page only if an invariant or bound changes.

## Consent And Identity

Consent and local metadata live in one JSON value under
`settings.analytics.state.v1`; analytics does not add a database table.

- A stored explicit choice always wins over the deployment default.
- Only a status-changing explicit choice increments the local consent epoch.
- Turning sharing off clears queued events and pending update metadata.
- The installation id is a locally generated UUID. It is not derived from
  hardware, account, IP address, or machine name.
- A deployment change drops queued events bound to the old endpoint.
- Full restore preserves an explicit consent choice but never carries the
  exporting machine's identity, epoch, queue, or pending delivery metadata.
- CI, E2E, and UI-preview processes resolve no analytics transport, so they
  cannot create an installation identity or emit events. Automated launches set
  `TOUCHAI_DISABLE_ANALYTICS=1`; `CI`, `TOUCHAI_E2E`, and
  `TOUCHAI_UI_PREVIEW` are also treated as suppression signals.

## Sessions And Operations

Native owns the current session. A user interaction starts or refreshes it; a
session expires after 30 minutes without interaction. Passive events never open
a session. Session admission re-checks idleness and refreshes `last_activity`;
an operation that already admitted its original session keeps that session even
after it later goes idle.

`beginOperation(startedAtMs)` returns an opaque handle bound to the current
session and consent epoch. Native rejects the start when its timestamp cannot
prove the action began after the latest consent transition, so a capture queued
while sharing was off cannot bind an epoch the user enabled later. Completions
must use that handle. An unknown, expired, or revoked handle fails as
`stale_operation`; it never falls back to the current session or a newer epoch.
Handles expire after 2 hours and the registry is capped at 256.

A queued session start is delivered before its dependents. If the start is
permanently rejected or expires, dependent events are dropped and the session is
abandoned.

## Queue And Delivery

The queue is native-owned and bounded. Inspect the active analytics module for
its current storage policy, limits, retry timing, and batch size; those are
implementation details that can change without changing the public event
contract.

Every accepted event has a stable id and immutable payload. Delivery must be
single-flight. Authentication, configuration, rate-limit, and transient failures
retain the event and apply the owning retry policy. A batch or event is removed
only after the receiver explicitly confirms persistence; a bare successful HTTP
status is not enough.

Before a batch is sent, its ordered members, exact body, batch id and retry
deadline are frozen as one pending reservation. A transient retry resends that
reservation unchanged; new events wait for a later batch. The reservation is
released only by explicit acknowledgement, a configuration failure, consent
invalidation, or TTL expiry.

Delivery must re-check the live queue, consent state, epoch, and expiry before
sending. Work purged by opt-out, restore, or test cleanup must never be sent from
a stale batch.

An `install_handoff` stores at most 640 bytes of pending restart metadata when
the native target version has the 1-200 character version shape. The next start
emits `restart_confirmed` and clears that metadata in one transaction only when
the running target version, local consent epoch, and valid operation id match.
The transaction compares the expected pending blob so a repeated resolution
cannot confirm twice or consume a newer handoff. Matching metadata is retained
when consent is disabled, delivery is unavailable, or queue capacity rejects the
event.

`analytics_track` validates before it queues, so an invalid event is reported as
rejected rather than disabled.

## Privacy

Collected fields are limited to event names, bounded categories, UUIDs, UTC
days, counts and durations, and coarse app/platform facts. Event bodies do not
include IP addresses or location.

Never collect prompts, messages, file contents or names, paths, URLs, clipboard
contents, error strings, model names, provider credentials, or window titles.
The network edge and receiver may retain the source IP address and derive coarse
location from it for abuse prevention and aggregate geographic usage analysis.
That receiver-side processing is outside the analytics envelope and must be
described accurately in the user-facing privacy disclosure.

The user-facing analytics description must state that events are linked to a
random installation id, that the receiver may associate IP address and coarse
location for abuse prevention and geographic usage analysis, and that disabling
analytics stops event delivery while pseudonymous installation and observation
metadata remains on the device and may be included in later events after sharing
is re-enabled.

Internal states such as endpoint readiness, queue depth, and save failures are
for structured logs only. Settings must show only the user's privacy choice and
a stable explanation. Do not add user-visible queue controls, transport
diagnostics, or build-specific analytics messages.

## Testing

Use `docs/testing/testing.md`; test names start with `user` and describe a
behavior. At minimum run the registry tests, the TypeScript analytics service
tests, and the native analytics tests touched by the change.

The shared fixtures are the cross-language drift guard. Do not duplicate a
validator's cases in one language while leaving the other validator free to
accept different input.
