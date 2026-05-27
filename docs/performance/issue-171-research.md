# Issue 171 Performance Research

This note records the external research used for issue #171 and maps it to the current TouchAI risk areas. Keep the GitHub issue requirement-level; use this file for engineering references and PR review.

## Primary Reference

Raycast's 2026 rewrite is the closest benchmark for TouchAI: a keyboard-first desktop assistant that mixes native shells, web surfaces, Rust/system components, typed IPC, and strict platform feel.

Key takeaways from [A Technical Deep Dive Into the New Raycast](https://www.raycast.com/blog/a-technical-deep-dive-into-the-new-raycast):

- Native feel is an outcome, not a stack label. Raycast keeps web technology where it helps product velocity, but owns the native shell, platform conventions, and hot paths.
- High-frequency UI updates must cross runtime boundaries intentionally. Typed IPC, native view models, and "do nothing when there is no diff" matter more than abstract purity.
- Keyboard-first launchers are judged on interruption cost. Any delayed focus, stale visual state, or janky window motion breaks user context.
- Cross-platform rewrites need explicit memory and startup trade-offs. Warm surfaces can improve perceived speed, but the app must know when to release or degrade them.
- Platform conventions are performance work. Window behavior, focus, shortcuts, resize, drag, and input readiness must match the OS instead of fighting it in web code.

## Source Corpus

The research pass intentionally mixes native desktop, WebView, Electron/Tauri, browser rendering, Vue, streaming AI chat, and responsiveness sources. Count: 64 sources.

### Hybrid Native/WebView Desktop Apps

1. [Raycast: A Technical Deep Dive Into the New Raycast](https://www.raycast.com/blog/a-technical-deep-dive-into-the-new-raycast) - primary benchmark for hybrid native/web architecture and platform feel.
2. [Raycast: How the Raycast API and extensions work](https://www.raycast.com/blog/how-raycast-api-extensions-work) - React-to-native render tree, IPC ordering, diffing, and background work separation.
3. [Raycast Blog index](https://www.raycast.com/blog) - release context for Raycast 2.0, Windows, Notes, and extension architecture.
4. [Raycast: Raycast for Windows](https://www.raycast.com/blog/raycast-for-windows) - cross-platform root-search and Windows-specific experience goals.
5. [Raycast: Meet the new Raycast Notes](https://www.raycast.com/blog/meet-the-new-raycast-notes) - WebView surface embedded in a native-feeling product.
6. [Tauri Process Model](https://tauri.app/concept/process-model/) - Core/WebView process split and IPC boundary responsibilities.
7. [Tauri window JavaScript API](https://v2.tauri.app/reference/javascript/api/namespacewindow/) - window size, events, visibility, focus, and DPI-aware logical/physical size APIs.
8. [Tauri webview JavaScript API](https://v2.tauri.app/reference/javascript/api/namespacewebview/) - WebView creation, focus, bounds, events, and platform differences.
9. [Tauri Rust Webview API](https://docs.rs/tauri/latest/tauri/webview/struct.Webview.html) - native-side bounds, size, focus, and main-thread interaction surface.
10. [Tauri IPC module](https://docs.rs/tauri/latest/tauri/ipc/index.html) - command and message boundary for frontend/native communication.
11. [Microsoft: Performance best practices for WebView2 apps](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/performance) - startup, memory, CPU, rendering, IPC batching, ETW, and DevTools guidance.
12. [Microsoft: WebView2 browser flags](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/webview-features-flags) - WebView2 runtime features that can affect startup and code caching.
13. [Microsoft: Process model for WebView2 apps](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/process-model) - WebView2 browser/renderer/GPU process costs.
14. [Microsoft: Debug WebView2 apps with Microsoft Edge DevTools](https://learn.microsoft.com/en-us/microsoft-edge/webview2/how-to/debug-devtools) - practical profiling and inspection workflow.
15. [Microsoft: Manage user data folders in WebView2](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/user-data-folder) - startup and disk-location considerations.
16. [Electron: Performance](https://www.electronjs.org/docs/latest/tutorial/performance) - avoid blocking startup, heavy modules, unnecessary IPC, and unbounded renderer work.
17. [Electron: Process model](https://www.electronjs.org/docs/latest/tutorial/process-model) - multi-process desktop architecture comparison.
18. [Electron: IPC](https://www.electronjs.org/docs/latest/tutorial/ipc) - boundary design and message cost comparison.
19. [Electron: Security, native capabilities, and isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation) - why host/web coupling should remain narrow.
20. [VS Code wiki: Performance Issues](https://github.com/microsoft/vscode/wiki/Performance-Issues) - startup timers, extension cost, renderer profiling, and user-facing performance triage.

### Browser Responsiveness, Rendering, And Animation

21. [web.dev: Optimize long tasks](https://web.dev/articles/optimize-long-tasks) - break main-thread work to preserve interaction responsiveness.
22. [web.dev: Optimize Interaction to Next Paint](https://web.dev/articles/optimize-inp) - input delay, processing duration, and presentation delay model.
23. [web.dev: Interaction to Next Paint](https://web.dev/articles/inp) - 200 ms responsiveness threshold and lifecycle framing.
24. [web.dev: RAIL model](https://web.dev/rail/) - response, animation, idle, load budgets for perceived speed.
25. [Chrome: Long Animation Frames API](https://developer.chrome.com/docs/web-platform/long-animation-frames) - frame-level jank instrumentation beyond individual long tasks.
26. [MDN: Long animation frame timing](https://developer.mozilla.org/en-US/docs/Web/API/Performance_API/Long_animation_frame_timing) - browser API shape and attribution limits.
27. [MDN: PerformanceObserver](https://developer.mozilla.org/en-US/docs/Web/API/PerformanceObserver) - local and field performance event collection.
28. [MDN: Performance.mark](https://developer.mozilla.org/en-US/docs/Web/API/Performance/mark) - user timing hooks for traceable activation/resize budgets.
29. [MDN: Performance.measure](https://developer.mozilla.org/en-US/docs/Web/API/Performance/measure) - measuring spans such as shortcut-to-input and resize settlement.
30. [MDN: ResizeObserver](https://developer.mozilla.org/en-US/docs/Web/API/ResizeObserver) - size observation, callback timing, and loop pitfalls.
31. [web.dev: Avoid large, complex layouts and layout thrashing](https://web.dev/avoid-large-complex-layouts-and-layout-thrashing/) - read/write DOM sequencing and layout cost.
32. [MDN: requestAnimationFrame](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame) - paint-aligned animation scheduling.
33. [MDN: Animation performance and frame rate](https://developer.mozilla.org/en-US/docs/Web/Performance/Animation_performance_and_frame_rate) - frame budgets and CSS property cost.
34. [Chrome DevTools: Performance panel](https://developer.chrome.com/docs/devtools/performance/) - local trace workflow for main thread, layout, and rendering.
35. [Chrome DevTools: Rendering tab](https://developer.chrome.com/docs/devtools/rendering/) - paint flashing, layout shift regions, and frame rendering diagnostics.
36. [Chrome DevTools: Memory problems](https://developer.chrome.com/docs/devtools/memory-problems/) - heap snapshots and leak triage.
37. [Chrome DevTools: Performance monitor](https://developer.chrome.com/docs/devtools/performance-monitor/) - live CPU, JS heap, DOM node count, and listener count.
38. [Microsoft Edge DevTools: Performance tool](https://learn.microsoft.com/en-us/microsoft-edge/devtools-guide-chromium/performance/) - WebView2-compatible runtime profiling.
39. [Material Design: Duration and easing](https://m1.material.io/motion/duration-easing.html) - fast, smooth, non-mechanical motion principles.
40. [Material Design: Material motion](https://m1.material.io/motion/material-motion.html) - motion as spatial feedback, not decoration.

### Native Responsiveness And Startup Budgets

41. [Microsoft: Improve the responsiveness of your Windows app](https://learn.microsoft.com/en-us/windows/apps/performance/responsive) - define scenarios, instrument key interactions, and budget launch/menu/content delays.
42. [Apple: Reducing your app's launch time](https://developer.apple.com/documentation/xcode/reducing-your-app-s-launch-time) - defer non-essential launch work and profile real device state.
43. [Apple: Improving app responsiveness](https://developer.apple.com/documentation/xcode/improving-app-responsiveness) - hitches, hangs, frame work, and interaction thresholds.
44. [Apple: Understanding user interface responsiveness](https://developer.apple.com/documentation/xcode/understanding-user-interface-responsiveness) - frame loop and hitch/hang classification.
45. [Nielsen Norman Group: Powers of 10, Time Scales in UX](https://www.nngroup.com/articles/powers-of-10-time-scales-in-ux/) - why sub-second delays affect user flow.
46. [Nielsen Norman Group: Website response times](https://www.nngroup.com/articles/website-response-times/) - 0.1 s, 1 s, and 10 s response-time thresholds.
47. [Microsoft: Windows app best practices](https://learn.microsoft.com/en-us/windows/apps/get-started/best-practices) - responsive design, app fundamentals, and platform fit.
48. [Microsoft: Windows app performance overview](https://learn.microsoft.com/en-us/windows/apps/performance/) - tracing, responsiveness, and launch measurement entry points.

### Vue, Reactivity, And Component Update Cost

49. [Vue: Performance best practices](https://vuejs.org/guide/best-practices/performance.html) - props stability, `v-memo`, update optimization, code splitting, and large immutable structures.
50. [Vue: Watchers](https://vuejs.org/guide/essentials/watchers.html) - watcher batching, `flush: 'post'`, cleanup, and sync watcher caution.
51. [Vue: Reactivity API Advanced](https://vuejs.org/api/reactivity-advanced.html) - `shallowRef`, `triggerRef`, and reducing deep reactivity overhead.
52. [Vue: Reactivity Core](https://vuejs.org/api/reactivity-core.html) - watch/watchEffect semantics and flush timing.
53. [Pinia: Core concepts](https://pinia.vuejs.org/core-concepts/) - store shape and state update boundaries.
54. [Pinia: Testing stores](https://pinia.vuejs.org/cookbook/testing.html) - test seams for store-driven UI behavior.
55. [Vite: Performance](https://vite.dev/guide/performance.html) - dependency pre-bundling, dev-server cost, and large dependency diagnosis.

### Streaming AI Chat, Markdown, And Long Content

56. [markstream-vue: Performance Features & Tips](https://markstream-vue-docs.simonhe.me/guide/performance) - streaming markdown batching, visible-node windows, heavy-node deferral, and benchmark metrics.
57. [markstream-vue: AI Chat & Streaming](https://markstream-vue-docs.simonhe.me/guide/ai-chat-streaming) - smooth streaming, history recovery, fade/typewriter trade-offs, and peer dependency budgeting.
58. [Incremark: High-performance streaming markdown renderer](https://www.incremark.com/) - incremental parsing and stream-friendly markdown architecture.
59. [mdstream crate](https://docs.rs/crate/mdstream/latest) - streaming-first Markdown middleware that avoids O(n^2) reparse/rerender loops.
60. [Streaming Markdown project overview](https://deepwiki.com/thetarnav/streaming-markdown/) - chunk-based parser/renderer architecture for AI chat.
61. [Kreya: Virtual Scrolling, rendering millions of messages without lag](https://kreya.app/blog/using-virtual-scrolling) - DOM node bounds for chat/log-like streams.
62. [Orbit: Measure Once, rebuilding chat virtualization for AI-era apps](https://www.orbit.build/blog/measure-once-ai-chat-virtualization) - AI chat-specific virtualization, measurement, and markdown/code-block cost.
63. [AuditBuffet: Streaming responses use incremental rendering in the UI](https://auditbuffet.com/patterns/ab-000329) - avoid re-rendering sibling messages on every token.
64. [Mike Levin: Streaming Markdown with WebSockets](https://mikelev.in/futureproof/websockets-stream-incremental-markdown/) - incomplete-markdown rendering trade-offs and incremental DOM update goals.

## TouchAI High-Risk Mapping

| Risk area | Source pressure | Current action in this branch | Remaining follow-up |
| --- | --- | --- | --- |
| Search height animation replays stale intermediate heights | Raycast native feel, WebView2 IPC batching, RAIL animation budget, ResizeObserver loop pitfalls | Coalesced height scheduler keeps only the latest pending target; Rust animation token cancels obsolete native animations. | Add an automated e2e/perf check that streams content and asserts dropped-vs-committed resize ratio. |
| WebView content and native window get temporarily out of sync | Tauri logical/physical size APIs, WebView2 host/content separation, layout thrash guidance | Window resize events drive a temporary visible viewport lock from real native size during conversation growth. | Add manual/video validation across Windows DPI settings and external monitor scale factors. |
| Resize feedback loops between measurement and native size updates | ResizeObserver callback timing, layout thrashing, Raycast IPC ordering | Resize transaction state ignores observer echoes during in-flight growth/shrink; shrink rebound guard blocks intermediate heights. | Add a browser trace target to correlate observer, request, sent, committed, and settled events. |
| Quick search invokes expensive native lookup on every keystroke | INP/long-task guidance, WebView2 IPC batching, Raycast root-search expectations | Query-driven quick-search sync is debounced; non-query state changes still sync immediately. | Measure shortcut-to-first-results and consider prefix cache after native search telemetry exists. |
| Quick-search clear-then-retype loses same-query result under racing native calls | IPC ordering/race guidance from Raycast extension architecture | QuickSearch flow now returns explicit outcomes and reruns an invalidated same query when the visible input still asks for it. | Add native-side cancellation or request abort if Everything provider cost becomes visible. |
| Conversation bootstrap briefly collapses the search window | Native feel and animation stability guidance | `conversationPending` keeps the window in managed-panel policy while first messages attach and while streaming. | Define a separate "first input accepted" budget and trace it through shortcut event to SearchBar focus. |
| Idle/default-size reset can poison later same-height resize | Window/content synchronization requirement | Reset clears previous resize target and rebound guards, so identical later measurements can resize again. | Include this in the resize e2e scenario after default-size changes. |
| Hot-path logging can become its own performance problem | WebView2 CPU/IPC guidance and Electron logging/startup advice | Logger policy keeps release defaults bounded and tests log-level parsing/retention. | Route high-frequency resize/stream data to bounded performance traces, not file logs. |
| Streaming markdown and long conversations can stall main thread | markstream-vue, mdstream, Incremark, virtualization sources | Not changed in this branch beyond preventing resize shrink churn during streaming. | Audit `ConversationPanel` render cost, heavy Markdown/code/Widget nodes, and DOM node count; prefer batching/windowing before more native resize tuning. |
| Startup and activation have no enforced performance budget | Microsoft/Apple launch guidance and NNGroup time-scale thresholds | Research and manual checks define the first measurement set; trace service is present for resize path. | Wire shortcut/window/input trace events and decide budgets before changing warm-window lifecycle policy. |
| Low-memory behavior is undefined | WebView2 memory target/suspend guidance and Raycast warm-surface trade-off | Current resize coalescing degrades by dropping stale work rather than replaying it. | Define warm/visible/hidden/destroyed states and memory-pressure fallback policy before adopting visual-hide or preload tactics. |

## Current Implementation Notes

- The first phase optimizes the native interaction path that users see most clearly: height resize while Search transitions from quick-search/idle into conversation and while assistant output streams.
- The implementation deliberately keeps animation in Rust/native code and measurement/intent in Vue. This matches the research pattern: keep platform-specific behavior at the platform boundary, and avoid running independent JS and native animations against each other.
- The frontend resize scheduler is "latest wins" rather than throttle-only. Throttling can still replay stale targets; latest-wins prevents obsolete intermediate heights from continuing after the user-visible state has moved on.
- The viewport lock is driven by actual native resize events, not predicted target size. This avoids clipping content to stale heights and keeps the WebView's visible container aligned with the real window during animation.
- The fix added during this pass clears resize dedupe state after resetting idle/default bounds, because a reset changes native state even if the next measured content height numerically matches the previous requested target.

## Deferred But Important

These are not safe to land as blind changes in the same patch:

- Visual hiding instead of true hiding for Search. It may improve activation, but can regress taskbar behavior, focus semantics, accessibility, occlusion throttling, memory use, and app-blur behavior.
- WebView prewarm or refresh policies. WebView2 explicitly frames this as a startup/memory trade-off; TouchAI needs measurement and memory fallback first.
- Conversation virtualization. This likely matters for long sessions, but it changes scroll restoration, selection, widget lifecycle, and message measurement semantics.
- Heavy Markdown/code-block degradation during streaming. The markstream-vue docs support this, but TouchAI needs a measured threshold so we do not degrade high-quality rendering unnecessarily.
- Global LoAF/long-task reporting. Useful, but should be gated behind a diagnostic mode and bounded buffers before any release behavior.

## Review Checklist For Issue 171 PRs

- Does the PR reduce actual work on the shortcut-to-input or resize path, or only move it around?
- Are IPC/native calls coalesced or batched when the user can generate many updates quickly?
- Does any animation have one owner, one clock, and a cancellation story?
- Does ResizeObserver output feed back into layout in a bounded way?
- Does the code distinguish predicted target size from actual native window size?
- Are low-frequency lifecycle logs separated from high-frequency trace counters?
- Can the change be measured with local tests, trace marks, or a manual performance script?
- Does the change preserve focus, selection, and popup ordering across hide/show cycles?
