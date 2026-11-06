# Search window layout regression

Run from `apps/desktop`, using an existing scratch directory outside the repository:

```powershell
$env:TOUCHAI_LAYOUT_OUTPUT = 'G:/TouchAI/tmp/issue-476-jump'
$env:TEMP = $env:TOUCHAI_LAYOUT_OUTPUT
$env:TMP = $env:TEMP
node tests/layout/searchWindowHeight.browser.mjs
```

The runner uses installed Edge on Windows and Playwright Chromium elsewhere.
`TOUCHAI_LAYOUT_BROWSER` can select another installed Playwright browser channel.
`TOUCHAI_LAYOUT_FONT` can point to an existing product font; its checksum is verified.
Otherwise the existing E2E font helper downloads it into the scratch directory.

The regression compiles SearchView's production template, styles and measurement
functions with the real conversation components and geometry owner. It exercises
pending/cancelled messages, streaming, short-session reopening, input-row resizing,
a QuickSearch handoff during animation, manual sizing/remeasurement, native failure
recovery and maximize at two widths and both motion settings.
It saves measurements and fixture screenshots in the scratch directory.

Native IPC has a controlled acknowledgement delay. The editor, result list and
unrelated message renderers are fixtures. This test verifies browser layout and
native-boundary requests; desktop E2E and release performance remain separate checks.

`node tests/layout/searchSurfaceGeometry.browser.mjs` additionally exercises centered
conversation expansion, interruption by another session, and model-picker alignment
at both widths. It runs the real WAAPI and overlay component, with a stable native viewport and a 24ms acknowledgement delay. It records per-frame
screen-space centers and checks that the picker stays outside the editor and inside
its hard bounds. Moving the host is a separate user drag operation; content growth
does not move it.
