# Search window layout regression

Run from `apps/desktop` with output outside the repository:

```powershell
$env:TOUCHAI_LAYOUT_OUTPUT = 'G:/TouchAI/tmp/search-layout'
$env:TEMP = $env:TOUCHAI_LAYOUT_OUTPUT
$env:TMP = $env:TEMP
node tests/layout/searchWindowHeight.browser.mjs
node tests/layout/searchSurfaceGeometry.browser.mjs
```

Uses Edge on Windows and Playwright Chromium elsewhere. Override the browser with
`TOUCHAI_LAYOUT_BROWSER`; `TOUCHAI_LAYOUT_FONT` reuses a checksum-verified product font.
Otherwise the E2E font helper downloads it to the output directory.

The runners exercise production layout, CSS, components and WAAPI at 420/750px widths,
normal/reduced motion and 100%/150% scale. They cover cancellation, streaming, approval
bounds, centered expansion, interrupted transitions, popup alignment/focus and resize
recovery. Native IPC and unrelated renderers are fixtures; native desktop and release
performance acceptance remain separate. Measurements and screenshots go to the output directory.

The motion-preferences layer also tests OS reduction halfway through growth/shrink,
accepted geometry after cleanup, and animation recovery without remounting.
