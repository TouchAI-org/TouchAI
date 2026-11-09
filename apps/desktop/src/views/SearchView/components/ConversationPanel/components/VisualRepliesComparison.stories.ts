import '@styles/visual-reply.css';

import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { onUnmounted, ref } from 'vue';

import { registerVisualReplyHost } from '@/services/VisualReplyService/bridge';

import OpenUIReply from './OpenUIReply.vue';
import VisualArtifactFrame from './VisualArtifactFrame.vue';

/*
 * The data and composition mirror the official OpenUI Sales pipeline example:
 * heading, muted summary, four rule-separated KPIs, bookings bars, and a rep
 * leaderboard. Keeping the official numbers makes visual comparison meaningful.
 */
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

/** Full-width official Sales dashboard, inside the real message column. */
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

/** Side-by-side capability comparison: fixed components vs. free-form HTML. */
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
