/** Record navigation geometry before and after each frame's layout callbacks. */
export async function sampleConversationNavigation(railIndex, messageId, durationMs = 1200) {
    await browser.execute(
        (index, id, duration) => {
            const viewport = document.querySelector('[data-slot="message-scroller"] section');
            const buttons = document.querySelectorAll('[data-slot="message-scroller-rail-item"]');
            const samples = [];
            const started = performance.now();
            let firstFrameAt;
            const frameTasks = new MessageChannel();
            window.__navigationSamples = { done: false, samples };
            const readGeometry = () => {
                const target = viewport.querySelector(`[data-message-id="${CSS.escape(id)}"]`);
                const rect = target?.getBoundingClientRect();
                return {
                    top: rect ? rect.top - viewport.getBoundingClientRect().top : null,
                    height: rect?.height ?? null,
                    scrollTop: viewport.scrollTop,
                };
            };
            // rAF runs before ResizeObserver delivery. Keep both phases to locate
            // changes around resize delivery; neither phase alone proves a paint.
            frameTasks.port1.onmessage = ({ data: { index, final } }) => {
                samples[index].afterLayout = {
                    elapsed: performance.now() - started,
                    ...readGeometry(),
                };
                if (final) {
                    frameTasks.port1.close();
                    frameTasks.port2.close();
                    window.__navigationSamples.done = true;
                }
            };
            const sample = () => {
                const now = performance.now();
                firstFrameAt ??= now;
                samples.push({
                    elapsed: now - started,
                    ...readGeometry(),
                    viewportHeight: viewport.clientHeight,
                    mountedMessages: viewport.querySelectorAll('[data-message-id]').length,
                });
                const final = now - firstFrameAt >= duration;
                frameTasks.port2.postMessage({ index: samples.length - 1, final });
                if (!final) {
                    requestAnimationFrame(sample);
                }
            };
            requestAnimationFrame(sample);
            buttons[index].click();
        },
        railIndex,
        messageId,
        durationMs
    );
    await browser.waitUntil(() => browser.execute(() => window.__navigationSamples.done), {
        timeout: durationMs + 10_000,
        interval: 50,
    });
    return browser.execute(() => {
        const samples = window.__navigationSamples.samples;
        delete window.__navigationSamples;
        return samples;
    });
}

export function targetExcursionAfterArrival(samples) {
    const arrival = samples.findIndex(
        (sample) =>
            sample.top !== null &&
            sample.top >= 0 &&
            sample.top + sample.height <= sample.viewportHeight
    );
    if (arrival < 0) return Infinity;
    const arrived = samples.slice(arrival);
    if (arrived.some((sample) => sample.top === null)) return Infinity;
    const offsets = arrived.map((sample) => sample.top);
    return Math.max(...offsets) - Math.min(...offsets);
}
