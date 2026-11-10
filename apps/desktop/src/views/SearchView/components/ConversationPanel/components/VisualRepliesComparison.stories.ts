import '@styles/visual-reply.css';
import './VisualRepliesComparison.stories.css';

import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { onUnmounted, ref } from 'vue';

import { registerVisualReplyHost } from '@/services/VisualReplyService/bridge';

import OpenUIReply from './OpenUIReply.vue';
import VisualArtifactFrame from './VisualArtifactFrame.vue';

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
    BarChart("Bookings · Forecast", [96, 104, 99, 112, 118, 109, 121, 127, 124, 131, 141, 153], ["Dec", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov"], "K")
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
  :root { color-scheme: dark; --ink: #f5f5f5; --muted: #a3a3a3; --surface: #0a0a0a; --line: rgb(255 255 255 / 10%); --radius: 10px; }
  html, body { background: transparent; }
  body { margin: 0; padding: 0; color: var(--ink); font: 14px/1.5 var(--touchai-font-sans, system-ui, sans-serif); }
  .shell { display: flex; flex-direction: column; gap: 24px; }
  h2 { margin: 0; font-size: 16px; font-weight: 600; letter-spacing: -0.015em; }
  .stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); padding-block: 4px; }
  .stat { display: flex; min-width: 0; flex-direction: column; gap: 4px; }
  .stat + .stat { border-left: 1px solid var(--line); padding-left: 20px; }
  .stat-label { color: var(--muted); font-size: 12px; }
  .stat-value { order: -1; font-size: 24px; font-weight: 500; letter-spacing: -0.03em; line-height: 1.2; font-variant-numeric: tabular-nums; }
  .visual { display: flex; flex-direction: column; gap: 16px; border-radius: var(--radius); padding: 16px; background: var(--surface); }
  .visual-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .visual-title { font-size: 13px; font-weight: 500; }
  #state { color: var(--muted); font-size: 12px; }
  .bars { display: flex; height: 188px; align-items: end; gap: 8px; border-bottom: 1px solid var(--line); padding-bottom: 8px; }
  .column { display: flex; min-width: 0; height: 100%; flex: 1; flex-direction: column; align-items: center; justify-content: flex-end; gap: 6px; }
  .bar { display: flex; width: 48px; max-width: 80%; min-height: 30px; align-items: flex-start; justify-content: center; border-radius: 4px 4px 0 0; padding-top: 6px; background: #525252; font-size: 12px; font-weight: 500; font-variant-numeric: tabular-nums; }
  .column.compare .bar { color: #171717; background: var(--ink); }
  .column.sorted .bar { color: var(--muted); background: #262626; }
  .column-label { color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
  .controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  button { min-height: 32px; border: 1px solid transparent; border-radius: 8px; padding: 6px 12px; color: var(--muted); background: transparent; font: inherit; font-size: 13px; font-weight: 500; cursor: pointer; }
  button.primary { border-color: var(--line); color: var(--ink); background: #171717; box-shadow: 0 1px 2px rgb(0 0 0 / 5%); }
  button:hover:not(:disabled) { color: var(--ink); background: #262626; }
  button:disabled { cursor: default; opacity: 0.45; }
  button:focus-visible { outline: 2px solid var(--touchai-color-focus, #6b97ff); outline-offset: 2px; }
  #hint { margin-left: auto; color: var(--muted); font-size: 12px; text-align: right; }
  .lower { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr); gap: 24px; }
  .section-title { margin: 0; font-size: 13px; font-weight: 500; }
  ol { margin: 12px 0 0; padding-left: 16px; color: var(--muted); font-size: 13px; line-height: 1.65; }
  li + li { margin-top: 4px; }
  .code { margin-top: 12px; overflow: auto; border-radius: var(--radius); padding: 12px; color: var(--muted); background: var(--surface); font: 12px/1.65 var(--touchai-font-mono, monospace); white-space: pre; }
  .code strong { color: var(--ink); font-weight: 500; }
  @media (max-width: 480px) {
    .lower { grid-template-columns: minmax(0, 1fr); }
    #hint { width: 100%; margin-left: 0; text-align: left; }
  }
</style>
<section class="shell" aria-label="Interactive bubble sort">
  <h2>Bubble sort</h2>
  <div class="stats">
    <div class="stat"><span class="stat-label">Pass</span><strong class="stat-value" data-pass>1 / 3</strong></div>
    <div class="stat"><span class="stat-label">Comparisons</span><strong class="stat-value" data-comparisons>0</strong></div>
    <div class="stat"><span class="stat-label">Swaps</span><strong class="stat-value" data-swaps>0</strong></div>
  </div>
  <section class="visual">
    <div class="visual-head"><span class="visual-title">Array</span><span id="state" aria-live="polite">Ready</span></div>
    <div class="bars" data-sort-bars role="img" aria-label="Bubble sort values"></div>
    <div class="controls">
      <button class="primary" type="button" data-sort-step>Next comparison</button>
      <button type="button" data-sort-reset>Reset</button>
      <span id="hint">Compare adjacent values</span>
    </div>
  </section>
  <div class="lower">
    <section>
      <p class="section-title">How it works</p>
      <ol>
        <li>Compare two adjacent values.</li>
        <li>Swap them when the left value is larger.</li>
        <li>Repeat until the largest value reaches the end.</li>
      </ol>
    </section>
    <section>
      <p class="section-title">Pseudocode</p>
      <div class="code"><strong>for</strong> pass in 0...n
  <strong>if</strong> a[i] &gt; a[i + 1]
    swap(a[i], a[i + 1])</div>
    </section>
  </div>
</section>
<script>
  (() => {
    const initial = [4, 1, 3, 2];
    let values = initial.slice();
    let pass = 0;
    let index = 0;
    let comparisons = 0;
    let swaps = 0;
    let done = false;
    let comparing = [];
    const bars = document.querySelector('[data-sort-bars]');
    const state = document.querySelector('#state');
    const hint = document.querySelector('#hint');
    const button = document.querySelector('[data-sort-step]');
    const resetButton = document.querySelector('[data-sort-reset]');
    const passValue = document.querySelector('[data-pass]');
    const comparisonsValue = document.querySelector('[data-comparisons]');
    const swapsValue = document.querySelector('[data-swaps]');
    const render = () => {
      passValue.textContent = Math.min(pass + 1, values.length - 1) + ' / ' + (values.length - 1);
      comparisonsValue.textContent = String(comparisons);
      swapsValue.textContent = String(swaps);
      bars.replaceChildren(...values.map((value, slot) => {
        const column = document.createElement('span');
        column.className = 'column';
        if (comparing.includes(slot)) column.classList.add('compare');
        if (done || (pass > 0 && slot >= values.length - pass)) column.classList.add('sorted');
        const bar = document.createElement('span');
        bar.className = 'bar';
        bar.style.height = (30 + value * 34) + 'px';
        bar.textContent = String(value);
        const label = document.createElement('span');
        label.className = 'column-label';
        label.textContent = '0' + (slot + 1);
        column.append(bar, label);
        return column;
      }));
      bars.setAttribute('aria-label', 'Bubble sort values: ' + values.join(', '));
    };
    const advance = () => {
      if (done) return;
      const left = index;
      const right = left + 1;
      const beforeLeft = values[left];
      const beforeRight = values[right];
      const swapped = values[left] > values[right];
      if (swapped) [values[left], values[right]] = [values[right], values[left]];
      comparing = [left, right];
      comparisons += 1;
      if (swapped) swaps += 1;
      index += 1;
      if (index >= values.length - pass - 1) { pass += 1; index = 0; }
      render();
      if (pass >= values.length - 1) {
        done = true;
        comparing = [];
        render();
        state.textContent = 'Sorted';
        hint.textContent = values.join(' < ');
        button.disabled = true;
        return;
      }
      state.textContent = swapped ? 'Swapped' : 'Kept order';
      hint.textContent = beforeLeft + (swapped ? ' > ' : ' < ') + beforeRight;
    };
    const reset = () => {
      values = initial.slice();
      pass = 0;
      index = 0;
      comparisons = 0;
      swaps = 0;
      done = false;
      comparing = [];
      state.textContent = 'Ready';
      hint.textContent = 'Compare adjacent values';
      button.disabled = false;
      render();
    };
    render();
    button.addEventListener('click', advance);
    resetButton.addEventListener('click', reset);
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

/** The official OpenUI sales pipeline case inside a real assistant transcript. */
export const OfficialDashboard: Story = {
    render: () => ({
        components: { OpenUIReply },
        setup() {
            return { salesDashboardResponse };
        },
        template: `
            <main class="visual-reply-story">
                <div class="visual-reply-story__stage">
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
                </div>
            </main>
        `,
    }),
};

export const OfficialDashboardLight: Story = {
    ...OfficialDashboard,
    decorators: [() => ({ template: '<div class="visual-reply-story--light"><story /></div>' })],
};

/** Actual transcript comparison: registered components vs. free-form HTML. */
export const OpenUIAndArtifact: Story = {
    render: () => ({
        components: { OpenUIReply, VisualArtifactFrame },
        setup() {
            const hostAction = ref('');
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
                <div class="visual-reply-story__board">
                    <section class="visual-reply-story__column">
                        <header class="visual-reply-story__column-head">
                            <h1 class="visual-reply-story__column-title">OpenUI</h1>
                            <span class="visual-reply-story__column-meta">Registered components</span>
                        </header>
                        <div class="visual-reply-story__thread">
                            <div class="visual-reply-story__prompt-row">
                                <p class="visual-reply-story__prompt">
                                    Make a sales pipeline dashboard for this quarter
                                </p>
                            </div>
                            <div class="visual-reply-story__reply">
                                <OpenUIReply :response="salesDashboardResponse" :is-streaming="false" />
                                <p v-if="hostAction" class="visual-reply-story__host-action" role="status">{{ hostAction }}</p>
                            </div>
                        </div>
                    </section>

                    <section class="visual-reply-story__column">
                        <header class="visual-reply-story__column-head">
                            <h1 class="visual-reply-story__column-title">Artifact</h1>
                            <span class="visual-reply-story__column-meta">Sandboxed HTML + JavaScript</span>
                        </header>
                        <div class="visual-reply-story__thread">
                            <div class="visual-reply-story__prompt-row">
                                <p class="visual-reply-story__prompt">
                                    Show me how bubble sort works, and let me step through it
                                </p>
                            </div>
                            <div class="visual-reply-story__reply">
                                <div class="visual-reply-story__artifact">
                                    <VisualArtifactFrame :html="artifactHtml" title="Interactive bubble sort artifact" />
                                </div>
                            </div>
                        </div>
                    </section>
                </div>
            </main>
        `,
    }),
};
