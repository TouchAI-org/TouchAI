export const RENDERER_MEASUREMENT_ELEMENT_ID = 'touchai-perf-measurement';
export const RAIL_NAVIGATION_ELEMENT_ID = 'touchai-perf-rail-navigation';

// This function is serialized into a <script> so it runs in the application's
// renderer world. WebDriver executes its own scripts in an isolated world that
// does not receive the application's keyboard events.
export function installRendererMeasurement(token) {
    const elementId = 'touchai-perf-measurement';
    const cleanupGlobal = '__TOUCHAI_PERF_MEASUREMENT_CLEANUP__';
    const maxFrameGaps = 60000;
    window[cleanupGlobal]?.();
    document.getElementById(elementId)?.remove();

    const stateElement = document.createElement('script');
    stateElement.type = 'application/json';
    stateElement.id = elementId;
    stateElement.hidden = true;
    (document.head ?? document.documentElement).append(stateElement);

    const existingAssistants = new Set(
        [...document.querySelectorAll("[data-message-role='assistant']")]
            .map((element) => element.getAttribute('data-message-id'))
            .filter((id) => id !== null)
    );
    const state = {
        token,
        armedAt: performance.now(),
        keydownAt: null,
        lastKeydown: null,
        startAt: null,
        startedEpochMs: null,
        firstTextAt: null,
        finalAt: null,
        result: null,
        settledResult: null,
        observer: null,
        onKeydown: null,
        frameRequest: null,
        lastFrameAt: null,
        frameCount: 0,
        frameGaps: [],
        frameGapsDropped: 0,
        idleFrameCount: 0,
        mutationCount: 0,
        checkCount: 0,
        sentinelSeenAt: null,
        sentinelSource: null,
        lastError: null,
        lastAssistantTextChars: 0,
        lastAssistantTextTail: '',
    };

    const requestFrame = (callback) =>
        typeof requestAnimationFrame === 'function'
            ? requestAnimationFrame(callback)
            : window.setTimeout(() => callback(performance.now()), 16);
    const cancelFrame = (frame) =>
        typeof cancelAnimationFrame === 'function'
            ? cancelAnimationFrame(frame)
            : window.clearTimeout(frame);

    const publish = () => {
        stateElement.textContent = JSON.stringify({
            token: state.token,
            armedAt: state.armedAt,
            keydownAt: state.keydownAt,
            lastKeydown: state.lastKeydown,
            startAt: state.startAt,
            startedEpochMs: state.startedEpochMs,
            firstTextAt: state.firstTextAt,
            finalAt: state.finalAt,
            result: state.result,
            settledResult: state.settledResult,
            checkCount: state.checkCount,
            sentinelSeenAt: state.sentinelSeenAt,
            sentinelSource: state.sentinelSource,
            lastError: state.lastError,
            lastAssistantTextChars: state.lastAssistantTextChars,
            lastAssistantTextTail: state.lastAssistantTextTail,
            frameCount: state.frameCount,
            mutationCount: state.mutationCount,
        });
    };

    const cleanup = () => {
        state.observer?.disconnect();
        state.observer = null;
        if (state.onKeydown) {
            window.removeEventListener('keydown', state.onKeydown, true);
            state.onKeydown = null;
        }
        if (state.frameRequest !== null) {
            cancelFrame(state.frameRequest);
            state.frameRequest = null;
        }
    };

    const assistantMessages = () => [
        ...document.querySelectorAll("[data-message-role='assistant']"),
    ];

    const conversationLog = () =>
        document.querySelector('[data-testid="conversation-panel-host"] [role="log"]') ??
        document.querySelector('[role="log"]');

    const measuredAssistant = (element) => {
        const id = element.getAttribute('data-message-id');
        return id === null || !existingAssistants.has(id);
    };

    const firstText = () => {
        const messages = assistantMessages();
        const latestMessage = messages[messages.length - 1];
        if (!latestMessage || !measuredAssistant(latestMessage)) return '';
        return [
            ...latestMessage.querySelectorAll('.assistant-message-parts > .assistant-message-part'),
        ]
            .filter(
                (element) =>
                    !element.querySelector('.reasoning-section') &&
                    !element.querySelector('.tool-call-log-wrapper')
            )
            .map((element) => (element.innerText ?? element.textContent ?? '').trim())
            .join('');
    };

    const sentinelSource = () => {
        const messages = assistantMessages();
        for (let index = messages.length - 1; index >= 0; index -= 1) {
            if (
                measuredAssistant(messages[index]) &&
                (messages[index].innerText ?? messages[index].textContent ?? '').includes(token)
            ) {
                return `assistant-innerText:${index}`;
            }
        }
        return null;
    };

    const frameGapSummary = () => {
        if (state.frameGaps.length === 0) {
            return {
                samples: 0,
                dropped: state.frameGapsDropped,
                p95Ms: null,
                maxMs: null,
                over50Ms: 0,
            };
        }
        const sorted = [...state.frameGaps].sort((left, right) => left - right);
        const index = (sorted.length - 1) * 0.95;
        const lower = Math.floor(index);
        const upper = Math.ceil(index);
        const p95Ms =
            lower === upper
                ? sorted[lower]
                : sorted[lower] * (1 - (index - lower)) + sorted[upper] * (index - lower);
        return {
            samples: sorted.length,
            dropped: state.frameGapsDropped,
            p95Ms,
            maxMs: sorted[sorted.length - 1],
            over50Ms: sorted.filter((gap) => gap > 50).length,
        };
    };

    const finalSnapshot = () => {
        const log = conversationLog();
        const viewport =
            log?.closest('[data-slot="message-scroller"]')?.querySelector('section') ??
            log?.parentElement ??
            null;
        const messages = assistantMessages();
        const latestAssistant = messages[messages.length - 1];
        const scrollHeight = viewport?.scrollHeight ?? null;
        const scrollTop = viewport?.scrollTop ?? null;
        const clientHeight = viewport?.clientHeight ?? null;
        return {
            busy: log?.getAttribute('aria-busy') ?? null,
            atEnd:
                scrollHeight !== null &&
                scrollTop !== null &&
                clientHeight !== null &&
                scrollHeight - scrollTop - clientHeight <= 5,
            scrollTop,
            scrollHeight,
            clientHeight,
            domNodes: document.querySelectorAll('*').length,
            messageCount: document.querySelectorAll('[data-message-role]').length,
            bodyTextChars: document.body.textContent?.length ?? 0,
            assistantTextChars: latestAssistant?.textContent?.length ?? 0,
            railTicks: document.querySelectorAll('[data-slot="message-scroller-rail-item"]').length,
        };
    };

    const finish = () => {
        if (
            state.result !== null ||
            state.startAt === null ||
            state.keydownAt === null ||
            state.startedEpochMs === null ||
            state.sentinelSeenAt === null ||
            state.sentinelSource === null
        ) {
            return;
        }
        state.finalAt = state.sentinelSeenAt;
        state.result = {
            startAt: state.startAt,
            armedAt: state.armedAt,
            keydownAt: state.keydownAt,
            lastKeydown: state.lastKeydown,
            startedEpochMs: state.startedEpochMs,
            firstTextAt: state.firstTextAt,
            finalAt: state.finalAt,
            durationMs: state.finalAt - state.startAt,
            firstTextMs: state.firstTextAt === null ? null : state.firstTextAt - state.startAt,
            domNodes: document.querySelectorAll('*').length,
            messageCount: document.querySelectorAll('[data-message-role]').length,
            bodyTextChars: document.body.textContent?.length ?? 0,
            sentinelSource: state.sentinelSource,
            sentinelSeenAt: state.sentinelSeenAt,
        };
        publish();
    };

    const finishSettled = (at) => {
        if (state.result === null || state.settledResult !== null) return;
        const frames = frameGapSummary();
        state.settledResult = {
            ...finalSnapshot(),
            durationMs: at - state.startAt,
            settleMs: at - state.result.sentinelSeenAt,
            mutationCount: state.mutationCount,
            frameCount: state.frameCount,
            frameGapSamples: frames.samples,
            frameGapDropped: frames.dropped,
            frameGapP95Ms: frames.p95Ms,
            frameGapMaxMs: frames.maxMs,
            frameGapOver50Ms: frames.over50Ms,
        };
        cleanup();
        publish();
    };

    const check = (shouldPublish = true) => {
        if (state.startAt === null) {
            if (shouldPublish) publish();
            return;
        }
        try {
            state.checkCount += 1;
            const messages = assistantMessages();
            const latestMessage = messages[messages.length - 1];
            const latestText = latestMessage?.textContent ?? '';
            state.lastAssistantTextChars = latestText.length;
            state.lastAssistantTextTail = latestText.slice(-192);
            if (state.firstTextAt === null && firstText().length > 0) {
                state.firstTextAt = performance.now();
            }
            if (state.result === null && state.sentinelSeenAt === null) {
                const source = sentinelSource();
                if (source) {
                    state.sentinelSource = source;
                    state.sentinelSeenAt = performance.now();
                    finish();
                }
            }
            if (shouldPublish) publish();
        } catch (error) {
            state.lastError = String(error);
            if (shouldPublish) publish();
        }
    };

    const onFrame = () => {
        state.frameRequest = null;
        if (state.startAt === null || state.settledResult !== null) return;
        const frameAt = performance.now();
        state.frameCount += 1;
        if (state.lastFrameAt !== null) {
            const gap = frameAt - state.lastFrameAt;
            if (state.frameGaps.length < maxFrameGaps) {
                state.frameGaps.push(gap);
            } else {
                state.frameGapsDropped += 1;
            }
        }
        state.lastFrameAt = frameAt;
        check(false);
        if (state.result !== null && conversationLog()?.getAttribute('aria-busy') === 'false') {
            state.idleFrameCount += 1;
            if (state.idleFrameCount >= 2) {
                finishSettled(performance.now());
                return;
            }
        } else {
            state.idleFrameCount = 0;
        }
        state.frameRequest = requestFrame(onFrame);
    };

    state.onKeydown = (event) => {
        if (event.key !== 'Enter') return;
        const at = performance.now();
        state.lastKeydown = {
            at,
            isComposing: event.isComposing,
            shiftKey: event.shiftKey,
            targetTag: event.target instanceof Element ? event.target.tagName : null,
            targetClass:
                event.target instanceof Element && typeof event.target.className === 'string'
                    ? event.target.className
                    : null,
        };
        if (!event.shiftKey && state.keydownAt === null) {
            state.keydownAt = at;
            state.startAt = at;
            state.startedEpochMs = performance.timeOrigin + at;
            state.lastFrameAt = null;
            check();
            state.frameRequest = requestFrame(onFrame);
        }
    };

    window.addEventListener('keydown', state.onKeydown, true);
    state.observer = new MutationObserver(() => {
        state.mutationCount += 1;
        check();
    });
    state.observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
    });
    window[cleanupGlobal] = cleanup;
    publish();
    check();
}

// Serialized into the application renderer for native rail navigation evidence.
export function installRailNavigationMeasurement(turnCount, expectedTicks, timeoutMs = 5000) {
    const elementId = 'touchai-perf-rail-navigation';
    document.getElementById(elementId)?.remove();

    const stateElement = document.createElement('script');
    stateElement.type = 'application/json';
    stateElement.id = elementId;
    stateElement.hidden = true;
    (document.head ?? document.documentElement).append(stateElement);

    const publish = (value) => {
        stateElement.textContent = JSON.stringify(value);
    };
    const requestFrame = () =>
        new Promise((resolve) => {
            if (typeof requestAnimationFrame === 'function') {
                requestAnimationFrame(resolve);
            } else {
                window.setTimeout(resolve, 16);
            }
        });
    const waitFor = async (predicate) => {
        const startedAt = performance.now();
        while (!predicate()) {
            if (performance.now() - startedAt > timeoutMs) {
                throw new Error('Rail navigation did not settle before the timeout.');
            }
            await requestFrame();
        }
        await requestFrame();
        await requestFrame();
    };

    const run = async () => {
        const rail = document.querySelector('[data-slot="message-scroller-rail"]');
        const scroller = rail?.closest('[data-slot="message-scroller"]');
        const viewport =
            scroller?.querySelector('section') ??
            scroller?.querySelector('[role="log"]')?.parentElement;
        const ticks = rail
            ? [...rail.querySelectorAll('[data-slot="message-scroller-rail-item"]')]
            : [];
        if (!rail || !viewport || ticks.length < 2) {
            throw new Error('The native conversation rail is missing or too short.');
        }
        if (ticks.length !== expectedTicks) {
            throw new Error(
                `The native conversation rail has ${ticks.length} ticks; expected ${expectedTicks} for ${turnCount} turns.`
            );
        }

        const current = () =>
            rail.querySelector('[data-slot="message-scroller-rail-item"][aria-current="location"]');
        const focusTick = (tick) => {
            try {
                tick.focus({ preventScroll: true });
            } catch {
                tick.focus();
            }
        };
        const waitForScrollSettled = async (tick) => {
            let lastTop = viewport.scrollTop;
            let stableFrames = 0;
            await waitFor(() => {
                const top = viewport.scrollTop;
                stableFrames = Math.abs(top - lastTop) <= 0.5 ? stableFrames + 1 : 0;
                lastTop = top;
                return current() === tick && stableFrames >= 2;
            });
        };
        // Normalize to the true transcript end before the measured trip. Rail
        // selection centers its destination, so the last tick is not page end.
        viewport.scrollTop = viewport.scrollHeight;
        await waitForScrollSettled(ticks[ticks.length - 1]);

        const measure = async (target, tick, index) => {
            focusTick(tick);
            const focusedBefore = document.activeElement === tick;
            const scrollTopBefore = viewport.scrollTop;
            const startedAt = performance.now();
            tick.click();
            await waitForScrollSettled(tick);
            const scrollTopAfter = viewport.scrollTop;
            return {
                target,
                targetIndex: index,
                durationMs: performance.now() - startedAt,
                scrollTopBefore,
                scrollTopAfter,
                endDistanceAfter: Math.max(
                    0,
                    viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
                ),
                moved:
                    target === 'first'
                        ? scrollTopBefore > scrollTopAfter
                        : scrollTopBefore < scrollTopAfter,
                focusedBefore,
                focusedAfter: document.activeElement === tick,
                activeTarget: tick.getAttribute('aria-current') === 'location',
            };
        };

        const steps = [
            await measure('first', ticks[0], 0),
            await measure('last', ticks[ticks.length - 1], ticks.length - 1),
        ];
        return {
            turnCount,
            tickCount: ticks.length,
            sampled: ticks.length < turnCount,
            steps,
        };
    };

    publish({ running: true });
    void run()
        .then((result) => publish({ result }))
        .catch((error) => publish({ error: String(error) }));
}
