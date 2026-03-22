# ShowWidget — Inline Visual Artifacts

## Overview

Use `builtin__show_widget` to create live, interactive HTML/SVG artifacts that render inline in the conversation. The widget appears as native DOM (not an iframe) and streams progressively as you generate it.

## Workflow

1. **Call `builtin__visualize_read_me` first** with relevant modules (`['diagram']`, `['chart']`, `['interactive']`, `['mockup']`, `['art']`)
2. **Read the returned guideline carefully** — it contains design rules, CSS variables, and streaming patterns
3. **Call `builtin__show_widget`** in the next tool round with `i_have_seen_read_me: true`

## Critical: Streaming-First Output Order

The widget streams token-by-token. Structure your tool call so visible content appears IMMEDIATELY:

```json
{
  "i_have_seen_read_me": true,
  "widget_code": "<svg viewBox=\"0 0 400 200\">...",
  "widgetId": "optional-id",
  "title": "optional-title"
}
```

**Start `widget_code` on the SAME LINE as the opening quote.** Do not output metadata fields first. The first characters of `widget_code` should already contain a visible root element (`<svg>`, `<div>`, `<section>`).

### Streaming Structure

- **CSS first** (if needed, keep under 15 lines)
- **Visible HTML/SVG immediately** — structure, shapes, text
- **Scripts last** — they execute after streaming completes

Example:
```html
<style>.root{display:grid;gap:8px}</style>
<div class="root">
  <div>Visible content here</div>
  <svg>...</svg>
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

Load the appropriate module via `builtin__visualize_read_me`:
- **diagram**: Flowcharts, org charts, system diagrams, architecture
- **chart**: Data visualization with Chart.js
- **interactive**: Forms, calculators, configurators, games
- **mockup**: UI mockups, wireframes, design comps
- **art**: Illustrations, decorative graphics, creative visuals