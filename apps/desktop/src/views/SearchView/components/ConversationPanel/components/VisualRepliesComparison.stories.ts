import '@styles/visual-reply.css';

import type { Meta, StoryObj } from '@storybook/vue3-vite';
import { onUnmounted, ref } from 'vue';

import { registerVisualReplyHost } from '@/services/VisualReplyService/bridge';

import OpenUIReply from './OpenUIReply.vue';
import VisualArtifactFrame from './VisualArtifactFrame.vue';

const openUIResponse = `root = Root([Heading("Bubble sort", 2), Text("A fixed component vocabulary renders the current algorithm state."), Metric("Pass", "1 of 3", "Comparing 4 and 1"), BarChart("Input values", [4, 1, 3, 2], ["A", "B", "C", "D"]), ActionButton("Explain the next step", "Explain the next bubble-sort comparison")])`;

const meta = {
    title: 'Search/Visual Replies',
    component: OpenUIReply,
    args: { response: openUIResponse, isStreaming: false },
    parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof OpenUIReply>;

export default meta;
type Story = StoryObj<typeof meta>;

const artifactHtml = `
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 12px; color: #25302e; font: 13px/1.45 system-ui, sans-serif; }
  h2 { margin: 0 0 3px; font-size: 16px; }
  p { margin: 0; color: #63706d; }
  .bars { display: flex; height: 116px; align-items: end; gap: 9px; margin: 12px 0; border-bottom: 1px solid #cbd5d1; }
  .bar { display: flex; flex: 1; min-width: 0; align-items: start; justify-content: center; border-radius: 4px 4px 0 0; padding-top: 5px; color: white; background: #32826e; font-weight: 650; transition: height 180ms ease, background 180ms ease; }
  .bar.compare { background: #c07135; }
  .bar.sorted { background: #65777b; }
  .controls { display: flex; align-items: center; gap: 10px; }
  button { border: 1px solid #32826e; border-radius: 5px; padding: 6px 10px; color: white; background: #32826e; font: inherit; cursor: pointer; }
  button:focus-visible { outline: 2px solid #c07135; outline-offset: 2px; }
  #state { min-width: 0; overflow-wrap: anywhere; }
</style>
<section aria-label="Interactive bubble sort">
  <h2>Bubble sort</h2>
  <p>Custom SVG-like bars with local algorithm state and step controls.</p>
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
            <main class="min-h-screen bg-background-primary px-6 py-8 text-text-primary">
                <div class="mx-auto grid max-w-5xl gap-8 md:grid-cols-2">
                    <section class="min-w-0 border-t-2 border-primary-700 pt-4">
                        <header class="mb-4 flex items-baseline justify-between gap-3">
                            <h1 class="text-base font-semibold">OpenUI Lang</h1>
                            <span class="text-xs text-text-tertiary">Registered components</span>
                        </header>
                        <OpenUIReply :response="openUIResponse" :is-streaming="false" />
                        <p class="mt-4 min-h-10 border-t border-border-subtle pt-3 text-xs text-text-secondary" aria-live="polite">{{ hostAction }}</p>
                    </section>
                    <section class="min-w-0 border-t-2 border-success-800 pt-4">
                        <header class="mb-2 flex items-baseline justify-between gap-3">
                            <h1 class="text-base font-semibold">Artifact</h1>
                            <span class="text-xs text-text-tertiary">Sandboxed HTML + JavaScript</span>
                        </header>
                        <VisualArtifactFrame :html="artifactHtml" title="Interactive bubble sort artifact" />
                    </section>
                </div>
            </main>
        `,
    }),
};
