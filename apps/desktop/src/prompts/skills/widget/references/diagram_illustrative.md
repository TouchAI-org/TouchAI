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
