import '@styles/visual-reply.css';
import './VisualRepliesComparison.stories.css';

import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { onUnmounted, ref } from 'vue';

import { registerVisualReplyHost } from '@/services/VisualReplyService/bridge';

import OpenUIReply from './OpenUIReply.vue';
import VisualArtifactFrame from './VisualArtifactFrame.vue';

/*
 * Mirrors the official OpenUI sales pipeline data inside T3 Code's near-black
 * transcript: one flat report surface, hairline-separated metrics and a compact
 * bookings/funnel split.
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
  :root { color-scheme: dark; }
  html, body { background: #09090b; }
  body { margin: 0; padding: 16px; color: #f4f4f5; font: 12px/1.5 var(--touchai-font-sans, ui-sans-serif, system-ui, sans-serif); }
  .shell { display: flex; flex-direction: column; gap: 16px; }
  .header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
  .eyebrow { margin: 0 0 2px; color: #71717a; font-size: 9px; font-weight: 500; letter-spacing: 0.1em; text-transform: uppercase; }
  h2 { margin: 0; font-size: 15px; font-weight: 600; letter-spacing: -0.01em; line-height: 1.35; }
  .tag { flex: none; border: 1px solid rgb(255 255 255 / 8%); border-radius: 4px; padding: 2px 6px; color: #71717a; background: rgb(255 255 255 / 4%); font: 9px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; text-transform: uppercase; }
  .stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); border-block: 1px solid rgb(255 255 255 / 8%); }
  .stat { display: flex; min-width: 0; flex-direction: column; gap: 2px; padding: 9px 0; }
  .stat + .stat { border-left: 1px solid rgb(255 255 255 / 8%); padding-left: 10px; }
  .stat-label { color: #71717a; font-size: 9px; font-weight: 500; letter-spacing: 0.08em; text-transform: uppercase; }
  .stat-value { color: #e4e4e7; font-size: 12px; font-weight: 500; font-variant-numeric: tabular-nums; }
  .visual { display: flex; flex-direction: column; gap: 10px; }
  .visual-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .visual-title { color: #d4d4d8; font-size: 11px; font-weight: 600; }
  #state { color: #71717a; font-size: 10px; }
  .bars { display: flex; height: 188px; align-items: end; gap: 8px; border-bottom: 1px solid rgb(255 255 255 / 8%); padding-bottom: 8px; }
  .column { display: flex; min-width: 0; height: 100%; flex: 1; flex-direction: column; align-items: center; justify-content: flex-end; gap: 4px; }
  .bar { display: flex; width: 100%; min-height: 30px; align-items: flex-start; justify-content: center; border: 1px solid rgb(255 255 255 / 8%); border-radius: 5px 5px 1px 1px; padding-top: 5px; color: #a1a1aa; background: #27272a; font-size: 10px; font-weight: 600; font-variant-numeric: tabular-nums; transition: height 180ms cubic-bezier(0.22, 1, 0.36, 1), background-color 180ms ease, border-color 180ms ease; }
  .column.compare .bar { border-color: #f4f4f5; color: #09090b; background: #f4f4f5; }
  .column.sorted .bar { border-color: rgb(255 255 255 / 6%); color: #52525b; background: #18181b; }
  .column-label { color: #52525b; font-size: 9px; font-variant-numeric: tabular-nums; }
  .controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  button { height: 28px; border: 1px solid rgb(255 255 255 / 15%); border-radius: 6px; padding: 0 10px; color: #d4d4d8; background: transparent; font: inherit; font-size: 10px; font-weight: 500; cursor: pointer; transition: background-color 140ms ease, color 140ms ease, border-color 140ms ease; }
  button.primary { border-color: #f4f4f5; color: #09090b; background: #f4f4f5; }
  button:hover:not(:disabled) { border-color: rgb(255 255 255 / 26%); background: rgb(255 255 255 / 5%); color: #f4f4f5; }
  button.primary:hover:not(:disabled) { border-color: #d4d4d8; background: #d4d4d8; color: #09090b; }
  button:disabled { cursor: default; opacity: 0.45; }
  button:focus-visible { outline: 2px solid #f4f4f5; outline-offset: 2px; }
  #hint { margin-left: auto; color: #71717a; font-size: 9px; text-align: right; }
  .divider { height: 1px; background: rgb(255 255 255 / 8%); }
  .lower { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr); gap: 18px; }
  .section-title { margin: 0; color: #a1a1aa; font-size: 10px; font-weight: 500; }
  ol { margin: 7px 0 0; padding-left: 15px; color: #71717a; font-size: 10px; line-height: 1.55; }
  li + li { margin-top: 4px; }
  .code { margin-top: 7px; overflow: hidden; border: 1px solid rgb(255 255 255 / 7%); border-radius: 7px; padding: 8px 9px; color: #a1a1aa; background: #050506; font: 9px/1.65 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre; }
  .code strong { color: #e4e4e7; font-weight: 500; }
  @media (max-width: 430px) {
    .lower { grid-template-columns: minmax(0, 1fr); gap: 14px; }
    .bars { height: 160px; }
    #hint { width: 100%; margin-left: 0; text-align: left; }
  }
</style>
<section class="shell" aria-label="Interactive bubble sort">
  <header class="header">
    <div><p class="eyebrow">Algorithm explorer</p><h2>Bubble sort</h2></div>
    <span class="tag">HTML + JS</span>
  </header>
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
  <div class="divider"></div>
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
                <header class="visual-reply-story__topbar">
                    <div class="visual-reply-story__topbar-inner">
                        <div class="visual-reply-story__brand">
                            <span class="visual-reply-story__brand-mark" aria-hidden="true"></span>
                            <span>TouchAI</span>
                            <span class="visual-reply-story__brand-separator">/</span>
                            <span class="visual-reply-story__brand-section">Visual replies</span>
                        </div>
                        <span class="visual-reply-story__status">OpenUI</span>
                    </div>
                </header>
                <div class="visual-reply-story__stage visual-reply-story__stage--single">
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

/** Actual transcript comparison: registered components vs. free-form HTML. */
export const OpenUIAndArtifact: Story = {
    render: () => ({
        components: { OpenUIReply, VisualArtifactFrame },
        setup() {
            const hostAction = ref('Host bridge ready');
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
                <header class="visual-reply-story__topbar">
                    <div class="visual-reply-story__topbar-inner">
                        <div class="visual-reply-story__brand">
                            <span class="visual-reply-story__brand-mark" aria-hidden="true"></span>
                            <span>TouchAI</span>
                            <span class="visual-reply-story__brand-separator">/</span>
                            <span class="visual-reply-story__brand-section">Visual replies</span>
                        </div>
                        <span class="visual-reply-story__status">Live components</span>
                    </div>
                </header>
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
                                <p class="visual-reply-story__host-action" aria-live="polite">{{ hostAction }}</p>
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
                                    <div class="visual-reply-story__artifact-bar">
                                        <span class="visual-reply-story__artifact-title">Artifact preview</span>
                                        <span class="visual-reply-story__artifact-meta">Sandboxed</span>
                                    </div>
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
