---
name: widget
description: Create, update, and remove inline HTML/SVG widgets in TouchAI for diagrams, charts, interactive explainers, UI mockups, and illustrations. Load before using builtin__show_widget.
metadata:
    short-description: Create inline visual widgets
---

# ShowWidget — Inline Visual Artifacts

## Overview

Use `builtin__show_widget` to create live, interactive HTML/SVG artifacts that render inline in the conversation. The widget appears inline in an opaque-origin sandbox iframe and streams progressively as you generate it.

## Workflow

1. Load the built-in `widget` skill with `builtin__activate_skill`, passing `name: "widget"` and the exact absolute `path` shown in the skill catalog. Its installed location is `appRoot/skills/.system/widget/SKILL.md`, where `appRoot` is the current application root; use the discovered path rather than guessing it.
2. Read this complete guide before creating the visual. If the built-in skill was already activated by user selection for this request, use that loaded guide.
3. Call `builtin__show_widget` with `is_read_widget_skill: true` before `widget_code`. Set it for creation, updates, and removal. Reuse `widgetId` to update the same visual; for removal, pass `mode: "remove"` and its `widgetId` without `widget_code`.

`is_read_widget_skill` is a reminder that you read this guide. It is not a credential or an access control mechanism.

Explain or clarify in normal assistant text whenever useful. Skill activation does not require the next assistant response to be a tool call.

## Runtime

TouchAI renders each widget in an opaque-origin sandbox iframe. Generated code cannot access the application DOM, Tauri bridge, storage, or session state. The widget inherits the approved host CSS variables through a controlled theme snapshot; it does not inherit the host document or arbitrary styles. Keep generated selectors local and do not style `html`, `body`, or `:root`.

During streaming, keyed DOM patching preserves nodes identified by a stable `data-widget-key` or `id`. Emit meaningful static content early. Only final classic scripts execute after streaming completes, in document order; external allowlisted scripts finish loading before the following initializer. Bind internal interactions with `addEventListener`, and use `data-send-prompt` or `data-open-link` for controlled host actions.

The host sizes the iframe to normal-flow content without a fixed height clamp. Keep artifacts compact, SVG viewBox height tight to content, and avoid nested scrolling or fixed positioning. Standard HTML and SVG are supported; custom widget component tags are not.

## Critical: Streaming-First Output Order

The widget streams token-by-token. Structure your tool call so visible content appears IMMEDIATELY:

```json
{
    "is_read_widget_skill": true,
    "widget_code": "<svg viewBox=\"0 0 400 200\">...",
    "widgetId": "optional-id",
    "title": "optional-title"
}
```

**Start `widget_code` on the SAME LINE as the opening quote.** Do not output metadata fields first. The first characters of `widget_code` should already contain a visible root element (`<svg>`, `<div>`, `<section>`).

### Streaming Structure

- **Visible root first** — start with `<svg>`, `<div>`, or `<section>`, not `<style>` or `<script>`
- **Visible HTML/SVG immediately** — structure, shapes, text
- **Inline styles first when needed** — controls and first-screen structure should look correct mid-stream
- **Optional `<style>` later** — keep it under 15 lines and place it inside the visible root after the first visible content
- **Scripts last** — they execute after streaming completes

Example:

```html
<div class="root" style="display:grid;gap:8px">
    <div>Visible content here</div>
    <svg>...</svg>
    <style>
        .root svg {
            max-height: 220px;
        }
    </style>
</div>
<script>
    // Interactive behavior here
</script>
```

## Design Principles

- **Seamless**: Transparent background, no card shell, feels like part of the conversation
- **Flat**: No gradients, shadows, blur, or decorative effects
- **Compact**: Show essentials inline, explain details in your text response
- **Text outside, visuals inside**: All explanatory prose goes in your response text, NOT in the widget HTML

## What Gets Rejected

Outputs using these will fail validation:

- Gradients (`linear-gradient`, `radial-gradient`)
- Shadows (`box-shadow`, `text-shadow`)
- Blur effects (`backdrop-filter`, `filter: blur`)
- Rounded outer wrapper (unless explicitly a mockup)
- Background on outer wrapper (unless explicitly a mockup)
- Full HTML page structure (`<html>`, `<body>`)
- Iframes or embeds
- External resources outside the CDN allowlist

## Modules

Use the relevant sections below; all guidance is included in this skill:

- `diagram` — SVG flowcharts, org charts, system architecture, illustrative diagrams
- `mockup` — UI mockups, wireframes, forms, cards, dashboards
- `interactive` — interactive explainers, calculators, configurators, games
- `chart` — charts and data analysis (includes Chart.js)
- `art` — illustration and generative art

Pick the closest fit and follow the shared core rules alongside its detailed guidance.

**Complexity budget — hard limits:**

- Box subtitles: ≤5 words. Detail goes in click-through controls using `data-send-prompt` or the prose below — not the box.
- Colors: ≤2 ramps per diagram. If colors encode meaning (states, tiers), add a 1-line legend. Otherwise use one neutral ramp.
- Horizontal tier: ≤4 boxes at full width (~140px each). 5+ boxes → shrink to ≤110px OR wrap to 2 rows OR split into overview + detail diagrams.

If you catch yourself writing "click to learn more" in prose, the diagram itself must ACTUALLY be sparse. Don't promise brevity then front-load everything.

You create rich visual content — SVG diagrams/illustrations and HTML interactive widgets — that renders inline in conversation. The best output feels like a natural extension of the chat.

## Core Design System

These rules apply to ALL use cases.

### Philosophy

- **Seamless**: Users shouldn't notice where TouchAI ends and your widget begins.
- **Flat**: No gradients, mesh backgrounds, noise textures, or decorative effects. Clean flat surfaces.
- **Compact**: Show the essential inline. Explain the rest in text.
- **Text goes in your response, visuals go in the tool** — All explanatory text, descriptions, introductions, and summaries must be written as normal response text OUTSIDE the tool call. The tool output should contain ONLY the visual element (diagram, chart, interactive widget). Never put paragraphs of explanation, section headings, or descriptive prose inside the HTML/SVG. If the user asks "explain X", write the explanation in your response and use the tool only for the visual that accompanies it. The user's font settings only apply to your response text, not to text inside the widget.

### Streaming

Output streams token-by-token. Structure code so useful content appears early.

**CRITICAL: Start widget_code with visible content on the SAME LINE as the opening quote.**

Good:

```json
{"is_read_widget_skill":true,"widget_code":"<svg viewBox=\"0 0 400 200\"><rect...
```

Bad (delays visible content):

```json
{
  "is_read_widget_skill": true,
  "widgetId": "my-widget",
  "title": "My Widget",
  "widget_code": "<svg...
```

**Output order:**

- **HTML**: visible root (`<div>` or `<section>`) → visible content immediately → optional short `<style>` inside that root after the first visible content → `<script>` last.
- **SVG**: `<defs>` (markers) → visual elements immediately.
- Prefer inline `style="..."` over `<style>` blocks — inputs/controls must look correct mid-stream.
- Keep `<style>` under ~15 lines. Interactive widgets with inputs and sliders need more style rules — that's fine, but don't bloat with decorative CSS.
- Gradients, shadows, and blur flash during streaming DOM diffs. Use solid flat fills instead.

**Why this matters:** The widget renders progressively as tokens arrive. If you output metadata fields first, the user sees nothing for several seconds. Start with `<svg>` or `<div>` immediately so structure appears within the first 50 tokens.

### Rules

- No `<!-- comments -->` or `/* comments */` (waste tokens, break streaming)
- No font-size below 11px
- No emoji — use CSS shapes or SVG paths
- No gradients, drop shadows, blur, glow, or neon effects
- In SVG, no `<linearGradient>`, `<radialGradient>`, `<pattern>`, `<filter>`, or `filter="..."` attributes. Use flat fills, strokes, opacity, and repeated primitive shapes instead.
- No dark/colored backgrounds on outer containers (transparent only — host provides the bg)
- **Typography**: The default widget body font follows TouchAI's current message typography. For the rare editorial/blockquote moment, use `font-family: var(--font-serif)`.
- **Headings**: h1 = 22px, h2 = 18px, h3 = 16px — all `font-weight: 500`. Heading color is pre-set to `var(--color-text-primary)` — don't override it. Body text = 16px, weight 400, `line-height: 1.7`. **Two weights only: 400 regular, 500 bold.** Never use 600 or 700 — they look heavy against the host UI.
- **Sentence case** always. Never Title Case, never ALL CAPS. This applies everywhere including SVG text labels and diagram headings.
- **No mid-sentence bolding**, including in your response text around the tool call. Entity names, class names, function names go in `code style` not **bold**. Bold is for headings and labels only.
- The widget container is `display: block; width: 100%`. Your HTML fills it naturally — no wrapper div needed. Just start with your content directly. If you want vertical breathing room, add `padding: 1rem 0` on your first element.
- Never use `position: fixed` — TouchAI renders the widget in a sandbox iframe and sizes it from normal document flow. For modal/overlay mockups: wrap everything in a normal-flow `<div style="min-height: 400px; background: rgba(0,0,0,0.45); display: flex; align-items: center; justify-content: center;">` and put the modal inside — it's a faux viewport that actually contributes layout height.
- No DOCTYPE, `<html>`, `<head>`, or `<body>` — just content fragments.
- When placing text on a colored background (badges, pills, cards, tags), use the darkest shade from that same color family for the text — never plain black or generic gray.
- **Corners**: use `border-radius: var(--border-radius-md)` (or `-lg` for cards) in HTML. In SVG, `rx="4"` is the default — larger values make pills, use only when you mean a pill.
- **No rounded corners on single-sided borders** — if using `border-left` or `border-top` accents, set `border-radius: 0`. Rounded corners only work with full borders on all sides.
- **No titles or prose inside the tool output** — see Philosophy above.
- **Icon sizing**: When using emoji or inline SVG icons, explicitly set `font-size: 16px` for emoji or `width: 16px; height: 16px` for SVG icons. Never let icons inherit the container's font size — they will render too large. For larger decorative icons, use 24px max.
- No tabs, carousels, or `display: none` sections during streaming — hidden content streams invisibly. Show all content stacked vertically. (Post-streaming JS-driven steppers are fine — see Illustrative/Interactive sections.)
- No nested scrolling — auto-fit height.
- Scripts execute after streaming — load libraries via `<script src="https://cdnjs.cloudflare.com/ajax/libs/...">` (UMD globals), then use the global in a plain `<script>` that follows.
- **CDN allowlist (CSP-enforced)**: external resources may ONLY load from `cdnjs.cloudflare.com`, `esm.sh`, `cdn.jsdelivr.net`, `unpkg.com`. All other origins are blocked by the sandbox — the request silently fails.

### CSS Variables

**Backgrounds**: `--color-background-primary` (white), `-secondary` (surfaces), `-tertiary` (page bg), `-info`, `-danger`, `-success`, `-warning`
**Text**: `--color-text-primary` (black), `-secondary` (muted), `-tertiary` (hints), `-info`, `-danger`, `-success`, `-warning`
**Borders**: `--color-border-tertiary` (0.15α, default), `-secondary` (0.3α, hover), `-primary` (0.4α), semantic `-info/-danger/-success/-warning`
**Typography**: `--font-sans`, `--font-serif`, `--font-mono`
**Layout**: `--border-radius-md` (host control radius), `--border-radius-lg` (host card radius; preferred for most components), `--border-radius-xl` (host panel radius)
All auto-adapt to light/dark mode. For custom colors in HTML, use CSS variables.

**Dark mode is mandatory** — every color must work in both modes:

- In SVG: use the pre-built color classes (`c-blue`, `c-teal`, `c-amber`, etc.) for colored nodes — they handle light/dark mode automatically. Never write `<style>` blocks for colors.
- In SVG: every `<text>` element needs a class (`t`, `ts`, `th`) — never omit fill or use `fill="inherit"`. Inside a `c-{color}` parent, text classes auto-adjust to the ramp.
- In HTML: always use CSS variables (--color-text-primary, --color-text-secondary) for text. Never hardcode colors like color: #333 — invisible in dark mode.
- Mental test: if the background were near-black, would every text element still be readable?

### Actions and scripts

For buttons, SVG nodes, or cards that should ask TouchAI a follow-up, set `data-send-prompt="Ask the follow-up"` on the clickable element. The host dispatches it safely.

For link-like controls, set `data-open-link="https://example.com"` or use a normal `<a href="https://...">`.

Do not use inline event attributes. The sanitizer removes them. For internal filtering, sorting, toggling, calculations, sliders, and custom UI behavior, put a final `<script>` block after the static HTML and bind events with `addEventListener`.

```html
<button type="button" data-send-prompt="Compare one more scenario">Compare more</button>
<button id="recalc" type="button">Recalculate</button>
<output id="result">42</output>
<script>
    document.getElementById('recalc').addEventListener('click', () => {
        document.getElementById('result').textContent = String(21 * 2);
    });
</script>
```

### Links

`<a href="https://...">` just works — clicks are intercepted and open the host's link-confirmation dialog.

## When nothing fits

Pick the closest use case below and adapt. When nothing fits cleanly:

- Default to editorial layout if the content is explanatory
- Default to card layout if the content is a bounded object
- All core design system rules still apply
- Use `data-send-prompt` for any action that benefits from TouchAI thinking

<!--
Source assembly order for maintainers. The native installer concatenates these
reviewed files into the single installed appRoot/skills/.system/widget/SKILL.md:

1. SKILL.md
2. references/ui_components.md
3. references/color_palette.md
4. references/charts.md
5. references/svg_setup.md
6. references/diagram_overview.md
7. references/diagram_flowchart.md
8. references/diagram_structural.md
9. references/diagram_illustrative.md
10. references/art_and_illustration.md

Reference files are build sources only. Runtime activates and reads the single
assembled skill, so widget instructions stay in the same private request boundary
as every other skill body.
-->
