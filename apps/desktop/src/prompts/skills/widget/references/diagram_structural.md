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
