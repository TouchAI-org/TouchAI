# Design system

Owner page for the desktop app's visual language. Read this before changing tokens,
primitives, or view-layer styling.

- [Layers](#layers)
- [Token rules](#token-rules)
- [Primitive rules](#primitive-rules)
- [Changing things](#changing-things)
- [Motion preferences](#motion-preferences)
- [Guards](#guards)
- [Visual regression](#visual-regression)
- [Where things live](#where-things-live)

## Layers

Three token layers, each with one job. A value belongs to exactly one of them.

| Layer     | File                                           | Contains                                          | May reference |
| --------- | ---------------------------------------------- | ------------------------------------------------- | ------------- |
| Primitive | `apps/desktop/src/styles/tokens/primitive.css` | Raw palettes, type scale, radii, font families    | Nothing       |
| Semantic  | `apps/desktop/src/styles/tokens/semantic.css`  | Roles: canvas, surface, text, border, interactive | Primitives    |
| Component | component scope or `:root`                     | Button/Settings/Markdown/Widget specifics         | Semantics     |

The rule that makes this worth doing: **components read semantic tokens, never a ramp
step.** `bg-surface-sunken` survives a palette change; `bg-[#f0f0ef]` and
`bg-primary-500` do not.

Primitive and semantic tokens must be declared inside `@theme`. Tailwind v4 only
generates utilities for custom properties in `@theme`; a variable declared in `:root`
produces no utility and fails silently when used as a class name. Component tokens are
the exception: they live in `:root` and are read with `bg-(--button-bg)` so they do not
pollute the utility namespace.

## Token rules

- **One role, one name.** `danger` is the only danger role. `error` and `destructive`
  were removed as separate concepts; if you find one, it is legacy.
- **Ramps stay continuous.** A palette step that exists for 50–700 should not skip to 900. Missing steps are added, not worked around.
- **No arbitrary values in class names.** `bg-[#…]`, `text-[Npx]`, `rounded-[…]` and
  `z-[…]` are all drift. If a value is genuinely missing, add a token.
- **Never override a Tailwind default with a different meaning.** The `--radius-sm/md/lg`
  values are deliberately non-default (8/10/12px) because 62 call sites depend on
  `rounded-lg` being 12px. Changing one moves every screen at once.

## Primitive rules

`apps/desktop/src/components/ui/` is the primitive layer. Before hand-rolling markup,
check whether a variant can be extended instead — a new `cva` variant is almost always
cheaper than a new component.

- **Prefer extending over forking.** `Button` carries `variant`, `size`, `iconOnly` and
  `block`; most "I need a slightly different button" cases are one of those.
- **A primitive owns its own appearance.** If a call site has to pass `class=` to make a
  primitive look right in context, the primitive is missing a variant. The audit found
  68.4% of call sites doing exactly that; the number should fall, not rise.
- **Primitives consume tokens.** They must not hard-code palette classes. This is what
  lets a primitive drop into any screen without being repainted.
- **Snapshots are the contract.** Every primitive with a `cva` definition has a class
  snapshot under `apps/desktop/tests/components/ui/`. A snapshot change is a visual
  change and must be declared as such.

## Changing things

Every change declares its visual scope in the PR template.

| Scope      | Meaning                                          | Requirement                                                      |
| ---------- | ------------------------------------------------ | ---------------------------------------------------------------- |
| `none`     | Class output is byte-identical                   | Class snapshot diff empty and visual baselines unchanged         |
| `additive` | New variant or token, existing output unchanged  | Snapshot diff has only `+` lines                                 |
| `breaking` | Any existing class output or token value changes | Call-site inventory, before/after screenshots, reviewer sign-off |

Adding a token is `additive`. Changing a token's value is `breaking`, even when the
number looks small — 62 call sites depend on `--radius-lg`.

Adding or changing anything under `styles/` or `components/ui/` requires maintainer
review via CODEOWNERS.

## Motion preferences

`App.vue` owns one reactive motion policy per window. CSS uses `--motion-duration-scale`;
JavaScript uses `useMotion().duration` or its shared transitions. System reduced motion
takes precedence. Automatic reduction samples renderer delay only while native and
document visibility permit it, after settings initialize.

Keep motion-v's mount-time `MotionConfig` stable; use the shared reactive transitions
for suppression and recovery, including layout, so elements recover without remounting.

## Guards

Two layers, one of them visual. The lint layer is ESLint and its plugins; nothing
here is a bespoke scanner or a numeric baseline file.

### `pnpm lint:check`

Templates and scripts are covered separately because ESLint sees different halves
of a Vue file with different mechanisms.

**Templates** (`apps/desktop/src/**/*.vue`), via ESLint plugins:

- `tailwindcss/no-arbitrary-value` rejects `bg-[#…]`, `text-[Npx]`, `rounded-[…]`,
  `p-[…]`, `font-[…]` and every other arbitrary utility. It reads the real theme
  through `src/styles/tailwind.css`, so custom tokens are recognised and do not
  produce false positives.
- `tailwindcss/no-custom-classname` rejects utilities that do not exist. A class
  that compiles to nothing is invisible in review and in `vue-tsc`; this is the
  rule that catches it. Classes declared in `@layer components` are whitelisted
  because Tailwind does not emit them as utilities.
- `vue/no-restricted-class` rejects palette utilities such as `bg-white`,
  `bg-neutral-100` and `text-black`. They are valid Tailwind and render fine; the
  problem is that they bypass the semantic roles, so a palette change cannot reach
  them.

**Scripts** (`apps/desktop/src/**/*.{ts,vue}`), via `no-restricted-syntax`:

- Arbitrary values and palette utilities written in `cva` definitions, variant maps
  and class constants. Core ESLint never traverses template attributes, so these
  selectors deliberately cover only the script half. The Tailwind plugin is the
  template half; neither is mistaken for the other. Unknown utilities in script
  strings are not caught; that gap is covered in the `Not covered` list below.

**Existing violations** are held by ESLint's own bulk suppressions
(`apps/desktop/eslint-suppressions.json`, generated with `--suppress-all`). Fixing
a violation should be followed by:

```bash
pnpm design:prune
```

That drops stale entries so the file only records debt that still exists. Run it
**after removing a violation and before adding its replacement**: pruning after a
same-count swap cannot reveal the newly suppressed violation, because the count is
identical either way. There is no drift budget and no
`design-system-baseline.json`: a numeric ratchet was a bespoke mechanism with no
established precedent, and the lint rules plus the suppression file express the
same "old debt frozen, new code clean" intent using a standard ESLint feature.

**Read the suppression semantics before trusting the number.** ESLint records a
count per file and rule, not a position, and it suppresses the first `count`
violations it finds:

- Adding a violation to a suppressed file raises the count above the budget and
  every violation in that file is reported. This is the common case and it works.
- Removing one violation and adding a different one in the same file keeps the
  count unchanged, so the new violation is suppressed silently. Pruning between
  the two steps is what exposes it; a single review of the finished diff cannot.
- Touching a suppressed line does not by itself bring the violation back.

The gap is narrow — a net-zero swap inside one already-suppressed file — but it is
real, so a diff that touches a file listed in the suppression file deserves a
closer look than the lint result alone. It is documented here rather than papered
over because the alternative, a bespoke line-addressable baseline, is the
mechanism this PR removed.

`pnpm design:check` is an alias for `pnpm lint:check`, kept because the PR
checklist refers to it.

### Visual regression

Two layers, because they answer different questions and neither covers the other.

**The application layer** (`pnpm test:e2e`, WebdriverIO + `@wdio/visual-service`)
renders the real Tauri app against the real Rust backend. It proves the assembled
interface still looks right. Baselines live in
`apps/desktop/e2e-tests/__snapshots__/` and are committed, so a visual change is
reviewed as an image diff in the same PR that changes the code.

Covered today:

- the search window's empty state, and the results panel;
- the main window with a finished conversation, and with the ask-user panel in
  front of the user;
- the settings window's `general`, `ai-services`, `built-in-tools` and `search`
  sections.

Those screens are driven by fixtures from the E2E bridge rather than by real data:
a conversation seeded through the bridge, a pending approval enqueued through the
store, and a search query (`touchai-visual-fixture`) that no real file matches. Using
real data would tie the pixels to the machine — a developer's disk has thousands of
search hits, a fresh CI runner has none — and to a model's output. Nothing appears in
a baseline that is not deterministic by construction.

Sections populated from local configuration only are covered. Usage (date buckets),
browser (installed executable paths) and data management (history timestamps) change
between runs by design, so they are not baselines; a permanently red check would
train people to ignore it.

**The component layer** (`pnpm test:visual:components`, Storybook + Playwright)
renders one component at a time in headless Chromium. It covers what a screen never
shows all at once: every button variant, a switch in each size, tone and state, an
empty and a populated chart. Stories live next to their component
(`src/**/*.stories.ts`), so adding a variant adds coverage. Baselines live in
`apps/desktop/tests/visual/__snapshots__/`.

The story list is read from Storybook's `index.json` at run time, so a new story
becomes a baseline automatically instead of waiting for someone to add it to a list.

#### Fidelity: the font and the window size

A baseline that renders a different typeface or a different viewport from the real
app is not evidence, however green it is. Both layers are pinned to the real thing:

**Font.** The app ships no font. `src/utils/font.ts` downloads Source Han Serif into
`<app root>/assets/font/` at first launch and injects `@font-face` for it. Every
`font-serif` element — settings headings, dialog titles, buttons, message text —
depends on that file, so without it the whole interface renders in a generic serif
that no user sees.

The file is a variable font. The standard `format('woff2')` container hint is enough:
variation support comes from `font-weight: 250 900` in the rule, not from the format
string. Measured with this file at weight 500, `woff2`, the legacy
`woff2-variations` alias, and a face built directly from the bytes render identically
in WebView2 and WebKit.

```css
src: url('SourceHanSerifSC-VF.ttf.woff2') format('woff2');
```

WebKitGTK 2.52 rejects the legacy `woff2-variations` alias outright: it drops the
whole `src` entry and leaves the face at `status: "error"`. Keep the standard
container value. Do **not** use `format('woff2 supports variations')` either; that
string is not in the specification and older Chromium releases reject the entire
`src` entry.

The same WebKitGTK build also rejects this particular WOFF2 during decoding: the
compressed face is 21.6 MB but expands to 59,997,432 bytes, above its 30 MB output
limit. The renderer detects the rejected face (including the false-positive case
where `document.fonts.check()` returns `true` while `FontFace.status` is `error`)
and asks `prepare_product_font_file` for a fallback. That native command decodes
the verified WOFF2 once with the `wuff` crate, caches a plain TTF beside it, and
returns the TTF path. The renderer then registers the same family from
`format('truetype')`; this is still the product face, not a system font swap.

When the asset URL cannot be fetched, the app removes the failed `@font-face` rule
before registering the file bytes in memory. Keeping the failed face in the family
would leave WebKit resolving the same family to the poisoned rule, so the preview
recorder also accepts a loaded in-memory face without a style rule.

`apps/desktop/e2e-tests/e2e-font.js` provisions the file for the application layer. It
fetches the exact file the product uses from jsDelivr (falling back to the product's own
CDN list), verifies it against the product's `sha256` from
`src-tauri/src/core/system/assets.rs`, caches it under the Cargo target directory, and
copies it into each session's app root before the app starts. The Storybook layer serves
the same verified file through a small Vite middleware.

Both layers then assert the interface is really painted in it, because a font failure is
silent. The assertion in `useProductFont()` has two parts, and both are needed:

1. The engine must have registered a face for the family. A rejected format hint
   registers none — measurable as an empty `document.fonts` entry — and this signal does
   not depend on which fonts the machine has installed.
2. The painted Han outline must match a reference face built from the app's own bytes.
   Outlines cannot be faked by synthetic bold the way advance widths can, and both sides
   derive from the same file, so no installed font participates.

Part 1 is what makes part 2 trustworthy. Without it a rejected rule makes the reference
fall back too, both sides agree, and the check passes on a window showing the wrong
typeface — which is exactly how a wrong baseline shipped once. Comparisons against
generic `serif` do not work for the same reason: on a machine with a CJK serif installed
it resolves to a near-identical design, and on a bare runner it resolves to a font with
no Han glyphs, so in both cases a double fallback reads as a match.

**Window size.** The settings baselines capture the product's own 1120x700 visible
surface. `SETTINGS_WINDOW_DEFAULT_SIZE` is the native window size and therefore also
includes the transparent 24 px shadow gutter on each side. Both mirror the content and
native constants in `src-tauri/src/core/window/settings/mod.rs`. A GitHub-hosted runner
only has a 1024x768 desktop, but Windows does not clamp a window to the desktop and
WebDriver captures the window rather than the screen, so the real size works there.

**Native window chrome.** Every floating top-level window uses the same 1 px WinUI
surface stroke. The source value is `SurfaceStrokeColorDefault` in
`microsoft/microsoft-ui-xaml` (`Common_themeresources_any.xaml`): ARGB `#66757575`,
which is 40% of `#757575`. CSS hex is `RRGGBBAA`, so the token is
`rgb(117 117 117 / 0.4)` (or `#75757566`), never the ARGB string itself.

The stroke is an inset `box-shadow` ring, not a `border`: it follows the window
radius, does not consume layout, survives the search card's `border-0`, and
composites over the window surface the way the reference stroke does. Settings and
the search card use the full `--shadow-window`; in-window popovers keep their own
card border and ambient-only shadow. The tray menu is size-constrained, so it keeps
its existing inset 1 px border but reads the same `--color-window-border` token.

`--spacing-window-gutter: 24px` mirrors Rust's `WINDOW_SHADOW_GUTTER = 24.0`; it is
the transparent room around the settings window, not the search host's separate
48 px visual outset or 24 px native-region outset. Maximized and fullscreen windows
reset the ring, radius, gutter, and shadow together.

#### Text, language, and tolerance

Text stays visible: the baselines show the real interface, so a reviewer can judge the
change from the images in the PR. Determinism comes from the language setting instead
of hiding glyphs. The first-launch language is derived from `navigator.language`, so a
zh-CN laptop and an en-US CI runner would render different words; the specs call the
E2E bridge's `setLanguage('en-US')` before the first capture, writing the same setting
a user would change in General. English is the fallback first-launch locale and its
Latin glyphs rasterise identically across machines. Wording itself is still covered by
the i18n tests.

Compare while running the normal suite:

```bash
pnpm test:e2e                # application layer
pnpm test:visual:components  # component layer
```

Update application baselines only when the visual change is intended:

```bash
gh workflow run e2e-smoke.yml --ref <branch> -f update_visual_baselines=true
gh run download <run-id> --name visual-baselines --dir /tmp/baselines
```

Commit the downloaded images with the code. Baseline pixels must come from the runner
that gates the PR: a developer machine renders at its own DPI and with its own font
rasterisation, so a baseline generated there differs from the comparison environment
by a few percent — exactly the budget a real regression needs.
`pnpm test:e2e:visual:update` exists for local iteration, but do not commit what it
writes from a scaled machine.

Component baselines are generated by Playwright itself
(`pnpm test:visual:components:update`) and are portable: headless Chromium renders at
`deviceScaleFactor: 1` on every platform, which is why that layer can use a 0.1%
pixel-ratio budget while the application layer needs 2%.

The application layer's 2% on the CI runner absorbs two environment differences:

- **Render scale.** WebView2 renders at the OS DPI — 150% on a laptop, 100% on a CI
  runner — and ignores `--force-device-scale-factor`, so the raw screenshot is larger
  on a scaled machine. Baselines are stored at CSS pixel size, so the 100% runner
  compares against an exact match.
- **Antialiasing.** Rescaling re-renders glyph edges, so AA differences are forgiven
  (`ignoreAntialiasing`).

A local run on a scaled display resamples every capture back down, which costs a couple
of percent on text-heavy screens before any code changes.
`visualMismatchTolerance()` returns 2% at `devicePixelRatio === 1` and 5% above it, so
the gate stays strict where it counts and a laptop can still run the suite.

Be honest about what the budget buys: 2% of a 752x648 element is about 9,700 pixels, so
a small control that disappears, or a one-pixel border that changes colour, can sit
inside it. The baselines catch what moves a visible share of a screen — a token swap, a
spacing change, a font change, a section that no longer renders. If a specific small
control matters, assert it directly with a `data-testid` check, or give it a story so
the component layer measures it in isolation.

### The widget contract

The `show-widget` tool asks the model to style generated HTML against a fixed set of
variable names, documented in `apps/desktop/src/prompts/show-widget/core_design_system.md`.
Those names live in the `Widget contract` block of `semantic.css`.

This used to be a second design language. Twenty of the twenty-nine variables had no token
behind them, so `runtimeConstants.ts` supplied hardcoded fallbacks: a neutral grey
`#2c2c2a` where the app uses its warm brown `#4a4039`, an 8px radius where the app uses
10px, and a third copy of the monospace stack. Widgets rendered through the fallback path
did not match the interface they sat in, which is the opposite of what the prompt asks for
("users shouldn't notice where TouchAI ends and your widget begins").

`apps/desktop/tests/ci/design-widget-contract.test.ts` fails if a declared variable stops
resolving to a token, or if a fallback value diverges from its token.

### Not covered

- Runtime styling in the `show-widget` renderer, which is generated from tokens at
  runtime rather than compiled.
- The `settings-*` and `t-*` component classes are whitelisted from
  `no-custom-classname` because they live in `@layer components`, not as utilities.
  A change inside one of them is only caught by visual regression if it appears in
  a covered screen.
- Unknown utilities written in script class strings. The Tailwind plugin inspects
  templates only; the script selectors cover arbitrary values and palette
  utilities, not class-name existence.
- Native `<button>`, `<input>` and `<label>` are not banned yet. The audit measured
  79 raw buttons; enforcing the primitive layer here needs a suppression pass of
  its own, so it is a follow-up rather than a silent addition to this gate.

## Where things live

```
apps/desktop/src/styles/
  tailwind.css          imports the token layers, holds @layer base and @layer components
  tokens/primitive.css  raw values
  tokens/semantic.css   roles
  motion.css            duration/ease/scale tokens and t-* classes
  markdown.css          markdown rendering surface

apps/desktop/src/components/ui/   primitives, one directory per element
apps/desktop/src/lib/utils.ts     cn(), configured so custom tokens merge correctly

apps/desktop/eslint-suppressions.json    existing lint debt, managed by ESLint
apps/desktop/e2e-tests/__snapshots__/    committed visual baselines
```

`cn()` is configured with `extendTailwindMerge` and knows the custom token names. This
matters more than it looks: without it, a call site overriding a primitive with one of
our own tokens does not win the merge, and both classes survive to the cascade.
