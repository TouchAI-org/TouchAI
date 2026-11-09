import '@styles/visual-reply.css';

import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { onUnmounted, ref } from 'vue';

import { registerVisualReplyHost } from '@/services/VisualReplyService/bridge';

import OpenUIReply from './OpenUIReply.vue';
import VisualArtifactFrame from './VisualArtifactFrame.vue';

/*
 * Mirrors the official OpenUI Sales pipeline example: title and summary, a
 * rule-separated KPI strip, a 1.7:1 bookings/funnel split, and a compact rep
 * leaderboard. The numbers and composition match the published sample.
 */
const salesDashboardResponse = `root = Root([
  Heading("Sales pipeline", 2),
  Text("Pipeline stands at $7.0M this quarter, up 12% across 219 open deals", "muted"),
  Grid([
    Metric("Pipeline", "$7.0M"),
    Metric("Open deals", "219"),
    Metric("Win rate", "28%"),
    Metric("Average deal", "$32.1K"),
  ], "4"),
  Columns([
    BarChart("Bookings · Forecast", [96, 104, 99, 112, 118, 109, 121, 127, 124, 131, 141, 153], ["D", "J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N"], "K")
  ], [
    Funnel("Pipeline by stage", ["Prospecting", "Qualified", "Proposal", "Negotiation"], [3000000, 2000000, 1300000, 700000], ["$3.0M", "$2.0M", "$1.3M", "$0.7M"])
  ]),
  Heading("Top reps this quarter", 3),
  DataTable(["Rep", "Open deals", "Pipeline", "Share"], [
    ["Maya Chen", "52", "$1.68M", "24%"],
    ["Leo Park", "47", "$1.47M", "21%"],
    ["Ana Ruiz", "34", "$1.05M", "15%"],
    ["Sam Patel", "26", "$0.77M", "11%"],
  ]),
  Actions([ActionButton("Break down pipeline by region", "Break down this quarter's sales pipeline by region"), LinkButton("Open forecast", "https://example.com/forecast")]),
])`;

const artifactHtml = `
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 2px; color: var(--touchai-color-text-primary); font: 13px/1.5 var(--touchai-font-sans); }
  .panel { border: 1px solid var(--touchai-color-border-subtle); border-radius: var(--touchai-radius-card); padding: 16px; background: var(--touchai-color-surface-raised); }
  .header { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; }
  h2 { margin: 0; font-size: 16px; font-weight: 600; letter-spacing: -0.01em; }
  .bars { display: flex; height: 132px; align-items: end; gap: 8px; margin: 18px 0 14px; border-bottom: 1px solid var(--touchai-color-border-subtle); }
  .bar { display: flex; flex: 1; min-width: 0; align-items: start; justify-content: center; border-radius: 4px 4px 0 0; padding-top: 5px; color: var(--touchai-color-surface-raised); background: var(--touchai-color-primary); font-weight: 600; font-size: 11px; transition: height 180ms ease, background 180ms ease; }
  .bar.compare { background: var(--touchai-color-text-primary); }
  .bar.sorted { background: color-mix(in srgb, var(--touchai-color-primary) 18%, transparent); color: var(--touchai-color-text-secondary); }
  .controls { display: flex; align-items: center; gap: 12px; }
  button { height: 30px; border: 1px solid var(--touchai-color-border-subtle); border-radius: var(--touchai-radius-control); padding: 0 12px; color: var(--touchai-color-text-primary); background: transparent; font: inherit; font-size: 12px; font-weight: 500; cursor: pointer; }
  button:hover { background: color-mix(in srgb, var(--touchai-color-text-primary) 6%, transparent); }
  button:focus-visible { outline: 2px solid var(--touchai-color-focus); outline-offset: 2px; }
  #state { min-width: 0; overflow-wrap: anywhere; color: var(--touchai-color-text-secondary); font-size: 12px; }
</style>
<section class="panel" aria-label="Interactive bubble sort">
  <div class="header"><h2>Bubble sort</h2></div>
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

/** The official OpenUI Sales pipeline case inside a real assistant transcript. */
export const OfficialDashboard: Story = {
    render: () => ({
        components: { OpenUIReply },
        setup() {
            return { salesDashboardResponse };
        },
        template: `
            <main class="min-h-screen bg-background-primary px-6 py-10 text-text-primary sm:px-10">
                <article class="mx-auto flex w-full max-w-2xl flex-col gap-7">
                    <div class="flex justify-end">
                        <p class="max-w-md rounded-lg bg-secondary px-4 py-2 font-serif text-reading leading-relaxed">
                            Make a sales pipeline dashboard for this quarter
                        </p>
                    </div>
                    <section class="min-w-0" aria-label="Assistant reply">
                        <h1 class="sr-only">TouchAI</h1>
                        <OpenUIReply :response="salesDashboardResponse" :is-streaming="false" />
                    </section>
                </article>
            </main>
        `,
    }),
};

/** Actual transcript comparison: registered components vs. free-form HTML. */
export const OpenUIAndArtifact: Story = {
    render: () => ({
        components: { OpenUIReply, VisualArtifactFrame },
        setup() {
            const hostAction = ref('Choose an OpenUI action to test the host bridge');
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
            <main class="min-h-screen bg-background-primary px-6 py-10 text-text-primary sm:px-10">
                <div class="mx-auto grid w-full max-w-6xl gap-12 lg:grid-cols-2">
                    <section class="min-w-0">
                        <header class="mb-5 flex items-baseline justify-between gap-4 border-b border-border-subtle pb-3">
                            <h1 class="text-sm font-semibold">OpenUI</h1>
                            <span class="text-caption text-text-tertiary">Registered components</span>
                        </header>
                        <div class="flex justify-end">
                            <p class="max-w-md rounded-lg bg-secondary px-4 py-2 font-serif text-reading leading-relaxed">
                                Make a sales pipeline dashboard for this quarter
                            </p>
                        </div>
                        <div class="mt-6 min-w-0">
                            <OpenUIReply :response="salesDashboardResponse" :is-streaming="false" />
                            <p class="mt-4 border-t border-border-subtle pt-3 text-dense text-text-secondary" aria-live="polite">{{ hostAction }}</p>
                        </div>
                    </section>

                    <section class="min-w-0">
                        <header class="mb-5 flex items-baseline justify-between gap-4 border-b border-border-subtle pb-3">
                            <h1 class="text-sm font-semibold">Artifact</h1>
                            <span class="text-caption text-text-tertiary">Sandboxed HTML + JavaScript</span>
                        </header>
                        <div class="flex justify-end">
                            <p class="max-w-md rounded-lg bg-secondary px-4 py-2 font-serif text-reading leading-relaxed">
                                Show me how bubble sort works, and let me step through it
                            </p>
                        </div>
                        <div class="mt-6 min-w-0">
                            <VisualArtifactFrame :html="artifactHtml" title="Interactive bubble sort artifact" />
                        </div>
                    </section>
                </div>
            </main>
        `,
    }),
};
