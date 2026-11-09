import '@styles/visual-reply.css';

import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { onUnmounted, ref } from 'vue';

import { registerVisualReplyHost } from '@/services/VisualReplyService/bridge';

import OpenUIReply from './OpenUIReply.vue';
import VisualArtifactFrame from './VisualArtifactFrame.vue';

/** Official OpenUI Sales pipeline data, kept identical across all variants. */
const salesDashboardResponse = `root = Root([
  Heading("Sales pipeline", 2),
  Text("Pipeline stands at $7.0M this quarter, up 12% across 219 open deals", "muted"),
  Grid([
    Metric("Pipeline", "$7.0M", "+12%"),
    Metric("Open deals", "219", "+6.1%"),
    Metric("Win rate", "28%", "+2.4%"),
    Metric("Average deal", "$32.1K", "-1.2%"),
  ], "4"),
  BarChart("Bookings · Forecast", [96, 104, 99, 112, 118, 109, 121, 127, 124, 131, 141, 153], ["D", "J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N"]),
  Heading("Top reps this quarter", 3),
  DataTable(["Rep", "Open deals", "Pipeline", "Share"], [
    ["Maya Chen", "52", "$1.68M", "24%"],
    ["Leo Park", "47", "$1.47M", "21%"],
    ["Ana Ruiz", "34", "$1.05M", "15%"],
    ["Sam Patel", "26", "$0.77M", "11%"],
  ]),
  Actions([ActionButton("Break down pipeline by region", "Break down this quarter's sales pipeline by region"), LinkButton("Open forecast", "https://example.com/forecast")]),
])`;

const headingOnly = `root = Root([Heading("Sales pipeline", 2)])`;
const textOnly = `root = Root([Text("Pipeline stands at $7.0M this quarter, up 12% across 219 open deals", "muted")])`;
const metricsOnly = `root = Root([
  Grid([
    Metric("Pipeline", "$7.0M", "+12%"),
    Metric("Open deals", "219", "+6.1%"),
    Metric("Win rate", "28%", "+2.4%"),
    Metric("Average deal", "$32.1K", "-1.2%"),
  ], "4")
])`;
const chartOnly = `root = Root([BarChart("Bookings · Forecast", [96, 104, 99, 112, 118, 109, 121, 127, 124, 131, 141, 153], ["D", "J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N"])])`;
const tableOnly = `root = Root([Heading("Top reps this quarter", 3), DataTable(["Rep", "Open deals", "Pipeline", "Share"], [["Maya Chen", "52", "$1.68M", "24%"], ["Leo Park", "47", "$1.47M", "21%"], ["Ana Ruiz", "34", "$1.05M", "15%"], ["Sam Patel", "26", "$0.77M", "11%"]])])`;
const actionsOnly = `root = Root([Actions([ActionButton("Break down pipeline by region", "Break down pipeline by region"), LinkButton("Open forecast", "https://example.com/forecast")])])`;

const artifactHtml = `
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 14px; color: #18181b; font: 13px/1.5 ui-sans-serif, system-ui, sans-serif; }
  h2 { margin: 0 0 2px; font-size: 16px; font-weight: 600; letter-spacing: -0.01em; }
  p { margin: 0; color: #71717a; font-size: 12px; }
  .bars { display: flex; height: 132px; align-items: end; gap: 8px; margin: 18px 0 14px; border-bottom: 1px solid #e4e4e7; }
  .bar { display: flex; flex: 1; min-width: 0; align-items: start; justify-content: center; border-radius: 3px 3px 0 0; padding-top: 5px; color: white; background: #52525b; font-weight: 600; font-size: 11px; transition: height 180ms ease, background 180ms ease; }
  .bar.compare { background: #18181b; }
  .bar.sorted { background: #d4d4d8; color: #52525b; }
  .controls { display: flex; align-items: center; gap: 12px; }
  button { height: 32px; border: 1px solid #e4e4e7; border-radius: 6px; padding: 0 12px; color: #18181b; background: white; font: inherit; font-size: 12px; font-weight: 500; cursor: pointer; }
  button:hover { background: #f4f4f5; }
  button:focus-visible { outline: 2px solid #a1a1aa; outline-offset: 2px; }
  #state { min-width: 0; overflow-wrap: anywhere; color: #71717a; font-size: 12px; }
</style>
<section aria-label="Interactive bubble sort">
  <h2>Bubble sort</h2>
  <p>Free-form state and local JavaScript.</p>
  <div class="bars" data-sort-bars role="img" aria-label="Bubble sort values"></div>
  <div class="controls"><button type="button" data-sort-step>Next comparison</button><span id="state" aria-live="polite"></span></div>
</section>
<script>
  (() => {
    const values = [4, 1, 3, 2];
    let pass = 0;
    let index = 0;
    const bars = document.querySelector('[data-sort-bars]');
    const state = document.querySelector('#state');
    const button = document.querySelector('[data-sort-step]');
    const render = (left = -1) => {
      bars.replaceChildren(...values.map((value, slot) => {
        const bar = document.createElement('span');
        bar.className = 'bar' + (slot === left || slot === left + 1 ? ' compare' : '') + (slot >= values.length - pass ? ' sorted' : '');
        bar.style.height = (22 + value * 18) + 'px';
        bar.textContent = String(value);
        return bar;
      }));
    };
    const advance = () => {
      if (pass >= values.length - 1) return;
      const left = index;
      const right = left + 1;
      if (values[left] > values[right]) [values[left], values[right]] = [values[right], values[left]];
      render(left);
      state.textContent = 'Pass ' + (pass + 1) + ': compare positions ' + (left + 1) + ' and ' + (right + 1);
      index += 1;
      if (index >= values.length - pass - 1) { pass += 1; index = 0; }
      if (pass >= values.length - 1) { render(); state.textContent = 'Sorted: ' + values.join(', '); button.disabled = true; }
    };
    render(0);
    state.textContent = 'Ready: ' + values.join(', ');
    button.addEventListener('click', advance);
  })();
</script>`;

const meta = {
    title: 'Search/Visual Replies',
    component: OpenUIReply,
    args: { response: salesDashboardResponse, isStreaming: false },
    parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof OpenUIReply>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * T3-style variant board: each component gets its own card with a label,
 * heading, and muted caption. This mirrors the attached T3 Code comparison
 * layout — dark surface, rounded cards, and a quiet preview area.
 */
export const T3VariantBoard: Story = {
    render: () => ({
        components: { OpenUIReply },
        setup() {
            return {
                headingOnly,
                textOnly,
                metricsOnly,
                chartOnly,
                tableOnly,
                actionsOnly,
            };
        },
        template: `
            <main class="min-h-screen px-10 py-10" style="--vrb-bg: #09090b; --vrb-card: #18181b; --vrb-border: #27272a; --vrb-muted: #a1a1aa; --vrb-fg: #fafafa; --vrb-preview: #fafafa; background-color: var(--vrb-bg); color: var(--vrb-fg);">
                <div class="mx-auto max-w-3xl">
                    <p class="mb-8 text-sm" style="color: var(--vrb-muted);">OpenUI visual reply components · official Sales pipeline data</p>
                    <div class="grid gap-7 md:grid-cols-2">
                        <section class="rounded-xl p-6" style="border: 1px solid var(--vrb-border); background-color: var(--vrb-card);">
                            <header class="mb-5 flex items-baseline justify-between gap-3">
                                <div class="flex items-baseline gap-3"><span class="text-sm font-medium" style="color: var(--vrb-muted);">A</span><h2 class="text-base font-semibold">Heading</h2></div>
                                <span class="text-dense" style="color: var(--vrb-muted);">20px · 600</span>
                            </header>
                            <div class="rounded-lg px-5 py-6" style="background-color: var(--vrb-preview);">
                                <OpenUIReply :response="headingOnly" :is-streaming="false" />
                            </div>
                            <p class="mt-5 text-sm" style="color: var(--vrb-muted);">The reply title, level 2. Larger than surrounding prose.</p>
                        </section>

                        <section class="rounded-xl p-6" style="border: 1px solid var(--vrb-border); background-color: var(--vrb-card);">
                            <header class="mb-5 flex items-baseline justify-between gap-3">
                                <div class="flex items-baseline gap-3"><span class="text-sm font-medium" style="color: var(--vrb-muted);">B</span><h2 class="text-base font-semibold">Summary</h2></div>
                                <span class="text-dense" style="color: var(--vrb-muted);">13px · muted</span>
                            </header>
                            <div class="rounded-lg px-5 py-6" style="background-color: var(--vrb-preview);">
                                <OpenUIReply :response="textOnly" :is-streaming="false" />
                            </div>
                            <p class="mt-5 text-sm" style="color: var(--vrb-muted);">A single muted paragraph that carries the key takeaway.</p>
                        </section>

                        <section class="rounded-xl p-6 md:col-span-2" style="border: 1px solid var(--vrb-border); background-color: var(--vrb-card);">
                            <header class="mb-5 flex items-baseline justify-between gap-3">
                                <div class="flex items-baseline gap-3"><span class="text-sm font-medium" style="color: var(--vrb-muted);">C</span><h2 class="text-base font-semibold">Metrics</h2></div>
                                <span class="text-dense" style="color: var(--vrb-muted);">24px · rules</span>
                            </header>
                            <div class="rounded-lg px-5 py-6" style="background-color: var(--vrb-preview);">
                                <OpenUIReply :response="metricsOnly" :is-streaming="false" />
                            </div>
                            <p class="mt-5 text-sm" style="color: var(--vrb-muted);">Rule-separated key figures. No cards, no boxes, no background.</p>
                        </section>

                        <section class="rounded-xl p-6 md:col-span-2" style="border: 1px solid var(--vrb-border); background-color: var(--vrb-card);">
                            <header class="mb-5 flex items-baseline justify-between gap-3">
                                <div class="flex items-baseline gap-3"><span class="text-sm font-medium" style="color: var(--vrb-muted);">D</span><h2 class="text-base font-semibold">Bar chart</h2></div>
                                <span class="text-dense" style="color: var(--vrb-muted);">208px · interactive</span>
                            </header>
                            <div class="rounded-lg px-5 py-6" style="background-color: var(--vrb-preview);">
                                <OpenUIReply :response="chartOnly" :is-streaming="false" />
                            </div>
                            <p class="mt-5 text-sm" style="color: var(--vrb-muted);">Brand-coloured bars with hover readout. No legend duplication.</p>
                        </section>

                        <section class="rounded-xl p-6 md:col-span-2" style="border: 1px solid var(--vrb-border); background-color: var(--vrb-card);">
                            <header class="mb-5 flex items-baseline justify-between gap-3">
                                <div class="flex items-baseline gap-3"><span class="text-sm font-medium" style="color: var(--vrb-muted);">E</span><h2 class="text-base font-semibold">Data table</h2></div>
                                <span class="text-dense" style="color: var(--vrb-muted);">13px · single border</span>
                            </header>
                            <div class="rounded-lg px-5 py-6" style="background-color: var(--vrb-preview);">
                                <OpenUIReply :response="tableOnly" :is-streaming="false" />
                            </div>
                            <p class="mt-5 text-sm" style="color: var(--vrb-muted);">One rounded container. Hairline row dividers, numeric right-aligned.</p>
                        </section>

                        <section class="rounded-xl p-6 md:col-span-2" style="border: 1px solid var(--vrb-border); background-color: var(--vrb-card);">
                            <header class="mb-5 flex items-baseline justify-between gap-3">
                                <div class="flex items-baseline gap-3"><span class="text-sm font-medium" style="color: var(--vrb-muted);">F</span><h2 class="text-base font-semibold">Actions</h2></div>
                                <span class="text-dense" style="color: var(--vrb-muted);">32px · outline</span>
                            </header>
                            <div class="rounded-lg px-5 py-6" style="background-color: var(--vrb-preview);">
                                <OpenUIReply :response="actionsOnly" :is-streaming="false" />
                            </div>
                            <p class="mt-5 text-sm" style="color: var(--vrb-muted);">Compact outline chips in one row. Grouped, not scattered.</p>
                        </section>
                    </div>
                </div>
            </main>
        `,
    }),
};

/** Full-width official dashboard, as the model would output it in the chat row. */
export const OfficialDashboard: Story = {
    render: () => ({
        components: { OpenUIReply },
        setup() {
            return { salesDashboardResponse };
        },
        template: `
            <main class="min-h-screen bg-background-primary px-10 py-8 text-text-primary">
                <article class="mx-auto w-full max-w-2xl">
                    <p class="mb-3 text-dense font-medium text-text-secondary">TouchAI</p>
                    <OpenUIReply :response="salesDashboardResponse" :is-streaming="false" />
                </article>
            </main>
        `,
    }),
};

/** Capability comparison: fixed components vs. free-form HTML. */
export const OpenUIAndArtifact: Story = {
    render: () => ({
        components: { OpenUIReply, VisualArtifactFrame },
        setup() {
            const hostAction = ref('No host action yet');
            const dispose = registerVisualReplyHost({
                sendPrompt: (text) => {
                    hostAction.value = `Conversation prompt: ${text}`;
                },
                openLink: (url) => {
                    hostAction.value = `Open link: ${url}`;
                },
            });
            onUnmounted(dispose);

            return { artifactHtml, hostAction, salesDashboardResponse };
        },
        template: `
            <main class="min-h-screen bg-background-primary px-8 py-7 text-text-primary">
                <div class="mx-auto grid max-w-6xl min-w-0 gap-10 lg:grid-cols-2">
                    <section class="min-w-0">
                        <header class="mb-4 flex items-baseline justify-between gap-3">
                            <h1 class="text-base font-semibold">OpenUI</h1>
                            <span class="text-caption text-text-tertiary">Fixed components · host actions</span>
                        </header>
                        <OpenUIReply :response="salesDashboardResponse" :is-streaming="false" />
                        <p class="mt-4 min-h-8 border-t border-border-subtle pt-3 text-dense text-text-secondary" aria-live="polite">{{ hostAction }}</p>
                    </section>
                    <section class="min-w-0">
                        <header class="mb-4 flex items-baseline justify-between gap-3">
                            <h1 class="text-base font-semibold">Artifact</h1>
                            <span class="text-caption text-text-tertiary">Sandboxed HTML + JavaScript</span>
                        </header>
                        <VisualArtifactFrame :html="artifactHtml" title="Interactive bubble sort artifact" />
                    </section>
                </div>
            </main>
        `,
    }),
};
