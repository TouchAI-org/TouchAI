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

1. Load the built-in `widget` skill with `builtin__activate_skill`, passing `name: "widget"` and the exact absolute `path` shown in the skill catalog. Its installed location is `appRoot/skills/.system/widget/SKILL.md`, where `appRoot` is the current application root; use the discovered path rather than guessing it. A user-created skill with the same name does not grant widget access.
2. Read this complete guide before creating the visual. If the built-in skill was already activated by the user selection for this request, use that loaded guide and credential.
3. Call `builtin__show_widget` with the current request credential as `skill_key` before `widget_code`. The credential is required for creation, updates, and removal. Reuse `widgetId` to update the same visual; for removal, pass `mode: "remove"` and its `widgetId` without `widget_code`.

**Request credential:** Set `skill_key` to `{{WIDGET_SKILL_KEY}}` exactly as supplied. Use it only in the tool argument, never in prose, widget HTML/scripts, metadata, or logs. It is valid for this request only; a later request must load the built-in skill again. Saved history, guessed strings, and boolean flags do not grant access.

Explain or clarify in normal assistant text whenever useful. Skill activation does not require the next assistant response to be a tool call.

## Runtime

TouchAI renders each widget in an opaque-origin sandbox iframe. Generated code cannot access the application DOM, Tauri bridge, storage, or session state. The widget inherits the approved host CSS variables through a controlled theme snapshot; it does not inherit the host document or arbitrary styles. Keep generated selectors local and do not style `html`, `body`, or `:root`.

During streaming, keyed DOM patching preserves nodes identified by a stable `data-widget-key` or `id`. Emit meaningful static content early. Only final classic scripts execute after streaming completes, in document order; external allowlisted scripts finish loading before the following initializer. Bind internal interactions with `addEventListener`, and use `data-send-prompt` or `data-open-link` for controlled host actions.

The host sizes the iframe to normal-flow content without a fixed height clamp. Keep artifacts compact, SVG viewBox height tight to content, and avoid nested scrolling or fixed positioning. Standard HTML and SVG are supported; custom widget component tags are not.

## Critical: Streaming-First Output Order

The widget streams token-by-token. Structure your tool call so visible content appears IMMEDIATELY:

```json
{
    "skill_key": "<credential from this skill>",
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
{"skill_key": "<credential from this skill>","widget_code":"<svg viewBox=\"0 0 400 200\"><rect...
```

Bad (delays visible content):

```json
{
  "skill_key": "<credential from this skill>",
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

## UI components

### Aesthetic

Flat, clean, white surfaces. Minimal 0.5px borders. Generous whitespace. No gradients and no shadows. Everything should feel native to TouchAI — like it belongs on the page, not embedded from somewhere else.

### Tokens

- Borders: always `0.5px solid var(--color-border-tertiary)` (or `-secondary` for emphasis)
- Corner radius: `var(--border-radius-md)` for most elements, `var(--border-radius-lg)` for cards
- Cards: white bg (`var(--color-background-primary)`), 0.5px border, radius-lg, padding 1rem 1.25rem
- Use standard HTML tags only. Prefer `div`, `section`, `span`, `button`, `input`, `textarea`, `select`, `label`, `svg`, `canvas`, and `table`.
- Buttons: pre-styled with transparent bg, 0.5px border-secondary, hover bg-secondary, active scale(0.98). If it uses `data-send-prompt`, append a ↗ arrow.
- **Round every displayed number.** JS float math leaks artifacts — `0.1 + 0.2` gives `0.30000000000000004`, `7 * 1.1` gives `7.700000000000001`. Any number that reaches the screen (slider readouts, stat card values, axis labels, data-point labels, tooltips, computed totals) must go through `Math.round()`, `.toFixed(n)`, or `Intl.NumberFormat`. Pick the precision that makes sense for the context — integers for counts, 1–2 decimals for percentages, `toLocaleString()` for currency. For range sliders, also set `step="1"` (or step="0.1" etc.) so the input itself emits round values.
- Spacing: use rem for vertical rhythm (1rem, 1.5rem, 2rem), px for component-internal gaps (8px, 12px, 16px)
- Focus rings: use `outline` or border-color changes, not `box-shadow`

### Standard HTML controls

Native controls receive the host widget base styles inside the sandbox. Use semantic HTML and inline styles for layout, spacing, and small visual states. Do not use custom component tags.

```html
<div
    style="display:grid; gap:12px; background:var(--color-background-primary); border:0.5px solid var(--color-border-tertiary); border-radius:var(--border-radius-lg); padding:1rem 1.25rem;"
>
    <div style="display:flex; align-items:center; justify-content:space-between; gap:12px;">
        <span
            style="background:var(--color-background-info); color:var(--color-text-info); font-size:12px; padding:4px 10px; border-radius:var(--border-radius-md);"
        >
            Scenario
        </span>
        <button type="button" data-send-prompt="Compare one more scenario">Compare more</button>
    </div>
    <label for="rate" style="font-size:13px; color:var(--color-text-secondary);">Rate</label>
    <input id="rate" type="number" value="5" />
</div>
```

### Metric cards

For summary numbers (revenue, count, percentage) — surface card with muted 13px label above, 24px/500 number below. `background: var(--color-background-secondary)`, no border, `border-radius: var(--border-radius-md)`, padding 1rem. Use in grids of 2-4 with `gap: 12px`. Distinct from raised cards (which have white bg + border).

### Layout

- Editorial (explanatory content): no card wrapper, prose flows naturally
- Card (bounded objects like a contact record, receipt): single raised card wraps the whole thing
- Don't put tables here — output them as markdown in your response text

**Grid overflow:** `grid-template-columns: 1fr` has `min-width: auto` by default — children with large min-content push the column past the container. Use `minmax(0, 1fr)` to clamp.

**Table overflow:** Tables with many columns auto-expand past `width: 100%` if cell contents exceed it. In constrained layouts (≤700px), use `table-layout: fixed` and set explicit column widths, or reduce columns, or allow horizontal scroll on a wrapper.

### Mockup presentation

Contained mockups — mobile screens, chat threads, single cards, modals, small UI components — should sit on a background surface (`var(--color-background-secondary)` container with `border-radius: var(--border-radius-lg)` and padding, or a device frame) so they don't float naked on the widget canvas. Full-width mockups like dashboards, settings pages, or data tables that naturally fill the viewport do not need an extra wrapper.

### 1. Interactive explainer — learn how something works

_"Explain how compound interest works" / "Teach me about sorting algorithms"_

Use `builtin__show_widget` with HTML in `widget_code` for the interactive controls — sliders, buttons, live state displays, charts. Keep prose explanations in your normal response text (outside the tool call), not embedded in the HTML. No card wrapper. Whitespace is the container.

```html
<div style="display: flex; align-items: center; gap: 12px; margin: 0 0 1.5rem;">
    <label style="font-size: 14px; color: var(--color-text-secondary);">Years</label>
    <input type="range" min="1" max="40" value="20" id="years" style="flex: 1;" />
    <span style="font-size: 14px; font-weight: 500; min-width: 24px;" id="years-out">20</span>
</div>

<div style="display: flex; align-items: baseline; gap: 8px; margin: 0 0 1.5rem;">
    <span style="font-size: 14px; color: var(--color-text-secondary);">£1,000 →</span>
    <span style="font-size: 24px; font-weight: 500;" id="result">£3,870</span>
</div>

<div style="margin: 2rem 0; position: relative; height: 240px;">
    <canvas id="chart"></canvas>
</div>
```

Use `data-send-prompt` to let users ask follow-ups: `<button type="button" data-send-prompt="What if I increase the rate to 10%?">Try 10%</button>`.

### 2. Compare options — decision making

_"Compare pricing and features of these products" / "Help me choose between React and Vue"_

Use `builtin__show_widget` with HTML in `widget_code`. Side-by-side card grid for options. Highlight differences with semantic colors. Interactive elements for filtering or weighting.

- Use `repeat(auto-fit, minmax(160px, 1fr))` for responsive columns
- Each option in a card. Use badges for key differentiators.
- Add follow-up buttons with `data-send-prompt="Tell me more about the Pro plan"`
- Don't put comparison tables inside this tool — output them as regular markdown tables in your response text instead. The tool is for the visual card grid only.
- When one option is recommended or "most popular", accent its card with `border: 2px solid var(--color-border-info)` only (2px is deliberate — the only exception to the 0.5px rule, used to accent featured items) — keep the same background and border as the other cards. Add a small badge (e.g. "Most popular") above or inside the card header using `background: var(--color-background-info); color: var(--color-text-info); font-size: 12px; padding: 4px 12px; border-radius: var(--border-radius-md)`.

### 3. Data record — bounded UI object

_"Show me a Salesforce contact card" / "Create a receipt for this order"_

Use `builtin__show_widget` with HTML in `widget_code`. Wrap the entire thing in a single raised card. All content is sans-serif since it's pure UI. Use an avatar/initials circle for people (see example below).

```html
<div
    style="background: var(--color-background-primary); border-radius: var(--border-radius-lg); border: 0.5px solid var(--color-border-tertiary); padding: 1rem 1.25rem;"
>
    <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 16px;">
        <div
            style="width: 44px; height: 44px; border-radius: 50%; background: var(--color-background-info); display: flex; align-items: center; justify-content: center; font-weight: 500; font-size: 14px; color: var(--color-text-info);"
        >
            MR
        </div>
        <div>
            <p style="font-weight: 500; font-size: 15px; margin: 0;">Maya Rodriguez</p>
            <p style="font-size: 13px; color: var(--color-text-secondary); margin: 0;">
                VP of Engineering
            </p>
        </div>
    </div>
    <div style="border-top: 0.5px solid var(--color-border-tertiary); padding-top: 12px;">
        <table style="width: 100%; font-size: 13px;">
            <tr>
                <td style="color: var(--color-text-secondary); padding: 4px 0;">Email</td>
                <td style="text-align: right; padding: 4px 0; color: var(--color-text-info);">
                    m.rodriguez@acme.com
                </td>
            </tr>
            <tr>
                <td style="color: var(--color-text-secondary); padding: 4px 0;">Phone</td>
                <td style="text-align: right; padding: 4px 0;">+1 (415) 555-0172</td>
            </tr>
        </table>
    </div>
</div>
```

## Color palette

9 color ramps, each with 7 stops from lightest to darkest. 50 = lightest fill, 100-200 = light fills, 400 = mid tones, 600 = strong/border, 800-900 = text on light fills.

| Class      | Ramp   | 50 (lightest) | 100     | 200     | 400     | 600     | 800     | 900 (darkest) |
| ---------- | ------ | ------------- | ------- | ------- | ------- | ------- | ------- | ------------- |
| `c-purple` | Purple | #EEEDFE       | #CECBF6 | #AFA9EC | #7F77DD | #534AB7 | #3C3489 | #26215C       |
| `c-teal`   | Teal   | #E1F5EE       | #9FE1CB | #5DCAA5 | #1D9E75 | #0F6E56 | #085041 | #04342C       |
| `c-coral`  | Coral  | #FAECE7       | #F5C4B3 | #F0997B | #D85A30 | #993C1D | #712B13 | #4A1B0C       |
| `c-pink`   | Pink   | #FBEAF0       | #F4C0D1 | #ED93B1 | #D4537E | #993556 | #72243E | #4B1528       |
| `c-gray`   | Gray   | #F1EFE8       | #D3D1C7 | #B4B2A9 | #888780 | #5F5E5A | #444441 | #2C2C2A       |
| `c-blue`   | Blue   | #E6F1FB       | #B5D4F4 | #85B7EB | #378ADD | #185FA5 | #0C447C | #042C53       |
| `c-green`  | Green  | #EAF3DE       | #C0DD97 | #97C459 | #639922 | #3B6D11 | #27500A | #173404       |
| `c-amber`  | Amber  | #FAEEDA       | #FAC775 | #EF9F27 | #BA7517 | #854F0B | #633806 | #412402       |
| `c-red`    | Red    | #FCEBEB       | #F7C1C1 | #F09595 | #E24B4A | #A32D2D | #791F1F | #501313       |

**How to assign colors**: Color should encode meaning, not sequence. Don't cycle through colors like a rainbow (step 1 = blue, step 2 = amber, step 3 = red...). Instead:

- Group nodes by **category** — all nodes of the same type share one color. E.g. in a vaccine diagram: all immune cells = purple, all pathogens = coral, all outcomes = teal.
- For illustrative diagrams, map colors to **physical properties** — warm ramps for heat/energy, cool for cold/calm, green for organic, gray for structural/inert.
- Use **gray for neutral/structural** nodes (start, end, generic steps).
- Use **2-3 colors per diagram**, not 6+. More colors = more visual noise. A diagram with gray + purple + teal is cleaner than one using every ramp.
- **Prefer purple, teal, coral, pink** for general diagram categories. Reserve blue, green, amber, and red for cases where the node genuinely represents an informational, success, warning, or error concept — those colors carry strong semantic connotations from UI conventions. (Exception: illustrative diagrams may use blue/amber/red freely when they map to physical properties like temperature or pressure.)

**Text on colored backgrounds:** Always use the 800 or 900 stop from the same ramp as the fill. Never use black, gray, or --color-text-primary on colored fills. **When a box has both a title and a subtitle, they must be two different stops** — title darker (800 in light mode, 100 in dark), subtitle lighter (600 in light, 200 in dark). Same stop for both reads flat; the weight difference alone isn't enough. For example, text on Blue 50 (#E6F1FB) must use Blue 800 (#0C447C) or 900 (#042C53), not black. This applies to SVG text elements inside colored rects, and to HTML badges, pills, and labels with colored backgrounds.

**Light/dark mode quick pick** — use only stops from the table, never off-table hex values:

- **Light mode**: 50 fill + 600 stroke + **800 title / 600 subtitle**
- **Dark mode**: 800 fill + 200 stroke + **100 title / 200 subtitle**
- Apply `c-{ramp}` to a `<g>` wrapping shape+text, or directly to a `<rect>`/`<circle>`/`<ellipse>`. Never to `<path>` — paths don't get ramp fill. For colored connector strokes use inline `stroke="#..."` (any mid-ramp hex works in both modes). Dark mode is automatic for ramp classes. Available: c-gray, c-blue, c-red, c-amber, c-green, c-teal, c-purple, c-coral, c-pink.

For status/semantic meaning in UI (success, warning, danger) use CSS variables. For categorical coloring in both diagrams and UI, use these ramps.

## Charts (Chart.js)

```html
<div style="position: relative; width: 100%; height: 300px;">
    <canvas id="myChart"></canvas>
</div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js"></script>
<script>
    const chartEl = document.getElementById('myChart');
    if (window.Chart && chartEl) {
        new Chart(chartEl, {
            type: 'bar',
            data: {
                labels: ['Q1', 'Q2', 'Q3', 'Q4'],
                datasets: [{ label: 'Revenue', data: [12, 19, 8, 15] }],
            },
            options: { responsive: true, maintainAspectRatio: false },
        });
    }
</script>
```

**Chart.js rules**:

- Canvas cannot resolve CSS variables. Use hardcoded hex or Chart.js defaults.
- Wrap `<canvas>` in `<div>` with explicit `height` and `position: relative`.
- **Canvas sizing**: set height ONLY on the wrapper div, never on the canvas element itself. Use position: relative on the wrapper and responsive: true, maintainAspectRatio: false in Chart.js options. Never set CSS height directly on canvas — this causes wrong dimensions, especially for horizontal bar charts.
- For horizontal bar charts: wrapper div height should be at least (number_of_bars \* 40) + 80 pixels.
- Load UMD build via `<script src="https://cdnjs.cloudflare.com/ajax/libs/...">` — sets `window.Chart` global. Follow with plain `<script>` (no `type="module"`).
- **Script load ordering**: TouchAI executes final script tags in document order after streaming completes, and waits for each external script before running the next inline initializer. Do not use event-handler attributes on script tags; put the CDN script immediately before a plain `<script>` that checks `window.Chart` and initializes the chart.
- Multiple charts: use unique IDs (`myChart1`, `myChart2`). Each gets its own canvas+div pair.
- For bubble and scatter charts: bubble radii extend past their center points, so points near axis boundaries get clipped. Pad the scale range — set `scales.y.min` and `scales.y.max` ~10% beyond your data range (same for x). Or use `layout: { padding: 20 }` as a blunt fallback.
- Chart.js auto-skips x-axis labels when they'd overlap. If you have ≤12 categories and need all labels visible (waterfall, monthly series), set `scales.x.ticks: { autoSkip: false, maxRotation: 45 }` — missing labels make bars unidentifiable.

**Number formatting**: negative values are `-$5M` not `$-5M` — sign before currency symbol. Use a formatter: `(v) => (v < 0 ? '-' : '') + '$' + Math.abs(v) + 'M'`.

**Legends** — always disable Chart.js default and build custom HTML. The default uses round dots and no values; custom HTML gives small squares, tight spacing, and percentages:

```js
plugins: {
    legend: {
        display: false;
    }
}
```

```html
<div
    style="display: flex; flex-wrap: wrap; gap: 16px; margin-bottom: 8px; font-size: 12px; color: var(--color-text-secondary);"
>
    <span style="display: flex; align-items: center; gap: 4px;">
        <span style="width: 10px; height: 10px; border-radius: 2px; background: #3266ad;"></span>
        Chrome 65%
    </span>
    <span style="display: flex; align-items: center; gap: 4px;">
        <span style="width: 10px; height: 10px; border-radius: 2px; background: #73726c;"></span>
        Safari 18%
    </span>
</div>
```

Include the value/percentage in each label when the data is categorical (pie, donut, single-series bar). Position the legend above the chart (`margin-bottom`) or below (`margin-top`) — not inside the canvas.

**Dashboard layout** — wrap summary numbers in metric cards (see UI fragment) above the chart. Chart canvas flows below without a card wrapper. Use `data-send-prompt="Break down Q4 by region"` on drill-down buttons or legend items that should ask TouchAI for a follow-up.

## SVG setup

**ViewBox safety checklist** — before finalizing any SVG, verify:

1. Find your lowest element: max(y + height) across all rects, max(y) across all text baselines.
2. Set viewBox height = that value + 40px buffer.
3. Find your rightmost element: max(x + width) across all rects. All content must stay within x=0 to x=680.
4. For text with text-anchor="end", the text extends LEFT from x. If x=118 and text is 200px wide, it starts at x=-82 — outside the viewBox. Increase x or use text-anchor="start".
5. Never use negative x or y coordinates. The viewBox starts at 0,0.
6. Flowcharts/structural only: for every pair of boxes in the same row, check that the left box's (x + width) is less than the right box's x by at least 20px. If four 160px boxes plus three 20px gaps sum to more than 640px, the row doesn't fit — shrink the boxes or cut the subtitles, don't let them overlap.

**SVG setup**: `<svg width="100%" viewBox="0 0 680 H">` — 680px wide, flexible height. Set H to fit content tightly — the last element's bottom edge + 40px padding. Don't leave excess empty space below the content. Safe area: x=40 to x=640, y=40 to y=(H-40). Background transparent. **Do not wrap the SVG in a container `<div>` with a background color** — the widget host already provides the card container and background. Output the raw `<svg>` element directly.

**The 680 in viewBox is load-bearing — do not change it.** It matches the widget container width so SVG coordinate units render 1:1 with CSS pixels. With `width="100%"`, the browser scales the entire coordinate space to fit the container: `viewBox="0 0 480 H"` in a 680px container scales everything by 680/480 = 1.42×, so your `class="th"` 14px text renders at ~20px. The font calibration table below and all "text fits in box" math assume 1:1. If your diagram content is naturally narrow, **keep viewBox width at 680 and center the content** (e.g. content spans x=180..500) — do not shrink the viewBox to hug the content. This applies equally to inline SVGs inside `builtin__show_widget` HTML steppers and widgets: same `viewBox="0 0 680 H"`, same 1:1 guarantee.

**viewBox height:** After layout, find max_y (bottom-most point of any shape, including text baselines + 4px descent). Set viewBox height = max_y + 20. Don't guess.

**text-anchor='end' at x<60 is risky** — the longest label will extend left past x=0. Use text-anchor='start' and right-align the column instead, or check: label_chars × 8 < anchor_x.

**One SVG per tool call** — each call must contain exactly one <svg> element. Never leave an abandoned or partial SVG in the output. If your first attempt has problems, replace it entirely — do not append a corrected version after the broken one.

**Style rules for all diagrams**:

- Every `<text>` element must carry one of the pre-built classes (`t`, `ts`, `th`). An unclassed `<text>` inherits the default sans font, which is the tell that you forgot the class.
- Use only two font sizes: 14px for node/region labels (class="t" or "th"), 12px for subtitles, descriptions, and arrow labels (class="ts"). No other sizes.
- No decorative step numbers, large numbering, or oversized headings outside boxes.
- No icons or illustrations inside boxes — text only. (Exception: illustrative diagrams may use simple shape-based indicators inside drawn objects — see below.)
- Sentence case on all labels.

**Font size calibration for diagram text labels** - Here's csv table to give you a better sense of TouchAI widget text rendering width:

```csv
text, chars length, font-weight, font-size, rendered width
Authentication Service, chars: 22, font-weight: 500, font-size: 14px, width: 167px
Background Job Processor, chars: 24, font-weight: 500, font-size: 14px, width: 201px
Detects and validates incoming tokens, chars: 37, font-weight: 400, font-size: 14px, width: 279px
forwards request to, chars: 19, font-weight: 400, font-size: 12px, width: 123px
データベースサーバー接続, chars: 12, font-weight: 400, font-size: 14px, width: 181px
```

Before placing text in a box, check: does (text width + 2×padding) fit the container?

**SVG `<text>` never auto-wraps.** Every line break needs an explicit `<tspan x="..." dy="1.2em">`. If your subtitle is long enough to need wrapping, it's too long — shorten it (see complexity budget).

**Example check**: You want to put "Glucose (C₆H₁₂O₆)" in a rounded rect. The text is 20 characters at 14px ≈ 180px wide. Add 2×24px padding = 228px minimum box width. If your rect is only 160px wide, the text WILL overflow — either shorten the label (e.g. just "Glucose") or widen the box. Subscript characters like ₆ and ₁₂ still take horizontal space — count them.

**Pre-built classes** (already loaded in SVG widget):

- `class="t"` = sans 14px primary, `class="ts"` = sans 12px secondary, `class="th"` = sans 14px medium (500)
- `class="box"` = neutral rect (bg-secondary fill, border stroke)
- `class="node"` = clickable group with hover effect (cursor pointer, slight dim on hover)
- `class="arr"` = arrow line (1.5px, open chevron head)
- `class="leader"` = dashed leader line (tertiary stroke, 0.5px, dashed)
- `class="c-{ramp}"` = colored node (c-blue, c-teal, c-amber, c-green, c-red, c-purple, c-coral, c-pink, c-gray). Apply to `<g>` or shape element (rect/circle/ellipse), NOT to paths. Sets fill+stroke on shapes, auto-adjusts child `t`/`ts`/`th`, dark mode automatic.

**c-{ramp} nesting:** These classes use direct-child selectors (`>`). Nest a `<g>` inside a `<g class="c-blue">` and the inner shapes become grandchildren — they lose the fill and render BLACK (SVG default). Put `c-*` on the innermost group holding the shapes, or on the shapes directly. If a node should ask TouchAI a follow-up question, put `data-send-prompt` on the `c-*` group itself, not a wrapper.

- Short aliases: `var(--p)`, `var(--s)`, `var(--t)`, `var(--bg2)`, `var(--b)`
- Arrow marker: always include this `<defs>` at the start of every SVG:
  `<defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></marker></defs>`
  Then use `marker-end="url(#arrow)"` on lines. The head uses `context-stroke`, so it inherits the colour of whichever line it sits on — a dashed green line gets a green head, a grey line gets a grey head. Never a colour mismatch. Do not add filters, patterns, gradients, or extra markers to `<defs>`. Illustrative diagrams may add a single `<clipPath>` when needed.

**Minimize standalone labels.** Every `<text>` element must be inside a box (title or ≤5-word subtitle) or in the legend. Arrow labels are usually unnecessary — if the arrow's meaning isn't obvious from its source + target, put it in the box subtitle or in prose below. Labels floating in space collide with things and are ambiguous.

**Stroke width:** Use 0.5px strokes for diagram borders and edges — not 1px or 2px. Thin strokes feel more refined.

**Connector paths need `fill="none"`.** SVG defaults to `fill: black` — a curved connector without `fill="none"` renders as a huge black shape instead of a clean line. Every `<path>` or `<polyline>` used as a connector/arrow MUST have `fill="none"`. Only set fill on shapes meant to be filled (rects, circles, polygons).

**Rect rounding:** `rx="4"` for subtle corners. `rx="8"` max for emphasized rounding. `rx` ≥ half the height = pill shape — deliberate only.

**Schematic containers use dashed rects with a label.** Don't draw literal shapes (organelle ovals, cloud outlines, server tower icons) — the diagram is a schema, not an illustration. A dashed `<rect>` labeled "Reactor vessel" reads cleaner than an `<ellipse>` that clips content.

**Lines stop at component edges.** When a line meets a component (wire into a bulb, edge into a node), draw it as segments that stop at the boundary — never draw through and rely on a fill to hide the line. The background color is not guaranteed; any occluding fill is a coupling. Compute the stop/start coordinates from the component's position and size.

**Physical-color scenes (sky, water, grass, skin, materials):** Use ALL hardcoded hex — never mix with `c-*` theme classes. The scene should not invert in dark mode. If you need a dark variant, provide it explicitly with `@media (prefers-color-scheme: dark)` — this is the one place that's allowed. Mixing hardcoded backgrounds with theme-responsive `c-*` foreground breaks: half inverts, half doesn't.

**No rotated text**. `<defs>` may contain the arrow marker and, when needed, a `<clipPath>`. Nothing else: no gradients, filters, patterns, or extra markers.

## Diagram types

_"Explain how compound interest works" / "How does a process scheduler work"_

**Two rules that cause most diagram failures — check these before writing each arrow and each box:**

1. **Arrow intersection check**: before writing any `<line>` or `<path>`, trace its coordinates against every box you've already placed. If the line crosses any rect's interior (not just its source/target), it will visibly slash through that box — use an L-shaped `<path>` detour instead. This applies to arrows crossing labels too.
2. **Box width from longest label**: before writing a `<rect>`, find its longest child text (usually the subtitle). `rect_width = max(title_chars × 8, subtitle_chars × 7) + 24`. A 100px-wide box holds at most a 10-char subtitle. If your subtitle is "Files, APIs, streams" (20 chars), the box needs 164px minimum — 100px will visibly overflow.

**Tier packing:** Compute total width BEFORE placing. Example — 4 pub/sub consumer boxes:

- WRONG: x=40,160,260,360 w=160 → 40-60px overlaps (4×160=640 > 480 available)
- RIGHT: x=50,200,350,500 w=130 gap=20 → fits (4×130 + 3×20 = 580 ≤ 590 safe width; right edge at 630 ≤ 640)
  Work bottom-up for trees: size leaf tier first, parent width ≥ sum of children.

**Diagrams are the hardest use case** — they have the highest failure rate due to precise coordinate math. Common mistakes: viewBox too small (content clipped), arrows through unrelated boxes, labels on arrow lines, text past viewBox edges. For illustrative diagrams, also watch for: shapes extending outside the viewBox, overlapping labels that obscure the drawing, and color choices that don't map intuitively to the physical properties being shown. Double-check coordinates before finalizing.

Use `builtin__show_widget` with raw SVG in `widget_code` for diagrams. TouchAI renders the SVG inside the inline widget sandbox; do not add an outer card wrapper.

**Pick the right diagram type.** The decision is about _intent_, not subject matter. Ask: is the user trying to _document_ this, or _understand_ it?

**Reference diagrams** — the user wants a map they can point at. Precision matters more than feeling. Boxes, labels, arrows, containment. These are the diagrams you'd find in documentation.

- **Flowchart** — steps in sequence, decisions branching, data transforming. Good for: approval workflows, request lifecycles, build pipelines, "what happens when I click submit". Trigger phrases: _"walk me through the process"_, _"what are the steps"_, _"what's the flow"_.
- **Structural diagram** — things inside other things. Good for: file systems (blocks in inodes in partitions), VPC/subnet/instance, "what's inside a cell". Trigger phrases: _"what's the architecture"_, _"how is this organised"_, _"where does X live"_.

**Intuition diagrams** — the user wants to _feel_ how something works. The goal isn't a correct map, it's the right mental model. These should look nothing like a flowchart. The subject doesn't need a physical form — it needs a _visual metaphor_.

- **Illustrative diagram** — draw the mechanism. Physical things get cross-sections (water heaters, engines, lungs). Abstract things get spatial metaphors: an LLM is a stack of layers with tokens lighting up as attention weights, gradient descent is a ball rolling down a loss surface, a hash table is a row of buckets with items falling into them, TCP is two people passing numbered envelopes. Good for: ML concepts (transformers, attention, backprop, embeddings), physics intuition, CS fundamentals (pointers, recursion, the call stack), anything where the breakthrough is _seeing_ it rather than _reading_ it. Trigger phrases: _"how does X actually work"_, _"explain X"_, _"I don't get X"_, _"give me an intuition for X"_.

**Route on the verb, not the noun.** Same subject, different diagram depending on what was asked:

| User says                                                  | Type             | What to draw                                                                                                   |
| ---------------------------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------- |
| "how do LLMs work"                                         | **Illustrative** | Token row, stacked layer slabs, high-opacity warm attention threads between tokens. Go interactive if you can. |
| "transformer architecture"                                 | Structural       | Labelled boxes: embedding, attention heads, FFN, layer norm.                                                   |
| "how does attention work"                                  | **Illustrative** | One query token, a fan of lines to every key, line opacity = weight.                                           |
| "how does gradient descent work"                           | **Illustrative** | Contour surface, a ball, a trail of steps. Slider for learning rate.                                           |
| "what are the training steps"                              | Flowchart        | Forward → loss → backward → update. Boxes and arrows.                                                          |
| "how does TCP work"                                        | **Illustrative** | Two endpoints, numbered packets in flight, an ACK returning.                                                   |
| "TCP handshake sequence"                                   | Flowchart        | SYN → SYN-ACK → ACK. Three boxes.                                                                              |
| "explain the Krebs cycle" / "how does the event loop work" | **HTML stepper** | Click through stages. Never a ring.                                                                            |
| "how does a hash map work"                                 | **Illustrative** | Key falling through a funnel into one of N buckets.                                                            |
| "draw the database schema" / "show me the ERD"             | **mermaid.js**   | `erDiagram` syntax. Not SVG.                                                                                   |

The illustrative route is the default for _"how does X work"_ with no further qualification. It is the more ambitious choice — don't retreat into a flowchart because it feels safer.

Don't mix families in one diagram. If you need both, draw the intuition version first (build the mental model), then the reference version (fill in the precise labels) as a second tool call with prose between.

**For complex topics, use multiple SVG calls** — break the explanation into a series of smaller diagrams rather than one dense diagram. Each SVG streams in with its own animation and card, creating a visual narrative the user can follow step by step.

**Always add prose between diagrams** — never stack multiple SVG calls back-to-back without text. Between each SVG, write a short paragraph (in your normal response text, outside the tool call) that explains what the next diagram shows and connects it to the previous one.

**Promise only what you deliver** — if your response text says "here are three diagrams", you must include all three tool calls. Never promise a follow-up diagram and omit it. If you can only fit one diagram, adjust your text to match. One complete diagram is better than three promised and one delivered.

#### Flowchart

For sequential processes, cause-and-effect, decision trees.

**Planning**: Size boxes to fit their text generously. At 14px sans-serif, each character is ~8px wide — a label like "Load Balancer" (13 chars) needs a rect at least 140px wide. When in doubt, make boxes wider and leave more space between them. Cramped diagrams are the most common failure mode.

**Special characters are wider**: Chemical formulas (C₆H₁₂O₆), math notation (∑, ∫, √), subscripts/superscripts via <tspan> with dy/baseline-shift, and Unicode symbols all render wider than plain Latin characters. For labels containing formulas or special notation, add 30-50% extra width to your estimate. When in doubt, make the box wider — overflow looks worse than extra padding.

**Spacing**: 60px minimum between boxes, 24px padding inside boxes, 12px between text and edges. Leave 10px gap between arrowheads and box edges. Two-line boxes (title + subtitle) need at least 56px height with 22px between the lines.

**Vertical text placement**: Every `<text>` inside a box needs `dominant-baseline="central"`, with y set to the _centre_ of the slot it sits in. Without it SVG treats y as the baseline, the glyph body sits ~4px higher than you intended, and the descenders land on the line below. Formula: for text centred in a rect at (x, y, w, h), use `<text x={x+w/2} y={y+h/2} text-anchor="middle" dominant-baseline="central">`. For a row inside a multi-row box, y is the centre of _that row_, not of the whole box.

**Layout**: Prefer single-direction flows (all top-down or all left-right). Keep diagrams simple — max 4-5 nodes per diagram. The widget is narrow (~680px) so complex layouts break.

**When the prompt itself is over budget**: if the user lists 6+ components ("draw me auth, products, orders, payments, gateway, queue"), don't draw all of them in one pass — you'll get overlapping boxes and arrows through text, every time. Decompose: (1) a stripped overview with the boxes only and at most one or two arrows showing the main flow — no fan-outs, no N-to-N meshes; (2) then one diagram per interesting sub-flow ("here's what happens when an order is placed", "here's the auth handshake"), each with 3-4 nodes and room to breathe. Count the nouns before you draw. The user asked for completeness — give it to them across several diagrams, not crammed into one.

**Cycles don't get drawn as rings.** If the last stage feeds back into the first (Krebs cycle, event loop, GC mark-and-sweep, TCP retransmit), your instinct is to place the stages around a circle. Don't. Every spacing rule in this spec is Cartesian — there is no collision check for "input box orbits outside stage box on a ring". You will get satellite boxes overlapping the stages they feed, labels sitting on the dashed circle, and tangential arrows that point nowhere. The ring is decoration; the loop is conveyed by the return arrow.

Build a stepper with `builtin__show_widget` using HTML in `widget_code`. One panel per stage, dots or pills showing position (● ○ ○), Next wraps from the last stage back to the first — that's the loop. Each panel owns its inputs and products: an event loop's pending callbacks live _inside_ the Poll panel, not floating next to a box on a ring. Nothing collides because nothing shares the canvas. Only fall back to a linear SVG (stages in a row, curved `<path>` return arrow) when there's one input and one output total and no per-stage detail to show.

**Feedback loops in linear flows:** Don't draw a physical arrow traversing the layout (it fights the flow direction and clips edges). Instead:

- Small `↻` glyph + text near the cycle point: `<text>↻ returns to start</text>`
- Or restructure the whole diagram as a circle if the cycle IS the point

**Arrows:** A line from A to B must not cross any other box or label. If the direct path crosses something, route around with an L-bend: `<path d="M x1 y1 L x1 ymid L x2 ymid L x2 y2"/>`. Place arrow labels in clear space, not on the midpoint.

Keep all nodes the same height when they have the same content type (e.g. all single-line boxes = 44px, all two-line boxes = 56px).

**Flowchart components** — use these patterns consistently:

_Single-line node_ (44px tall): title only. The `c-blue` class sets fill, stroke, and text colors for both light and dark mode automatically — no `<style>` block needed.

```svg
<g class="node c-blue" data-send-prompt="Tell me more about T-cells">
  <rect x="100" y="20" width="180" height="44" rx="8" stroke-width="0.5"/>
  <text class="th" x="190" y="42" text-anchor="middle" dominant-baseline="central">T-cells</text>
</g>
```

_Two-line node_ (56px tall): bold title + muted subtitle.

```svg
<g class="node c-blue" data-send-prompt="Tell me more about dendritic cells">
  <rect x="100" y="20" width="200" height="56" rx="8" stroke-width="0.5"/>
  <text class="th" x="200" y="38" text-anchor="middle" dominant-baseline="central">Dendritic cells</text>
  <text class="ts" x="200" y="56" text-anchor="middle" dominant-baseline="central">Detect foreign antigens</text>
</g>
```

_Connector_ (no label — meaning is clear from source + target):

```svg
<line x1="200" y1="76" x2="200" y2="120" class="arr" marker-end="url(#arrow)"/>
```

_Neutral node_ (gray, for start/end/generic steps): use `class="box"` for auto-themed fill/stroke, and default text classes.

Make all nodes clickable by default when they should ask TouchAI a follow-up question — use `<g class="node" data-send-prompt="...">`. The hover effect is built in.

#### Structural diagram

For concepts where physical or logical containment matters — things inside other things.

**When to use**: The explanation depends on _where_ processes happen. Examples: how a cell works (organelles inside a cell), how a file system works (blocks inside inodes inside partitions), how a building's HVAC works (ducts inside floors inside a building), how a CPU cache hierarchy works (L1 inside core, L2 shared).

**Core idea**: Large rounded rects are containers. Smaller rects inside them are regions or sub-structures. Text labels describe what happens in each region. Arrows show flow between regions or from external inputs/outputs.

**Container rules**:

- Outermost container: large rounded rect, rx=20-24, lightest fill (50 stop), 0.5px stroke (600 stop). Label at top-left inside, 14px bold.
- Inner regions: medium rounded rects, rx=8-12, next shade fill (100-200 stop). Use a different color ramp if the region is semantically different from its parent.
- 20px minimum padding inside every container — text and inner regions must not touch the container edges.
- Max 2-3 nesting levels. Deeper nesting gets unreadable at 680px width.

**Layout**:

- Place inner regions side by side within the container, with 16px+ gap between them.
- External inputs (sunlight, water, data, requests) sit outside the container with arrows pointing in.
- External outputs sit outside with arrows pointing out.
- Keep external labels short — one word or a short phrase. Details go in the prose between diagrams.

**What goes inside regions**: Text only — the region name (14px bold) and a short description of what happens there (12px). Don't put flowchart-style boxes inside regions. Don't draw illustrations or icons inside.

**Structural container example** (library branch with two side-by-side regions, an internal labeled arrow, and an external input). ViewBox 700x320, horizontal layout, color classes handle both light and dark mode — no `<style>` block:

```svg
<defs>
  <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
    <path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  </marker>
</defs>
<!-- Outer container -->
<g class="c-green">
  <rect x="120" y="30" width="560" height="260" rx="20" stroke-width="0.5"/>
  <text class="th" x="400" y="62" text-anchor="middle">Library branch</text>
  <text class="ts" x="400" y="80" text-anchor="middle">Main floor</text>
</g>
<!-- Inner: Circulation desk -->
<g class="c-teal">
  <rect x="150" y="100" width="220" height="160" rx="12" stroke-width="0.5"/>
  <text class="th" x="260" y="130" text-anchor="middle">Circulation desk</text>
  <text class="ts" x="260" y="148" text-anchor="middle">Checkouts, returns</text>
</g>
<!-- Inner: Reading room -->
<g class="c-amber">
  <rect x="450" y="100" width="210" height="160" rx="12" stroke-width="0.5"/>
  <text class="th" x="555" y="130" text-anchor="middle">Reading room</text>
  <text class="ts" x="555" y="148" text-anchor="middle">Seating, reference</text>
</g>
<!-- Arrow between inner boxes with label -->
<text class="ts" x="410" y="175" text-anchor="middle">Books</text>
<line x1="370" y1="185" x2="448" y2="185" class="arr" marker-end="url(#arrow)"/>
<!-- External input: New acq. — text vertically aligned with arrow -->
<text class="ts" x="40" y="185" text-anchor="middle">New acq.</text>
<line x1="75" y1="185" x2="118" y2="185" class="arr" marker-end="url(#arrow)"/>
```

**Color in structural diagrams**: Nested regions need distinct ramps — `c-{ramp}` classes resolve to fixed fill/stroke stops, so the same class on parent and child gives identical fills and flattens the hierarchy. Pick a _related_ ramp for inner structures (e.g. Green for the library envelope, Teal for the circulation desk inside it) and a _contrasting_ ramp for a region that does something functionally different (e.g. Amber for the reading room). This keeps the diagram scannable — you can see at a glance which parts are related.

**Database schemas / ERDs — use mermaid.js, not SVG.** A schema table is a header plus N field rows plus typed columns plus crow's-foot connectors. That is a text-layout problem and hand-placing it in SVG fails the same way every time. mermaid.js `erDiagram` does layout, cardinality, and connector routing for free. ERDs only; everything else stays in SVG.

```
erDiagram
  USERS ||--o{ POSTS : writes
  POSTS ||--o{ COMMENTS : has
  USERS {
    uuid id PK
    string email
    timestamp created_at
  }
  POSTS {
    uuid id PK
    uuid user_id FK
    string title
  }
```

Use `builtin__show_widget` with HTML in `widget_code` for ERDs. Load Mermaid with its UMD/global script, then initialize it from `window.mermaid` in a plain classic `<script>` that follows. The widget base CSS in the sandbox re-styles mermaid's output to match the design system — keep the init block exactly as shown (fontFamily + fontSize are used for layout measurement; deviate and text clips). After rendering, replace sharp-cornered entity `<path>` elements with rounded `<rect rx="8">` to match the design system, and strip borders from attribute rows (only the outer container and header row keep visible borders — alternating fill colors separate the rows):

```html
<div id="erd" aria-label="Entity relationship diagram">
    <span data-loading style="font-size:13px;color:var(--color-text-secondary)">
        Rendering entity diagram...
    </span>
    <div id="erd-output"></div>
    <style>
        #erd svg.erDiagram .divider path {
            stroke-opacity: 0.5;
        }
        #erd svg.erDiagram .row-rect-odd path,
        #erd svg.erDiagram .row-rect-odd rect,
        #erd svg.erDiagram .row-rect-even path,
        #erd svg.erDiagram .row-rect-even rect {
            stroke: none !important;
        }
    </style>
</div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/mermaid/11.12.0/mermaid.min.js"></script>
<script>
    const mermaid = window.mermaid;
    if (!mermaid) {
        document.querySelector('#erd [data-loading]')?.remove();
        throw new Error('Mermaid failed to load');
    }

    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    const fontsReady = document.fonts?.ready ?? Promise.resolve();
    fontsReady
        .then(() => {
            mermaid.initialize({
                startOnLoad: false,
                theme: 'base',
                fontFamily: '"Anthropic Sans", sans-serif',
                themeVariables: {
                    darkMode: dark,
                    fontSize: '13px',
                    fontFamily: '"Anthropic Sans", sans-serif',
                    lineColor: dark ? '#9c9a92' : '#73726c',
                    textColor: dark ? '#c2c0b6' : '#3d3d3a',
                },
            });
            return mermaid.render(
                'erd-svg',
                `erDiagram
  USERS ||--o{ POSTS : writes
  POSTS ||--o{ COMMENTS : has`
            );
        })
        .then(({ svg }) => {
            document.getElementById('erd-output').innerHTML = svg;
            document.querySelector('#erd [data-loading]')?.remove();

            // Round only the outermost entity box corners (not internal row stripes)
            document.querySelectorAll('#erd svg.erDiagram .node').forEach((node) => {
                const firstPath = node.querySelector('path[d]');
                if (!firstPath) return;
                const d = firstPath.getAttribute('d');
                const nums = d.match(/-?[\d.]+/g)?.map(Number);
                if (!nums || nums.length < 8) return;
                const xs = [nums[0], nums[2], nums[4], nums[6]];
                const ys = [nums[1], nums[3], nums[5], nums[7]];
                const x = Math.min(...xs),
                    y = Math.min(...ys);
                const w = Math.max(...xs) - x,
                    h = Math.max(...ys) - y;
                const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                rect.setAttribute('x', x);
                rect.setAttribute('y', y);
                rect.setAttribute('width', w);
                rect.setAttribute('height', h);
                rect.setAttribute('rx', '8');
                for (const a of ['fill', 'stroke', 'stroke-width', 'class', 'style']) {
                    if (firstPath.hasAttribute(a)) rect.setAttribute(a, firstPath.getAttribute(a));
                }
                firstPath.replaceWith(rect);
            });

            // Strip borders from attribute rows (mermaid v11: .row-rect-odd / .row-rect-even)
            document
                .querySelectorAll(
                    '#erd svg.erDiagram .row-rect-odd path, #erd svg.erDiagram .row-rect-even path'
                )
                .forEach((p) => {
                    p.setAttribute('stroke', 'none');
                });
        });
</script>
```

Works identically for `classDiagram` — swap the diagram source; init stays the same.

#### Illustrative diagram

For building _intuition_. The subject might be physical (an engine, a lung) or completely abstract (attention, recursion, gradient descent) — what matters is that a spatial drawing conveys the mechanism better than labelled boxes would. These are the diagrams that make someone go "oh, _that's_ what it's doing."

**Two flavours, same rules:**

- **Physical subjects** get drawn as simplified versions of themselves. Cross-sections, cutaways, schematics. A water heater is a tank with a burner underneath. A lung is a branching tree in a cavity. You're drawing _the thing_, stylised.
- **Abstract subjects** get drawn as _spatial metaphors_. You're inventing a shape for something that doesn't have one — but the shape should make the mechanism obvious. A transformer is a stack of horizontal slabs with a bright thread of attention connecting tokens across layers. A hash function is a funnel scattering items into a row of buckets. The call stack is literally a stack of frames growing and shrinking. Embeddings are dots clustering in space. The metaphor _is_ the explanation.

This is the most ambitious diagram type. Lean into it. Use colour, opacity, and line width for intensity (a high attention weight is amber and opaque, a low one stays gray and faint). Use repetition for scale (many small circles = many parameters).

**Prefer interactive over static.** A static cross-section is a good answer; a cross-section you can _operate_ is a great one. The decision rule: if the real-world system has a control, give the diagram that control. A water heater has a thermostat — so give the user a slider that shifts the hot/cold boundary, a toggle that fires the burner and animates convection currents. An LLM has input tokens — let the user click one and watch the attention weights re-fan. A cache has a hit rate — let them drag it and watch latency change. Reach for `builtin__show_widget` with HTML and inline SVG first; only fall back to static raw SVG when there's genuinely nothing to twiddle.

**When NOT to use**: The user is asking for a _reference_, not an _intuition_. "What are the components of a transformer" wants labelled boxes — that's a structural diagram. "Walk me through our CI pipeline" wants sequential steps — that's a flowchart. Also skip this when the metaphor would be arbitrary rather than revealing: drawing "the cloud" as a cloud shape or "microservices" as little houses doesn't teach anything about how they work. If the drawing doesn't make the _mechanism_ clearer, don't draw it.

**Fidelity ceiling**: These are schematics, not illustrations. Every shape should read at a glance. If a `<path>` needs more than ~6 segments to draw, simplify it. A tank is a rounded rect, not a Bézier portrait of a tank. A flame is three triangles, not a fire. Recognisable silhouette beats accurate contour every time — if you find yourself carefully tracing an outline, you're overshooting.

**Core principle**: Draw the mechanism, not a diagram _about_ the mechanism. Spatial arrangement carries the meaning; labels annotate. A good illustrative diagram works with the labels removed.

**What changes from flowchart/structural rules**:

- **Shapes are freeform.** Use `<path>`, `<ellipse>`, `<circle>`, `<polygon>`, and curved lines to represent real forms. A water tank is a tall rect with rounded bottom. A heart valve is a pair of curved paths. A circuit trace is a thin polyline. You are not limited to rounded rects.
- **Layout follows the subject's geometry**, not a grid. If the thing is tall and narrow (a water heater, a thermometer), the diagram is tall and narrow. If it's wide and flat (a PCB, a geological cross-section), the diagram is wide. Let the subject dictate proportions within the 680px viewBox width.
- **Color encodes intensity**, not category. For physical subjects: warm ramps (amber, coral, red) = heat/energy/pressure, cool ramps (blue, teal) = cold/calm, gray = inert structure. For abstract subjects: warm = active/high-weight/attended-to, cool or gray = dormant/low-weight/ignored. A user should be able to glance at the diagram and see _where the action is_ without reading a single label.
- **Layering and overlap are encouraged — for shapes.** Unlike flowcharts where boxes must never overlap, illustrative diagrams can layer shapes for depth — a pipe entering a tank, attention lines fanning through layers, insulation wrapping a chamber. Use z-ordering (later in source = on top) deliberately.
- **Text is the exception — never let a stroke cross it.** The overlap permission is for shapes only. Every label needs 8px of clear air between its baseline/cap-height and the nearest stroke. Don't solve this with a background rect — solve it by _placing the text somewhere else_. Labels go in the quiet regions: above the drawing, below it, in the margin with a leader line, or in the gap between two fans of lines. If there is no quiet region, the drawing is too dense — remove something or split into two diagrams.
- **Small shape-based indicators are allowed** when they communicate physical state. Triangles for flames. Circles for bubbles or particles. Wavy lines for steam or heat radiation. Parallel lines for vibration. These aren't decoration — they tell the user what's happening physically. Keep them simple: basic SVG primitives, not detailed illustrations.
- **No gradients or SVG filters.** Show continuous physical properties with stacked flat-fill regions, opacity steps, line density, or small repeated primitives. If two or three flat bands communicate the same thing, use those bands instead of a continuous fade.
- **Animation is permitted for interactive HTML versions.** Use CSS `@keyframes` animating only `transform` and `opacity`. Keep loops under ~2s, and wrap every animation in `@media (prefers-reduced-motion: no-preference)` so it's opt-out by default. Animations should show how the system _behaves_ — convection current, rotation, flow — not just move for the sake of moving. No physics engines or heavy libraries.

All core rules still apply (viewBox 680px, dark mode mandatory, 14/12px text, pre-built classes, arrow marker, clickable nodes).

**Label placement**:

- Place labels _outside_ the drawn object when possible, with a thin leader line (0.5px dashed, `var(--t)` stroke) pointing to the relevant part. This keeps the illustration uncluttered.
- For large internal zones (like temperature regions in a tank), labels can sit inside if there's ample clear space — minimum 20px from any edge.
- External labels sit in the margin area or above/below the object. **Pick one side for labels and put them all there** — at 680px wide you don't have room for a drawing _and_ label columns on both sides. Reserve at least 140px of horizontal margin on the label side. Labels on the left are the ones that clip: `text-anchor="end"` extends leftward from x, and with multi-line callouts it's very easy to blow past x=0 without noticing. Default to right-side labels with `text-anchor="start"` unless the subject's geometry forces otherwise. Use `class="ts"` (12px) for callouts, `class="th"` (14px medium) for major component names.

**Composition approach**:

1. Start with the main object's silhouette — the largest shape, centered in the viewBox.
2. Add internal structure: chambers, pipes, membranes, mechanical parts.
3. Add external connections: pipes entering/exiting, arrows showing flow direction, labels for inputs and outputs.
4. Add state indicators last: color fills showing temperature/pressure/concentration, small animated elements showing movement or energy.
5. Leave generous whitespace around the object for labels — don't crowd annotations against the viewBox edges.

**Static vs interactive**: Static cutaways and cross-sections work best as raw SVG in `widget_code`. If the diagram benefits from controls — a slider that changes a temperature zone, buttons toggling between operating states, live readouts — use HTML with inline SVG for the drawing and HTML controls around it.

**Illustrative diagram example** — interactive water heater cross-section with flat physical-state colors, animated convection currents, and controls. Uses `builtin__show_widget` with HTML and inline SVG: a thermostat slider shifts the hot/cold flat bands, a heating toggle animates flames on/off and transitions convection to paused. viewBox is 680x560; tank occupies x=180..440, leaving 140px+ of right margin for labels. Smooth convection paths use `stroke-dasharray:5 5` at ~1.6s for a gentle flow feel. Flame shapes use solid warm fills and clean opacity transitions. Labels sit along the right margin with leader lines.

```html
<section style="display:grid;gap:12px">
    <svg width="100%" viewBox="0 0 680 560">
        <defs>
            <marker
                id="arrow"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
            >
                <path
                    d="M2 1L8 5L2 9"
                    fill="none"
                    stroke="context-stroke"
                    stroke-width="1.5"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                />
            </marker>
            <clipPath id="tc"><rect x="180" y="55" width="260" height="390" rx="14" /></clipPath>
        </defs>
        <!-- Tank fill: flat temperature bands -->
        <g clip-path="url(#tc)">
            <rect data-hot-band x="180" y="55" width="260" height="140" fill="#FAEEDA" />
            <rect data-cool-band x="180" y="195" width="260" height="250" fill="#E6F1FB" />
            <rect x="180" y="325" width="260" height="120" fill="#B5D4F4" opacity=".65" />
        </g>
        <!-- Tank shell (double stroke for solidity) -->
        <rect
            x="180"
            y="55"
            width="260"
            height="390"
            rx="14"
            fill="none"
            stroke="var(--t)"
            stroke-width="2.5"
            opacity=".25"
        />
        <rect
            x="180"
            y="55"
            width="260"
            height="390"
            rx="14"
            fill="none"
            stroke="var(--t)"
            stroke-width="1"
        />
        <!-- Hot pipe out (top right) -->
        <rect x="370" y="14" width="16" height="50" rx="4" fill="#FAEEDA" />
        <path
            d="M378 14V55"
            stroke="var(--t)"
            stroke-width="3"
            stroke-linecap="round"
            fill="none"
        />
        <!-- Cold pipe in + dip tube (top left) -->
        <rect x="234" y="14" width="16" height="50" rx="4" fill="#E6F1FB" />
        <path
            d="M242 14V55"
            stroke="var(--t)"
            stroke-width="3"
            stroke-linecap="round"
            fill="none"
        />
        <path
            d="M242 55V395"
            stroke="var(--t)"
            stroke-width="2.5"
            stroke-linecap="round"
            fill="none"
            opacity=".5"
        />
        <!-- Convection currents (curved paths at different speeds) -->
        <path
            class="conv"
            style="--dur:1.6s"
            fill="none"
            stroke="#D05538"
            stroke-width="1"
            opacity=".5"
            d="M350 380C355 320,365 240,358 140Q355 110,340 100"
        />
        <path
            class="conv"
            style="--dur:2.1s"
            fill="none"
            stroke="#C04828"
            stroke-width=".8"
            opacity=".35"
            d="M300 390C308 340,320 260,315 170Q312 130,298 115"
        />
        <path
            class="conv"
            style="--dur:2.6s"
            fill="none"
            stroke="#B05535"
            stroke-width=".7"
            opacity=".3"
            d="M380 370C382 310,388 230,382 150Q378 120,365 110"
        />
        <!-- Burner bar -->
        <rect x="188" y="454" width="244" height="5" rx="2" fill="var(--t)" opacity=".6" />
        <rect x="220" y="462" width="180" height="6" rx="3" fill="var(--t)" opacity=".3" />
        <!-- Flames (solid flat shapes) -->
        <g id="flames">
            <path d="M240,454Q248,430 252,438Q256,424 260,454Z" fill="#EF9F27" />
            <path d="M278,454Q285,426 290,434Q295,418 300,454Z" fill="#D85A30" />
            <path d="M320,454Q328,428 333,436Q338,420 342,454Z" fill="#EF9F27" />
            <path d="M360,454Q367,430 371,438Q375,422 380,454Z" fill="#D85A30" />
            <path d="M398,454Q404,434 408,440Q412,428 416,454Z" fill="#EF9F27" />
        </g>
        <!-- Labels (right margin) -->
        <g class="node" data-send-prompt="How does hot water exit the tank?">
            <line class="leader" x1="386" y1="34" x2="468" y2="70" />
            <circle cx="386" cy="34" r="2" fill="var(--t)" />
            <text class="ts" x="474" y="74">Hot water outlet</text>
        </g>
        <g class="node" data-send-prompt="How does the cold water inlet work?">
            <line class="leader" x1="250" y1="34" x2="468" y2="140" />
            <circle cx="250" cy="34" r="2" fill="var(--t)" />
            <text class="ts" x="474" y="144">Cold water inlet</text>
        </g>
        <g class="node" data-send-prompt="What does the dip tube do?">
            <line class="leader" x1="250" y1="260" x2="468" y2="220" />
            <circle cx="250" cy="260" r="2" fill="var(--t)" />
            <text class="ts" x="474" y="224">Dip tube</text>
        </g>
        <g class="node" data-send-prompt="What does the thermostat control?">
            <line class="leader" x1="440" y1="250" x2="468" y2="300" />
            <circle cx="440" cy="250" r="2" fill="var(--t)" />
            <text class="ts" x="474" y="304">Thermostat</text>
        </g>
        <g class="node" data-send-prompt="What material is the tank made of?">
            <line class="leader" x1="440" y1="380" x2="468" y2="380" />
            <circle cx="440" cy="380" r="2" fill="var(--t)" />
            <text class="ts" x="474" y="384">Tank wall</text>
        </g>
        <g class="node" data-send-prompt="How does the gas burner heat water?">
            <line class="leader" x1="432" y1="454" x2="468" y2="454" />
            <circle cx="432" cy="454" r="2" fill="var(--t)" />
            <text class="ts" x="474" y="458">Heating element</text>
        </g>
    </svg>
    <style>
        @keyframes conv {
            to {
                stroke-dashoffset: -20;
            }
        }
        .conv {
            stroke-dasharray: 5 5;
            animation: conv var(--dur, 1.6s) linear infinite;
            transition: opacity 0.5s;
        }
        .conv.off {
            opacity: 0;
            animation-play-state: paused;
        }
        #flames path {
            transition: opacity 0.5s;
        }
        #flames.off path {
            opacity: 0;
            animation: none;
        }
        .toggle-track {
            position: relative;
            width: 32px;
            height: 18px;
            background: var(--color-border-secondary);
            border-radius: 9px;
            transition: background 0.2s;
            display: inline-block;
        }
        .toggle-track:has(input:checked) {
            background: var(--color-text-info);
        }
        #heat-toggle:checked + span {
            transform: translateX(14px);
        }
    </style>
    <div
        style="display:flex;align-items:center;gap:16px;margin:12px 0 0;font-size:13px;color:var(--color-text-secondary)"
    >
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none">
            <span class="toggle-track">
                <input
                    type="checkbox"
                    id="heat-toggle"
                    checked
                    style="position:absolute;opacity:0;width:100%;height:100%;cursor:pointer;margin:0"
                />
                <span
                    style="position:absolute;top:2px;left:2px;width:14px;height:14px;background:#fff;border-radius:50%;transition:transform .2s;pointer-events:none"
                ></span>
            </span>
            Heating
        </label>
        <span>Thermostat</span>
        <input type="range" id="temp-slider" min="10" max="90" value="40" style="flex:1" />
        <span id="temp-label" style="min-width:36px;text-align:right">40%</span>
    </div>
    <script>
        function setTemp(v) {
            const split = Math.max(80, Math.min(290, 55 + Number(v) * 3.2));
            document
                .querySelectorAll('[data-hot-band]')[0]
                ?.setAttribute('height', String(split - 55));
            document.querySelectorAll('[data-cool-band]')[0]?.setAttribute('y', String(split));
            document
                .querySelectorAll('[data-cool-band]')[0]
                ?.setAttribute('height', String(445 - split));
            document.getElementById('temp-label').textContent = v + '%';
        }
        function toggleHeat(on) {
            document.getElementById('flames').classList.toggle('off', !on);
            document.querySelectorAll('.conv').forEach((p) => p.classList.toggle('off', !on));
        }
        document.getElementById('heat-toggle')?.addEventListener('change', (event) => {
            toggleHeat(event.currentTarget.checked);
        });
        document.getElementById('temp-slider')?.addEventListener('input', (event) => {
            setTemp(event.currentTarget.value);
        });
    </script>
</section>
```

**Illustrative example — abstract subject** (attention in a transformer). Same rules, no physical object. A row of tokens at the bottom, one query token highlighted, weight-scaled lines fanning to every other token. Caption sits below the fan — clear of every stroke — not inside it.

```svg
<rect class="c-purple" x="60" y="40"  width="560" height="26" rx="6" stroke-width="0.5"/>
<rect class="c-purple" x="60" y="80"  width="560" height="26" rx="6" stroke-width="0.5"/>
<rect class="c-purple" x="60" y="120" width="560" height="26" rx="6" stroke-width="0.5"/>
<text class="ts" x="72" y="57" >Layer 3</text>
<text class="ts" x="72" y="97" >Layer 2</text>
<text class="ts" x="72" y="137">Layer 1</text>

<line stroke="#EF9F27" stroke-linecap="round" x1="340" y1="230" x2="116" y2="146" stroke-width="1"   opacity="0.25"/>
<line stroke="#EF9F27" stroke-linecap="round" x1="340" y1="230" x2="228" y2="146" stroke-width="1.5" opacity="0.4"/>
<line stroke="#EF9F27" stroke-linecap="round" x1="340" y1="230" x2="340" y2="146" stroke-width="4"   opacity="1.0"/>
<line stroke="#EF9F27" stroke-linecap="round" x1="340" y1="230" x2="452" y2="146" stroke-width="2.5" opacity="0.7"/>
<line stroke="#EF9F27" stroke-linecap="round" x1="340" y1="230" x2="564" y2="146" stroke-width="1"   opacity="0.2"/>

<g class="node" data-send-prompt="What do the attention weights mean?">
  <rect class="c-gray"  x="80"  y="230" width="72" height="36" rx="6" stroke-width="0.5"/>
  <rect class="c-gray"  x="192" y="230" width="72" height="36" rx="6" stroke-width="0.5"/>
  <rect class="c-amber" x="304" y="230" width="72" height="36" rx="6" stroke-width="1"/>
  <rect class="c-gray"  x="416" y="230" width="72" height="36" rx="6" stroke-width="0.5"/>
  <rect class="c-gray"  x="528" y="230" width="72" height="36" rx="6" stroke-width="0.5"/>
  <text class="ts" x="116" y="252" text-anchor="middle">the</text>
  <text class="ts" x="228" y="252" text-anchor="middle">cat</text>
  <text class="th" x="340" y="252" text-anchor="middle">sat</text>
  <text class="ts" x="452" y="252" text-anchor="middle">on</text>
  <text class="ts" x="564" y="252" text-anchor="middle">the</text>
</g>

<text class="ts" x="340" y="300" text-anchor="middle">Line thickness = attention weight from "sat" to each token</text>
```

Note what's _not_ here: no boxes labelled "multi-head attention", no arrows labelled "Q/K/V". Those belong in the structural diagram. This one is about the _feeling_ of attention — one token looking at every other token with varying intensity.

These are starting points, not ceilings. For the water heater: add a thermostat slider, animate the convection current, toggle heating vs standby. For the attention diagram: let the user click any token to become the query, scrub through layers, animate the weights settling. The goal is always to _show_ how the thing works, not just _label_ it.

## Art and illustration

_"Draw me a sunset" / "Create a geometric pattern"_

Use `builtin__show_widget` with raw SVG in `widget_code`. Same technical rules (viewBox, safe area) but the aesthetic is different:

- Fill the canvas — art should feel rich, not sparse
- Bold colors: mix `--color-text-*` categories for variety (info blue, success green, warning amber)
- Art is the one place custom `<style>` color blocks are fine — freestyle colors, `prefers-color-scheme` for dark mode variants if you want them
- Layer overlapping opaque shapes for depth
- Organic forms with `<path>` curves, `<ellipse>`, `<circle>`
- Texture via repetition (parallel lines, dots, hatching) not raster effects
- Geometric arrangements with repeated `<g transform="rotate()">` groups for radial symmetry
