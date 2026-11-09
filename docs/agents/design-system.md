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
- [Baseline fidelity](#baseline-fidelity)
- [Not covered](#not-covered)
- [Where things live](#where-things-live)

## Layers

Three token layers, each with one job. A value belongs to exactly one of them.

| Layer | File | Contains | May reference |
| --- | --- | --- | --- |
| Primitive | `apps/desktop/src/styles/tokens/primitive.css` | Raw palettes, type scale, radii, font families | Nothing |
| Semantic | `apps/desktop/src/styles/tokens/semantic.css` | Roles: canvas, surface, text, border, interactive | Primitives |
| Component | component scope or `:root` | Button/Settings/Markdown/Widget specifics | Semantics |

**Components read semantic tokens, never a ramp step.** `bg-surface-sunken` survives a
palette change; `bg-[#f0f0ef]` and `bg-primary-500` do not.

Primitive and semantic tokens must be declared inside `@theme`; Tailwind v4 only
generates utilities for custom properties declared there. Component tokens live in
`:root` and are read as `bg-(--button-bg)` so they do not pollute the utility namespace.

## Token rules

- **One role, one name.** `danger` is the only danger role; `error` and `destructive`
  are legacy.
- **Ramps stay continuous.** Add a missing step instead of skipping one.
- **No arbitrary values in class names.** `bg-[#…]`, `text-[Npx]`, `rounded-[…]`,
  `p-[…]` and `z-[…]` are drift. If a value is genuinely missing, add a token.
- **Never override a Tailwind default with a different meaning.** `--radius-sm/md/lg`
  are deliberately 8/10/12px because many call sites depend on them; changing one
  moves every screen.

## Primitive rules

`apps/desktop/src/components/ui/` is the primitive layer. Check whether an existing
variant can be extended before hand-rolling markup.

- **Prefer extending over forking.** A new `cva` variant is almost always cheaper than
  a new component.
- **A primitive owns its own appearance.** A call site passing `class=` to make a
  primitive look right means a variant is missing.
- **Primitives consume tokens.** No hard-coded palette classes.
- **Class snapshots are the contract.** They live under
  `apps/desktop/tests/components/ui/`; a snapshot change is a visual change.

## Changing things

Every change declares its visual scope in the PR template.

| Scope | Meaning | Requirement |
| --- | --- | --- |
| `none` | Class output is byte-identical | Class snapshot diff empty and visual baselines unchanged |
| `additive` | New variant or token, existing output unchanged | Snapshot diff has only `+` lines |
| `breaking` | Any existing class output or token value changes | Call-site inventory, before/after screenshots, reviewer sign-off |

Adding a token is `additive`; changing a token's value is `breaking`, however small the
number looks. Anything under `styles/` or `components/ui/` needs maintainer review via
CODEOWNERS.

## Motion preferences

`App.vue` owns one reactive motion policy per window. CSS reads
`--motion-duration-scale`; JavaScript reads `useMotion().duration` or the shared
transitions. System reduced motion takes precedence.

Keep motion-v's mount-time `MotionConfig` stable: drive suppression and recovery
through the shared reactive transitions, including layout, so elements recover without
remounting.

## Guards

`pnpm design:check` (an alias for `pnpm lint:check`) must pass. ESLint rejects
arbitrary values, unknown utilities and palette utilities in templates, and the same
drift written in `cva` definitions, variant maps and class constants.

Existing violations are held by count-based suppressions in
`apps/desktop/eslint-suppressions.json`. After removing a violation, run
`pnpm design:prune` before adding its replacement; a same-count swap inside one
suppressed file is otherwise invisible. Treat a diff that touches a suppressed file as
worth a closer read than the lint result.

## Visual regression

Two layers, because they answer different questions:

- **Application** (`pnpm test:e2e`, WebdriverIO + `@wdio/visual-service`) renders the
  real Tauri app and backend. Baselines are committed in
  `apps/desktop/e2e-tests/__snapshots__/`.
- **Component** (`pnpm test:visual:components`, Storybook + Playwright) renders one
  component at a time in headless Chromium. Stories live next to their component
  (`src/**/*.stories.ts`); baselines live in
  `apps/desktop/tests/visual/__snapshots__/`.

Add a story when a component needs isolated coverage: a screen-level budget will not
catch a small control that disappears or changes colour. Assert important small
controls directly with a `data-testid` check.

Baselines must stay deterministic: drive screens from fixtures rather than real data,
set `en-US` through the E2E bridge before the first capture, and keep text visible
instead of hiding glyphs.

Update application baselines only through the workflow that gates the PR:

```bash
gh workflow run e2e-smoke.yml --ref <branch> -f update_visual_baselines=true
gh run download <run-id> --name visual-baselines --dir /tmp/baselines
```

`pnpm test:e2e:visual:update` exists for local iteration, but do not commit output from
a scaled machine. Component baselines are portable and may be updated locally with
`pnpm test:visual:components:update`.

## Baseline fidelity

A baseline that renders a different typeface or viewport from the real app is not
evidence.

- **Font.** Baselines must paint the product face (Source Han Serif), not a system
  fallback. Keep `src: url(…) format('woff2')`; the legacy `woff2-variations` alias and
  the non-standard `format('woff2 supports variations')` both make engines drop the
  rule. WebKitGTK also rejects this face above its decode limit, so keep the
  `prepare_product_font_file` fallback that registers the decoded TTF under the same
  family. Verify a face is registered *and* the painted Han outline matches a
  reference built from the app's own bytes: `document.fonts.check()` alone returns
  `true` for a failed face, and comparing against generic `serif` reads as a match
  either way.
- **Window size.** Settings baselines capture the real native window: 1120x700 visible
  content plus a 24px transparent gutter per side. Keep
  `SETTINGS_WINDOW_DEFAULT_SIZE` in sync with the Rust constants in
  `src-tauri/src/core/window/settings/mod.rs`.
- **Window chrome.** Floating top-level windows share one inset 1px stroke from
  `--color-window-border`. Draw it as an inset `box-shadow` ring, not a `border`, so it
  follows the radius without consuming layout. Maximized and fullscreen windows reset
  ring, radius, gutter and shadow together. Keep `--spacing-window-gutter` in sync with
  Rust's `WINDOW_SHADOW_GUTTER`.
  Settings paints its stroke on a pointer-transparent pseudo-element above the shell's
  children. Its native Windows border is disabled so the transparent gutter has no outline.

## Not covered

- Runtime styling in the `show-widget` renderer, which is generated from tokens at
  runtime rather than compiled.
- The `settings-*` and `t-*` classes live in `@layer components` and are whitelisted
  from the unknown-utility rule; only visual regression can catch a change inside them.
- Unknown utilities written in script class strings.
- Native `<button>`, `<input>` and `<label>` are not banned yet.

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

`cn()` uses `extendTailwindMerge` and knows the custom token names, so a call site can
override a primitive with one of our tokens and win the merge.
