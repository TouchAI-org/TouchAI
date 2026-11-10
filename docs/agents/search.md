# Shared search host

Issue #780 owns the search host refactor and input integration, built on Skills #34. Miniapp #229 owns its domain provider and launch handler. The user approved this division and the contract in the implementation thread on 2026-11-09; the issues were split for review on 2026-11-11. The provider/session core has no database, persisted document, native IPC, permission, or CSP changes. File suggestions and editor integration have the separate persisted contracts described below.

## Ownership

`services/SearchService` owns trusted provider registration, independent query sessions, cancellation, generation checks, stable result identities, pagination and typed action dispatch. It has no dependency on Vue, native APIs or Miniapp domain code. Existing presentation stays in `components/ui/result-panel`. The SearchView integration owns focus, IME, selection, query intent, input snapshots and window geometry.

Providers search validated local metadata only. They must not execute guest code, read file contents, consult a model or collect implicit clipboard input. File assets and operating-system actions remain in the file adapter. Miniapp uses one host-constructed provider aggregating registry contributions; the integration scope owns provider registration and app scopes own their entries. Disposing an entry invalidates its provider, rather than registering one provider per app.

## Runtime contract

- Each editor/search surface gets its own query session. A new query cancels only that session's older requests.
- The file surface coalesces repeated requests for the same keyword and intent. A change from launcher to file reference is a new request even when its keyword is unchanged. Expected cancellation settles without producing an error event.
- Each registration has a generation. Invalidation or disposal immediately removes its old results and cursors. Results from cancelled or obsolete queries cannot be published or activated, even if a provider ignores its AbortSignal.
- Providers have independent opaque cursors. Results deduplicate by provider and stable item ID. Host group ordering is shortcut, miniapp, file, skill; provider ranking is local to its group.
- The host dispatches explicit actions. Enter/click use the primary action. Tab uses only an explicit completion action and never falls back to launch/open.
- Activation captures explicit input and conversation target at the interaction boundary. Search keywords do not automatically become launch input. Missing conversation targets return a structured requirement; no implicit session creation or mode change.
- Provider and handler disposal is idempotent. Duplicate registration is rejected. Failed providers do not discard successful sibling groups; errors are visible in the session snapshot.
- Registry/provider callbacks are trusted host code. A registered action handler still owns authoritative domain validation. Search provenance is not a permission grant.
- Auto-opening and query execution use the same eligibility policy in `searchInteraction.ts`. An outgoing panel can remain painted during its closing animation, but that does not authorize a new query or an outdated result to reopen it.

## Acceptance and implementation order

1. Add behavior tests for independent sessions, stale query responses, invalidation/disposal, bounded pagination, error isolation, deterministic grouping, completion-vs-launch and immutable activation input; run them before implementation.
2. Implement the public contracts, registry/session and action dispatcher without native dependencies.
3. Adapt the existing file query and Skills catalog/selection to the shared lifecycle while retaining file ranking/assets and editor token/IME behavior.
4. Run the affected services, file/skill interaction and shared UI suites, type/lint/build checks, then verify the existing native preview with its draft preserved.

Performance acceptance retains the existing 5% P50/P95 and memory budgets. Provider results and per-session retained pages are bounded; cancelled work releases listeners. Release measurements and complete PR gates must be reported separately from unit/debug checks.

## Public exports and integration

Import the renderer-wide `searchProviders` and `searchActions` from
`apps/desktop/src/services/SearchService/index.ts`. The same entry exports
`SearchProviderRegistry`, `SearchSession`, `SearchActionDispatcher` and every type
from `contracts.ts`. The file and skill adapters live in `files.ts` and `skills.ts`;
domain-specific payloads stay in their owner package.

```ts
import { searchActions, searchProviders, type SearchProvider } from '@/services/SearchService';

// Construct this provider in trusted host code from validated registry metadata.
const provider: SearchProvider<MiniappSearchResult> = {
    id: 'miniapps',
    intents: ['launcher'],
    async search({ query, limit, cursor, signal }) {
        // Domain adapter owns its opaque cursor and adds group: 'miniapp'.
        return searchValidatedMiniappMetadata({ query, limit, cursor, signal });
    },
};
const registration = searchProviders.registerProvider(provider);
const handler = searchActions.register<MiniappLaunchAction>('miniapp.launch', launchMiniapp);

// Replace validated contributions atomically before invalidating their search projection.
registration.invalidate();

// Integration-scope teardown; both operations are idempotent.
registration.dispose();
handler.dispose();
```

The example's `MiniappSearchResult`, `MiniappLaunchAction`, metadata adapter and
launch handler are supplied by Miniapp #229; they are not implemented by #780.
`MiniappLaunchAction` may keep its readonly app/revision/contribution/entry/mode
payload unchanged. Its result adds the shared `group` field; `accepts` may remain
an extension on that domain result. Omit `completionAction` for launch-only items.
Duplicate provider IDs and action discriminants are rejected, rather than replaced.

Each surface calls `createSession(localProviders?)`. QuickSearch contributes its
file provider locally so its ranking/assets and native dependency remain scoped to
the panel; shared Miniapp registrations are automatically included in launcher
sessions. Skills use an isolated session and never query launcher providers.
The surface subscribes to `session.subscribe(snapshot => ...)`, calls
`search({query,intent,limit,inputKinds?})`, and calls `loadMore(providerId?)` for
independent provider cursors. `search()` returns `{...snapshot, stale}`; a stale
return must not replace subscribed current state. Invalidation refreshes active
sessions automatically. `cancel()` invalidates the current query, and `dispose()`
also releases the registry subscription.

`SearchMatch` carries `key`, `providerId`, `generation`, `epoch`, and immutable
`result`. Consumers may wrap it in Vue reactivity. `resolve(match)` looks up the
authoritative match using provenance; it never trusts caller-supplied action data.
`activate(match, 'primary' | 'completion', dispatcher, context)` rechecks that
provenance and links cancellation to the query/provider lifetime. Handlers must
honor the signal and revalidate domain state immediately before native launch.
This check is not native permission or identity authorization.

Activation context contains `query`, `intent`, `epoch`, `signal`, optional explicit
`input: {text?, files: {id,name,kind}[]}`, optional `conversation: {sessionId} | null`,
and optional `draftVersion`. The current SearchBar supplies selected text only,
plus explicitly attached file identities; an unselected keyword is never input.
SearchView supplies the existing session ID or null. The Miniapp adapter must
resolve file identities into its restricted handles. There are no paths, file
contents, clipboard reads, or automatic session creation in this public input.

The host recognizes `completed`, `started`, `requires-conversation`,
`requires-permissions`, `unavailable`, `failed`, `cancelled`, and `unsupported`.
QuickSearch emits `actionOutcome` for both pointer and keyboard activation;
SearchView displays localized failure/requirement feedback. Miniapp owns any
permission or conversation chooser and must not treat a pure launch preflight as
authorization. Missing handlers return `unavailable`; exceptions remain failures.

## File reference suggestions

The user requested simultaneous accepted-reference and recently modified
suggestions on 2026-11-10. Given both sources contain available files, opening a
bare `@` must show both in one list, with accepted references first and each path
appearing once. Each source receives half the 12 slots when both have enough
distinct files; unused slots go to the other source. A document-index failure
must preserve available accepted references. Keyword searches keep their current
behavior. The existing history schema, IPC result shape and result UI are reused.

A bare `@` uses the file-reference provider to offer at most 12 suggestions. It
reads up to 40 accepted-reference history rows from the existing
`quick_search_click_stats` table under the `@reference` query key, ordered by most
recent use. Frequency breaks timestamp ties; ordinary launcher ranking is
unchanged. New and updated rows use the same millisecond timestamp format.

Only a completed editor insertion records a reference. Highlighting, hovering,
displaying or opening a file does not. Recording runs after insertion and does
not delay input. Native search removes missing paths and duplicates before
returning metadata. The Windows Everything adapter also supplies recently
modified text and office documents. It reads no file contents. The native query
fetches at most the result limit plus the valid reference count (40 paths at the
native maximum) to compensate for overlap. Available references remain usable
when the document index is loading or unavailable.

Accepted references are application-local history, not Windows Recent Items or
file-open history. The document source covers Everything's indexed scope without
a current-project restriction and orders by modification
time, not creation time. Typing a filename after `@` switches to the existing
filename/path search and its normal pagination.

This follows the empty-query recents pattern documented by
[Raycast File Search](https://manual.raycast.com/file-search), while retaining
Everything as the Windows filename-search source, as described in
[uTools Local Search](https://www.u-tools.cn/plugins/topic/51/). TouchAI's
accepted-reference signal and simultaneous document suggestions are product
choices, not a claim to reproduce either tool's ranking algorithm.

After a file or skill query completes without matches, the standalone launcher
collapses to its input without an empty-state panel. The compact conversation
picker keeps a single centered empty-state message. Pending queries retain the
current surface visibility; cancelled, stale and failed requests must not be
presented as a successful empty result. The editor keeps its `@`, `/` or `$`
intent and can continue typing or dismiss the query. Matching results reopen
the launcher without resetting its draft.

The history query uses the existing query/path index to select `@reference`
rows, then sorts that subset by recency. Its 40-row return bound does not bound
the rows SQLite must sort. Keep the query-plan evidence and realistic history
sizes in performance validation; adding a recency index or changing retention
would require separate database approval.

## Inline reference completion

Skills and files share candidate-to-completion resolution, unmodified keyboard
routing and the editor's ProseMirror decoration. Providers keep their own query,
pagination and validity checks. A highlighted candidate takes priority; a single
prefix match can complete implicitly only at the end of the input. Fuzzy matches
remain selectable but do not invent a suffix. Enter/Tab on `@`, `/` and `$`
accept references; ordinary launcher Enter keeps its existing open action.

Acceptance: given a visible skill list and inline completion, when window dragging
returns focus to the unchanged input, the same rows, selection and completion stay
painted throughout revalidation. Pending rows cannot be accepted. A removed or
disabled skill disappears when discovery finishes. Given current file results,
when a file is selected or is the sole prefix match, its suffix appears in the
input without entering the draft, history or submission. Tab inserts that same
file reference; stale/loading results, composition and non-prefix matches cannot
produce an implicit insertion.

Given text followed by blank editor space, a pointer release below the drag
threshold focuses the end of the draft. Clicking text preserves its native caret
or selection; dragging blank space moves the window without relocating the caret.

## Bounds and compatibility

A page contains at most 2,000 results. A provider retains at most 5,000 items and
100 pages in one session. Duplicate IDs replace their row without changing its
position. Cursor cycles, invalid totals and invalid groups fail that page
atomically while preserving existing rows and sibling providers. At most one
previous completed query is retained to support undoing a keyword edit while a
replacement is pending. Restoration creates a new epoch and requires unchanged
registrations/generations; invalidation, close and disposal clear it.

The host uses platform `AbortController`, `structuredClone` and immutable data
snapshots. No installed library owns the required provider-generation and typed
activation invariants; those small domain-specific boundaries live here. Signal
linking uses event listeners with explicit cleanup because `AbortSignal.any` is
newer than the configured Chrome 105 target. Native file search still has no
physical cancellation IPC: obsolete results are discarded and callers settle
without waiting, but already issued native work may finish in the background.
