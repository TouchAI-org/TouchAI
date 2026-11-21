export const RENDERER_MEASUREMENT_ELEMENT_ID = 'touchai-perf-measurement';

// This function is serialized into a <script> so it runs in the application's
// renderer world. WebDriver executes its own scripts in an isolated world that
// does not receive the application's keyboard events.
export function installRendererMeasurement(token) {
    const elementId = 'touchai-perf-measurement';
    const cleanupGlobal = '__TOUCHAI_PERF_MEASUREMENT_CLEANUP__';
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
        observer: null,
        onKeydown: null,
        checkCount: 0,
        sentinelSeenAt: null,
        sentinelSource: null,
        lastError: null,
        lastAssistantTextChars: 0,
        lastAssistantTextTail: '',
    };

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
            checkCount: state.checkCount,
            sentinelSeenAt: state.sentinelSeenAt,
            sentinelSource: state.sentinelSource,
            lastError: state.lastError,
            lastAssistantTextChars: state.lastAssistantTextChars,
            lastAssistantTextTail: state.lastAssistantTextTail,
        });
    };

    const cleanup = () => {
        state.observer?.disconnect();
        state.observer = null;
        if (state.onKeydown) {
            window.removeEventListener('keydown', state.onKeydown, true);
            state.onKeydown = null;
        }
    };

    const assistantMessages = () => [
        ...document.querySelectorAll("[data-message-role='assistant']"),
    ];

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
        cleanup();
        publish();
    };

    const check = () => {
        if (state.startAt === null) {
            publish();
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
            publish();
        } catch (error) {
            state.lastError = String(error);
            publish();
        }
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
            check();
        }
    };

    window.addEventListener('keydown', state.onKeydown, true);
    state.observer = new MutationObserver(check);
    state.observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
    });
    window[cleanupGlobal] = cleanup;
    publish();
    check();
}
