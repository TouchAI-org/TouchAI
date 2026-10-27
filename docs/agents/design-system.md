# Design system

Owner page for the desktop app's visual language. Read this before changing tokens,
primitives, or view-layer styling.

- [Layers](#layers)
- [Token rules](#token-rules)
- [Primitive rules](#primitive-rules)
- [Changing things](#changing-things)
- [Guards](#guards)
- [Visual regression](#visual-regression)
- [Where things live](#where-things-live)

## Layers

Three token layers, each with one job. A value belongs to exactly one of them.

| Layer | File | Contains | May reference |
| --- | --- | --- | --- |
| Primitive | `apps/desktop/src/styles/tokens/primitive.css` | Raw palettes, type scale, radii, font families | Nothing |
| Semantic | `apps/desktop/src/styles/tokens/semantic.css` | Roles: canvas, surface, text, border, interactive | Primitives |
| Component | component scope or `:root` | Button/Settings/Markdown/Widget specifics | Semantics |

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
- **Ramps stay continuous.** A palette step that exists for 50–700 should not skip to
  900. Missing steps are added, not worked around.
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

| Scope | Meaning | Requirement |
| --- | --- | --- |
| `none` | Class output is byte-identical | Class snapshot diff empty and visual baselines unchanged |
| `additive` | New variant or token, existing output unchanged | Snapshot diff has only `+` lines |
| `breaking` | Any existing class output or token value changes | Call-site inventory, before/after screenshots, reviewer sign-off |

Adding a token is `additive`. Changing a token's value is `breaking`, even when the
number looks small — 62 call sites depend on `--radius-lg`.

Adding or changing anything under `styles/` or `components/ui/` requires maintainer
review via CODEOWNERS.

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

#### Where baselines are generated, and why

Baselines are generated in CI, never on a developer machine. This is not a
preference; it is what makes the comparison mean anything.

Playwright's own documentation states it plainly:

> Browser rendering can vary based on the host OS, version, settings, hardware,
> power source (battery vs. power adapter), headless mode, and other factors. For
> consistent screenshots, run tests in the same environment where the baseline
> screenshots were generated.

The first set of application baselines for this project was generated locally and
failed on CI by 2.2–2.6% with no code change, because the developer machine renders
at 150% device pixel ratio. The same class of failure is why the component layer runs
inside `mcr.microsoft.com/playwright:v1.64.1-noble`: the image pins Chromium *and* the
system fonts and libraries, so a runner image update cannot silently move every
baseline at once.

The tag must equal the `@playwright/test` version in the lockfile. If the two drift,
Playwright cannot find its browsers at all, which surfaces as an opaque "executable
doesn't exist" — so the workflow asserts the match before running anything and says
what to change.

**Regenerating.** Two ways, both producing the same pixels as the gate:

```bash
# Regenerate and collect the result by hand.
gh workflow run "Component Visual Tests" --ref <branch> -f update_visual_baselines=true
gh run download <run-id> --name component-baselines --dir apps/desktop/tests/visual/__snapshots__

# Or ask the bot to do the same thing and commit it back.
# In a pull request comment:
#   /approve-visuals              both layers
#   /approve-visuals components   the component layer only
#   /approve-visuals e2e          the app (WebView2) layer only
```

`/approve-visuals` only runs for commenters with write access — checked against the
collaborator permission API, not `author_association`, which reports how someone relates
to the repository rather than what they may do in it. It dispatches the existing
workflows rather than re-implementing them, and commits the result to the branch under
review.

That commit is pushed with a GitHub App installation token (`BOT_APP_ID` /
`BOT_APP_PRIVATE_KEY`), not with the built-in `GITHUB_TOKEN`. The difference matters:
GitHub suppresses workflow runs for events `GITHUB_TOKEN` causes, so a commit pushed with
it lands on the branch without starting the `pull_request` workflows that gate the pull
request, and branch protection then waits for statuses that will never arrive. An App
token's push is an ordinary push, so its checks are eligible and appear on their own.

The App token is the narrow credential here, not a broad one: it is issued per run, it
expires after an hour, and it is scoped to the repositories the App is installed on. A
personal access token able to push would also have to be readable by every workflow in a
public repository, which is why it was rejected.

A `workflow_dispatch` run cannot substitute for this. GitHub only counts check runs from
`push`, `pull_request`, `pull_request_review`, `pull_request_target`, `deployment` and
`deployment_status`, so a dispatched run's checks never appear in the pull request even
when they pass on its head commit. The dispatch is still made after the push, but for a
different reason: it re-runs the comparison against the baselines that were just written,
which catches a renderer that cannot reproduce its own output.

**Never regenerate automatically.** A baseline that rewrites itself on push or on a
schedule is not a baseline; it is a recording of whatever the code currently does, and
every regression it was meant to catch gets absorbed silently. Approving a baseline is
a decision, and the person who makes it is the reviewer, not the author.

**Reading a failure without leaving the PR.** Both layers report into a single comment on
the pull request, updated in place and never duplicated. The comment carries one block per
layer, so a reviewer sees the component primitives and the real application window in the
same place instead of hunting through two workflows' comments for whichever one moved.

The two layers run in separate workflows, on different runners, finishing at unpredictable
times, so each writes only its own block. `apps/desktop/scripts/ci/visual-report.mjs`
turns a layer's result into markdown; `apps/desktop/scripts/ci/visual-comment.mjs` merges
that block into the shared comment, and `visual-comment-merge.mjs` holds the merge itself
as a pure function. The workflows serialise their comment jobs on one concurrency group so
two merges cannot interleave and silently drop a layer — a correct merge function is not
enough when the read-modify-write spans two processes.

The images are published through GitHub's attachment store by
`apps/desktop/scripts/ci/publish-evidence.mjs`, which posts to
`https://uploads.github.com/user-attachments/assets` — the endpoint the web UI uses when
a file is pasted into a comment. Two of its behaviours are undocumented and were measured
rather than assumed:

- **A fresh upload is not readable yet.** Its URL answers 404 until a comment references
  it, then serves the image anonymously. The report embeds the URL in the comment it
  posts, which is what activates it; deleting that comment later does not revoke it.
- **It needs a user token.** Installation tokens and `GITHUB_TOKEN` get 404, because an
  attachment has an author and a bot has none. The workflow reads `UI_PREVIEW_TOKEN`, the
  same secret the UI preview workflow uses for the same reason.

When that secret is absent — a fork pull request, or a repository that has not configured
it — nothing is uploaded and the report names the files and links the layer's artifact
(`component-visual-diffs` or `app-visual-diffs`) instead. That is a worse report, not a
failed run, and the comparison result is still reported.

The report also sanitises every value it prints. Test titles come from the Playwright
report verbatim, and adding a file under `tests/visual/` is both what triggers the
workflow and what supplies the title, so a title is attacker-controlled by the pull
request author. Left raw it could close a table cell or inject a heading and a link into
a comment posted by the automation — on the very report a reviewer uses as evidence. See
`apps/desktop/tests/ci/visual-report.test.ts`.

#### Fidelity: the font and the window size

A baseline that renders a different typeface or a different viewport from the real
app is not evidence, however green it is. Both layers are pinned to the real thing:

**Font.** The app ships no font. `src/utils/font.ts` downloads Source Han Serif into
`<app root>/assets/font/` at first launch and injects `@font-face` for it. Every
`font-serif` element — settings headings, dialog titles, buttons, message text —
depends on that file, so without it the whole interface renders in a generic serif
that no user sees.

The file is a variable font, and the `format()` hint on that rule decides whether it is
painted at all. An engine that is not told the file carries a variation axis loads it as
a static face, finds no instance for the requested weight, and silently substitutes
`serif` — no error, `document.fonts.check()` still returns `true`, and the face still
reports `status: "loaded"`. The rule must therefore use the form CSS Fonts 4 defines:

```css
src: url('…woff2') format('woff2-variations');
```

`format('woff2') tech(variations)` is the modern equivalent. `format('woff2 supports
variations')` is **not** in the specification — `<font-format>` accepts only `woff2`,
`woff`, `opentype` and friends, and the variation requirement is expressed through
`<font-tech>`. It appeared in pre-2018 articles about an early draft. Chromium 156
parses it leniently enough to work while Chromium 155 rejects the entire `src` entry, so
the same rule rendered the font on a developer machine and fell back on CI. That cost
several wrong diagnoses; do not reintroduce it.

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

**Window size.** The settings baselines capture the product's own default window
(`SETTINGS_WINDOW_DEFAULT_SIZE`, mirroring
`SETTINGS_WINDOW_WIDTH`/`SETTINGS_WINDOW_HEIGHT` in
`src-tauri/src/core/window/settings/mod.rs`). A GitHub-hosted runner only has a
1024x768 desktop, but Windows does not clamp a window to the desktop and WebDriver
captures the window rather than the screen, so the real size works there.

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

`tests/ci/design-widget-contract.test.ts` fails if a declared variable stops resolving to
a token, or if a fallback value diverges from its token.

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
