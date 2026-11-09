import '@styles/visual-reply.css';

import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { onUnmounted, ref } from 'vue';

import { registerVisualReplyHost } from '@/services/VisualReplyService/bridge';

import OpenUIReply from './OpenUIReply.vue';
import VisualArtifactFrame from './VisualArtifactFrame.vue';

const openUIResponse = `root = Root([
  Heading("Q3 model spend"),
  Text("Cost is concentrated in long-context requests; the premium tier accounts for 54% of spend.", "muted"),
  Grid([
    Metric("Total", "$1,284", "+9% QoQ"),
    Metric("Premium", "$693", "54% of total"),
    Metric("Requests", "18,730", "+613 this week"),
  ], "3"),
  BarChart("Weekly spend", [240, 275, 312, 288, 335, 302, 132], ["W1", "W2", "W3", "W4", "W5", "W6", "W7"]),
  DataTable(["Model", "Requests", "Cost"], [
    ["Long context", "7,412", "$642"],
    ["Vision", "4,105", "$361"],
    ["Short context", "7,213", "$281"],
  ]),
  Actions([ActionButton("Analyze premium requests", "Analyze premium requests in Q3"), LinkButton("Open billing report", "https://example.com/report")]),
])`;

const artifactHtml = `
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 14px; color: #4a4039; font: 13px/1.45 system-ui, sans-serif; }
  h2 { margin: 0 0 4px; font-size: 16px; }
  p { margin: 0; color: #968b7d; font-size: 12px; }
  .bars { display: flex; height: 130px; align-items: end; gap: 10px; margin: 14px 0; }
  .bar { display: flex; flex: 1; min-width: 0; align-items: start; justify-content: center; border-radius: 5px 5px 0 0; padding-top: 6px; color: white; background: #6b5f54; font-weight: 650; font-size: 11px; transition: height 180ms ease, background 180ms ease; }
  .bar.compare { background: #4a4039; }
  .bar.sorted { background: #b8afa5; }
  .controls { display: flex; align-items: center; gap: 10px; }
  button { border: 1px solid #4a4039; border-radius: 10px; padding: 5px 10px; color: white; background: #4a4039; font: inherit; font-size: 12px; cursor: pointer; }
  button:focus-visible { outline: 2px solid #6b97ff; outline-offset: 2px; }
  #state { min-width: 0; overflow-wrap: anywhere; color: #6b5f54; font-size: 12px; }
</style>
<section aria-label="Interactive bubble sort">
  <h2>Bubble sort</h2>
  <p>Free-form state, animation, and controls.</p>
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
    args: { response: openUIResponse, isStreaming: false },
    parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof OpenUIReply>;

export default meta;
type Story = StoryObj<typeof meta>;

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

            return { artifactHtml, hostAction, openUIResponse };
        },
        template: `
            <main class="min-h-screen bg-background-primary px-5 py-6 text-text-primary">
                <div class="mx-auto flex max-w-6xl min-w-0 gap-7">
                    <section class="min-w-0 flex-1">
                        <header class="mb-4 flex items-baseline justify-between gap-3">
                            <h1 class="text-base font-semibold">OpenUI</h1>
                            <span class="text-caption text-text-tertiary">Fixed components · host actions</span>
                        </header>
                        <OpenUIReply :response="openUIResponse" :is-streaming="false" />
                        <p class="mt-4 min-h-10 border-t border-border-subtle pt-3 text-dense text-text-secondary" aria-live="polite">{{ hostAction }}</p>
                    </section>
                    <section class="min-w-0 flex-1">
                        <header class="mb-3 flex items-baseline justify-between gap-3">
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

export const OpenUIDashboard: Story = {
    render: () => ({
        components: { OpenUIReply },
        setup() {
            return { openUIResponse };
        },
        template: `
            <main class="min-h-screen bg-background-primary px-6 py-8 text-text-primary">
                <div class="mx-auto max-w-6xl">
                    <OpenUIReply :response="openUIResponse" :is-streaming="false" />
                </div>
            </main>
        `,
    }),
};
