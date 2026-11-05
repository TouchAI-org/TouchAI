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

## Sessions And Operations

Native owns the current session. A user interaction starts or refreshes it; a
session expires after 30 minutes without interaction. Passive events never open
a session.

`beginOperation()` returns an opaque handle bound to the current session and
consent epoch. Completions must use that handle. An unknown, expired, or revoked
handle fails as `stale_operation`; it never falls back to the current session or
a newer epoch. Handles expire after 2 hours and the registry is capped at 256.

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

Delivery must re-check the live queue, consent state, epoch, and expiry before
sending. Work purged by opt-out, restore, or test cleanup must never be sent from
a stale batch.

## Privacy

Collected fields are limited to event names, bounded categories, UUIDs, UTC
days, counts and durations, and coarse app/platform facts.

Never collect prompts, messages, file contents or names, paths, URLs, clipboard
contents, error strings, model names, provider credentials, window titles, or
location. The event body does not include IP addresses. Transport metadata may
still be visible to the network edge; that is covered by the deployment's
privacy policy, not added to the analytics envelope.

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
