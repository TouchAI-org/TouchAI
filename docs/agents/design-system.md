# Design system

Owner page for the desktop app's visual language. Read this before changing tokens,
primitives, or view-layer styling.

- [Layers](#layers)
- [Token rules](#token-rules)
- [Primitive rules](#primitive-rules)
- [Changing things](#changing-things)
- [Guards](#guards)
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
| `none` | Class output is byte-identical | Snapshot diff empty |
| `additive` | New variant or token, existing output unchanged | Snapshot diff has only `+` lines |
| `breaking` | Any existing class output or token value changes | Call-site inventory, before/after screenshots, reviewer sign-off |

Adding a token is `additive`. Changing a token's value is `breaking`, even when the
number looks small — 62 call sites depend on `--radius-lg`.

Adding or changing anything under `styles/` or `components/ui/` requires maintainer
review via CODEOWNERS.

## Guards

Three automated checks, each covering a different blind spot. Together they are what
keeps the design system from decaying back into per-screen styling.

### `pnpm design:contract`

Every colour utility used in a template must resolve to a token or a Tailwind palette
colour. This exists because of a specific failure mode: `bg-card`, `bg-hover` and
`bg-active` were used in templates while no `@theme` entry declared them. They rendered
only because a scoped stylesheet hand-wrote the matching classes. Tailwind emits no
warning for an unknown utility and `vue-tsc` does not inspect class names, so moving
those components would have broken their styling with a fully green build.

### `pnpm design:budget`

A ratchet over `design-system-baseline.json`. Two thresholds:

- **Totals may only fall.** Exceeding a recorded count fails.
- **Added lines are zero-tolerance.** New arbitrary values fail regardless of totals,
  netted against removed lines so that a cleanup which re-adds an unrelated pre-existing
  utility is not punished.

This is the check that works without first paying down the backlog. Lower a number in
the same PR that removes the occurrences; never raise one without an RFC.

### ESLint `no-restricted-syntax`

Covers class strings written in `<script>`: `cva` definitions, variant maps, constants.
Zero-tolerance across `components/ui/`.

Note the scope limit: ESLint core rules only traverse the `<script>` block, so template
attributes are invisible to them. A `VLiteral` selector compiles and matches nothing,
which gives false confidence. Template classes are the drift budget's job.

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

- Pixel-diff visual regression. The WebView2 runtime, runtime font loading and
  undecorated windows make it noisy enough that a false-positive rate of 10–20% is
  expected. Screenshot archival in e2e is the current substitute.
- Runtime styling in the `show-widget` renderer, which is generated from tokens at
  runtime rather than compiled.

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

apps/desktop/scripts/ci/design-drift-budget.mjs    ratchet
apps/desktop/scripts/ci/design-token-contract.mjs  contract
design-system-baseline.json                        recorded counts
```

`cn()` is configured with `extendTailwindMerge` and knows the custom token names. This
matters more than it looks: without it, a call site overriding a primitive with one of
our own tokens does not win the merge, and both classes survive to the cascade.
