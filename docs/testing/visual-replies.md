# Visual reply acceptance

## References and scope

- [T3's renderer contract](https://github.com/pingdotgg/t3code/blob/b8c2cfad6b3363c4da144a859073b41ec77579ab/packages/shared/src/htmlRender.ts):
  a 728px desktop reply, 14px base text, no enclosing card, and 16px padding inside
  independently surfaced sections. Its theme follows the thread instead of forcing dark mode.
- [T3's button primitive](https://github.com/pingdotgg/t3code/blob/b8c2cfad6b3363c4da144a859073b41ec77579ab/apps/web/src/components/ui/button.tsx):
  compact controls, quiet neutral outlines, and explicit focus states.
- [OpenUI's sales pipeline example](https://github.com/thesysdev/openui/blob/5afae00a507e7a96144ca39e446f9af86e5f779c/docs/app/(home)/components/StreamingComparison/examples/salesDashboard.tsx):
  the fixture uses its actual metric, bookings, stage, and representative data.
  The Vue components are TouchAI's registered library, not a claim that OpenUI ships this Vue skin.

The product change is in the registered component renderer and shared UI primitives, not
just Storybook. Storybook supplies a conversation background and sample prompts, without
fabricated application chrome. No claim of pixel-identical T3 output is made: Visual replies
are generated documents, not one fixed T3 dashboard component.

## Ownership

- `styles/tokens/semantic.css` owns the neutral reply roles for light and dark surfaces.
  `styles/visual-reply.css` consumes these roles, the existing type scale, and radii.
- `components/ui/button/Button.vue` owns the additive `reply` and `reply-primary` variants.
  Existing variants retain their class snapshots.
- `components/ui/bar-chart/BarChart.vue` owns scale, keyboard/pointer readout and its additive
  `appearance="reply"` view. It reuses the existing scale and interaction logic; a CSS plot
  avoids shrinking axis text with an SVG viewBox in a narrow conversation. The default view
  remains the existing chart. No chart package or second chart state machine is introduced.
- `services/VisualReplyService/library.ts` adapts the OpenUI DSL into these primitives.
  Financial table columns use numeric alignment; stage widths use the actual ratios, not a
  fourth-root transform that visually exaggerates small stages.
- `VisualReplyFrame`, Artifact sanitizer, theme snapshot, bridge protocol, and permissions
  are unchanged. This work does not implement or replace Miniapp's optional native adapter.

## Scenarios

Given an OpenUI reply in a conversation:

- When a reader opens the sales pipeline example, body text is at least 14px, metric/table
  labels are at least 12px, and no outer panel encloses the entire reply.
- When the conversation narrows to 360px inside a desktop window, the chart sections stack
  and the four metrics become two rows. Responsiveness follows the container, not the viewport.
- When the reader uses a phone, the page does not overflow horizontally, action buttons stay
  at least 32px high, and visible month labels are not ellipsized.
- When reading the stage chart, $2M is two-thirds of $3M and $0.7M is 0.7/3 of $3M.
- When the surrounding thread is light, the same component tree follows the light palette.
- When the reader focuses the chart, it displays the latest value; arrow keys select a column,
  Escape dismisses the readout, and leaving focus clears it.
- When the reader explicitly clicks a follow-up action, the host receives that prompt.
  Mounting or streaming does not implicitly dispatch it.
- When the reader advances and resets the sandboxed sorting example, its values and counters
  update without adding host permissions.

## Verification

```bash
pnpm --filter @touchai/desktop exec vitest run \
  tests/views/SearchView/openUIReply.test.ts \
  tests/views/SearchView/visualReplyFrame.test.ts \
  tests/services/VisualReplyService \
  tests/components/ui/button.test.ts \
  tests/components/ui/visualReplyButton.test.ts \
  tests/components/barChartInteraction.test.ts \
  tests/components/barChartLifecycle.test.ts
pnpm --filter @touchai/desktop exec playwright test visual-replies.visual.ts
```

The browser suite uses the real Storybook renderer and real sandboxed iframe, not a mock
HTML reconstruction. The development screenshots cover 1120px desktop, 1440px comparison,
390px phone, and light/dark themes. The latest local run uses Linux Chromium 156 at DPR 1.
T3's shared preview cannot launch Chrome as root; local verification runs Chromium as a
non-root user with its sandbox enabled and connects Playwright through loopback CDP.

Compared with `32b6f8b583ecf87d14a33e72bab22e0716ab37e5`, the official dashboard has 135
descendant elements instead of 141. No resize observer, timer, or retained-history cache is
added. This is a DOM-budget check, not a release-performance benchmark. Native release
P50/P95, memory, Windows WebView2, and macOS/WebKit are not measured in this visual-only
pass; they remain release gates. Miniapp native-isolation evidence is separate and is not
asserted by these tests.
