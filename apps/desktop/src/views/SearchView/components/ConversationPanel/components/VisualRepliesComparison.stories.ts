import '@styles/visual-reply.css';
import './VisualRepliesComparison.stories.css';

import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { onUnmounted, ref } from 'vue';

import { registerVisualReplyHost } from '@/services/VisualReplyService/bridge';

import OpenUIReply from './OpenUIReply.vue';
import VisualArtifactFrame from './VisualArtifactFrame.vue';

/*
 * Mirrors the official OpenUI Sales pipeline data, rendered through T3-style
 * zinc surfaces: compact KPI cards, a 1.7:1 bookings/funnel split, and a single
 * bordered leaderboard.
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
  Actions([ActionButton("Break down pipeline by region", "Break down this quarter's sales pipeline by region", "primary"), LinkButton("Open forecast", "https://example.com/forecast")]),
])`;

const artifactHtml = `
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 2px; color: #18181b; font: 13px/1.5 var(--touchai-font-sans); }
  .panel { border: 1px solid #e4e4e7; border-radius: 12px; padding: 18px; background: #fff; box-shadow: 0 1px 2px rgb(0 0 0 / 4%); }
  .header { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; }
  h2 { margin: 0; font-size: 18px; font-weight: 600; letter-spacing: -0.02em; }
  .bars { display: flex; height: 132px; align-items: end; gap: 8px; margin: 18px 0 14px; border-bottom: 1px solid #e4e4e7; }
  .bar { display: flex; flex: 1; min-width: 0; align-items: start; justify-content: center; border-radius: 4px 4px 2px 2px; padding-top: 5px; color: #fff; background: #4f46e5; font-weight: 600; font-size: 10px; transition: height 180ms ease, background 180ms ease; }
  .bar.compare { background: #18181b; }
  .bar.sorted { background: #eef2ff; color: #71717a; }
  .controls { display: flex; align-items: center; gap: 12px; }
  button { height: 32px; border: 1px solid #d4d4d8; border-radius: 8px; padding: 0 12px; color: #18181b; background: #fff; box-shadow: 0 1px 2px rgb(0 0 0 / 4%); font: inherit; font-size: 12px; font-weight: 500; cursor: pointer; }
  button:hover { background: #f4f4f5; }
  button:focus-visible { outline: 2px solid #4f46e5; outline-offset: 2px; }
  #state { min-width: 0; overflow-wrap: anywhere; color: #71717a; font-size: 12px; }
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
            <main class="visual-reply-story">
                <article class="visual-reply-story__thread">
                    <div class="visual-reply-story__prompt-row">
                        <p class="visual-reply-story__prompt">
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
            <main class="visual-reply-story">
                <div class="visual-reply-story__comparison">
                    <section class="visual-reply-story__column">
                        <header class="visual-reply-story__column-head">
                            <h1 class="visual-reply-story__column-title">OpenUI</h1>
                            <span class="visual-reply-story__column-meta">Registered components</span>
                        </header>
                        <div class="visual-reply-story__prompt-row">
                            <p class="visual-reply-story__prompt">
                                Make a sales pipeline dashboard for this quarter
                            </p>
                        </div>
                        <div class="visual-reply-story__reply">
                            <OpenUIReply :response="salesDashboardResponse" :is-streaming="false" />
                            <p class="visual-reply-story__host-action" aria-live="polite">{{ hostAction }}</p>
                        </div>
                    </section>

                    <section class="visual-reply-story__column">
                        <header class="visual-reply-story__column-head">
                            <h1 class="visual-reply-story__column-title">Artifact</h1>
                            <span class="visual-reply-story__column-meta">Sandboxed HTML + JavaScript</span>
                        </header>
                        <div class="visual-reply-story__prompt-row">
                            <p class="visual-reply-story__prompt">
                                Show me how bubble sort works, and let me step through it
                            </p>
                        </div>
                        <div class="visual-reply-story__reply">
                            <VisualArtifactFrame :html="artifactHtml" title="Interactive bubble sort artifact" />
                        </div>
                    </section>
                </div>
            </main>
        `,
    }),
};
