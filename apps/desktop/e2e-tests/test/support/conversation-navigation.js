/** Record navigation geometry before and after each frame's layout callbacks. */
export async function sampleConversationNavigation(railIndex, messageId, durationMs = 1200) {
    try {
        await browser.execute(
            (index, id, duration) => {
                const viewport = document.querySelector('[data-slot="message-scroller"] section');
                const buttons = document.querySelectorAll(
                    '[data-slot="message-scroller-rail-item"]'
                );
                const samples = [];
                const writes = [];
                const layoutChanges = [];
                const started = performance.now();
                let firstFrameAt;
                let frame;
                const frameTasks = new MessageChannel();
                const restorers = [];
                const environment = {
                    userAgent: navigator.userAgent,
                    devicePixelRatio,
                    innerWidth,
                    innerHeight,
                    visibilityState: document.visibilityState,
                };
                const replace = (name, descriptor) => {
                    const original = Object.getOwnPropertyDescriptor(viewport, name);
                    Object.defineProperty(viewport, name, { configurable: true, ...descriptor });
                    restorers.push(() => {
                        if (original) Object.defineProperty(viewport, name, original);
                        else delete viewport[name];
                    });
                };
                const recordWrite = (kind, requested, write) => {
                    if (writes.length >= 80) return write();
                    const entry = {
                        elapsed: performance.now() - started,
                        kind,
                        requested,
                        before: viewport.scrollTop,
                        stack: new Error().stack?.split('\n').slice(2, 8),
                    };
                    const result = write();
                    entry.after = viewport.scrollTop;
                    writes.push(entry);
                    return result;
                };
                // Instrument only this fixture's viewport, keeping native scrolling semantics.
                const scrollTop = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
                replace('scrollTop', {
                    get: scrollTop.get,
                    set(value) {
                        recordWrite('scrollTop', value, () => scrollTop.set.call(this, value));
                    },
                });
                for (const name of ['scrollBy', 'scrollTo']) {
                    const original = viewport[name];
                    replace(name, {
                        value(...args) {
                            return recordWrite(name, args, () => original.apply(this, args));
                        },
                    });
                }
                const observer = new MutationObserver((records) => {
                    for (const { target } of records) {
                        const messageId = target.firstElementChild?.dataset.messageId;
                        if (!messageId || layoutChanges.length >= 160) continue;
                        // Inline offsets identify virtualizer updates without forcing layout.
                        layoutChanges.push({
                            elapsed: performance.now() - started,
                            id: messageId,
                            top: target.style.top,
                            visibility: target.style.visibility,
                        });
                    }
                });
                observer.observe(viewport, {
                    attributes: true,
                    attributeFilter: ['style'],
                    subtree: true,
                });
                const cleanup = () => {
                    cancelAnimationFrame(frame);
                    observer.disconnect();
                    frameTasks.port1.close();
                    frameTasks.port2.close();
                    for (const restore of restorers.splice(0)) restore();
                };
                window.__navigationSamples = {
                    done: false,
                    samples,
                    writes,
                    layoutChanges,
                    environment,
                    cleanup,
                };
                const readGeometry = () => {
                    const target = viewport.querySelector(`[data-message-id="${CSS.escape(id)}"]`);
                    const rect = target?.getBoundingClientRect();
                    return {
                        top: rect ? rect.top - viewport.getBoundingClientRect().top : null,
                        height: rect?.height ?? null,
                        visible:
                            target?.checkVisibility({
                                opacityProperty: true,
                                visibilityProperty: true,
                            }) ?? false,
                        scrollTop: viewport.scrollTop,
                        items: Array.from(viewport.querySelectorAll('[data-message-id]')).map(
                            (element) => ({
                                id: element.dataset.messageId,
                                top: element.parentElement.style.top,
                                height: element.getBoundingClientRect().height,
                                visibility: element.parentElement.style.visibility,
                            })
                        ),
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
                        cleanup();
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
                        frame = requestAnimationFrame(sample);
                    }
                };
                frame = requestAnimationFrame(sample);
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
        return await browser.execute(() => {
            const { samples, writes, layoutChanges, environment } = window.__navigationSamples;
            return { samples, writes, layoutChanges, environment };
        });
    } finally {
        await browser.execute(() => {
            window.__navigationSamples?.cleanup();
            delete window.__navigationSamples;
        });
    }
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
