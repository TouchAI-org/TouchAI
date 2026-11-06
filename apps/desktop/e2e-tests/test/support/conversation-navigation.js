/** Record the target's painted position, including intermediate frames during a rail jump. */
export async function sampleConversationNavigation(railIndex, messageId, durationMs = 1200) {
    await browser.execute(
        (index, id, duration) => {
            const viewport = document.querySelector('[data-slot="message-scroller"] section');
            const buttons = document.querySelectorAll('[data-slot="message-scroller-rail-item"]');
            const samples = [];
            const started = performance.now();
            let firstFrameAt;
            window.__navigationSamples = { done: false, samples };
            const sample = () => {
                const now = performance.now();
                firstFrameAt ??= now;
                const target = viewport.querySelector(`[data-message-id="${CSS.escape(id)}"]`);
                const rect = target?.getBoundingClientRect();
                const top = rect ? rect.top - viewport.getBoundingClientRect().top : null;
                samples.push({
                    elapsed: now - started,
                    top,
                    height: rect?.height ?? null,
                    viewportHeight: viewport.clientHeight,
                    scrollTop: viewport.scrollTop,
                    mountedMessages: viewport.querySelectorAll('[data-message-id]').length,
                });
                if (now - firstFrameAt < duration) {
                    requestAnimationFrame(sample);
                } else {
                    window.__navigationSamples.done = true;
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
