# Issue 171 Performance Manual Checks

This is a local engineering checklist for PR validation. Keep GitHub issue text requirement-level.

## Resize And Size Sync

- Scenario: open Search, start a conversation, stream enough content to grow height repeatedly.
- Expected: height changes apply as the latest visible target, not as a replay of old intermediate heights.
- Expected: after settling, native window bounds, WebView viewport, and Search root content agree within a small logical-pixel tolerance.
- Record: visible stutter, final height mismatch, any blank/stale exposed area during expansion.

## Low-Memory Or Load Pressure

- Scenario: repeat the resize scenario while memory or CPU pressure is visible.
- Expected: resize may reduce animation smoothness, but stale queued heights should not continue replaying.
- Record: whether interaction remains usable, whether logs grow unexpectedly, and whether input/scroll are blocked.

## Logging Volume

- Scenario: run normal Search use, MCP auto-connect, and one streaming response.
- Expected: release-default frontend forwarding writes warnings/errors and low-volume lifecycle events only.
- Expected: diagnostic mode can enable debug detail intentionally without unbounded resize/streaming line logs.
- Record: approximate log file size growth and whether hot-path logs use trace/counters rather than repeated info lines.

## WebView Lifecycle Tactic Matrix

| Tactic | Status | Evidence Needed Before Adoption |
| --- | --- | --- |
| Visual hiding instead of true hide | Deferred | Compare shortcut-to-input latency, focus behavior, taskbar/accessibility behavior, and memory cost. |
| Explicit hidden-state policy | Deferred | Define true hidden, visually hidden, minimized, destroyed, and warm states for Search. |
| Prepaint before show | Deferred | Confirm readiness signal prevents blank/stale flashes without adding visible delay. |
| Frame prelayout | Deferred | Confirm target-size layout prevents exposed unrendered space during expansion. |
| Resize path validation | Active in Phase 1 | Confirm coalesced resize does not leave native/WebView/page size drift. |
| WebView initialization tuning | Deferred | Compare cold initialization, white flash frequency, cache/user-data behavior, and multi-window consistency. |
| Focus/input warm state | Deferred | Measure whether repair work is needed on every activation or only after cold/invalid states. |
| Window grace periods | Deferred | Measure latency benefit against memory retention under pressure. |
| Font/resource prewarm | Deferred | Prewarm only resources proven to affect first interaction. |
| Runtime feature flags | Deferred | Use only for diagnosis or controlled experiments. |
| Occlusion/throttling detection | Deferred | Observe timers, animation frames, and rendering while hidden/occluded/unfocused. |
| Memory trade-off accounting | Required | Any warm-window tactic must state memory cost and fallback behavior. |
