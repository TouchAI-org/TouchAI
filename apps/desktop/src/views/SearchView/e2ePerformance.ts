// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

interface PerfKeyboardEvent {
    at: number;
    isComposing: boolean;
    shiftKey: boolean;
    targetTag: string | null;
    targetClass: string | null;
}

export interface E2ePerfMeasurementResult {
    startAt: number;
    armedAt: number;
    keydownAt: number;
    lastKeydown: PerfKeyboardEvent;
    startedEpochMs: number;
    firstTextAt: number | null;
    finalAt: number;
    durationMs: number;
    firstTextMs: number | null;
    domNodes: number;
    messageCount: number;
    bodyTextChars: number;
    sentinelSource: string;
    sentinelSeenAt: number;
}

export interface E2ePerfMeasurementSnapshot {
    token: string;
    armedAt: number;
    keydownAt: number | null;
    lastKeydown: PerfKeyboardEvent | null;
    startAt: number | null;
    startedEpochMs: number | null;
    firstTextAt: number | null;
    finalAt: number | null;
    result: E2ePerfMeasurementResult | null;
    checkCount: number;
    sentinelSeenAt: number | null;
    sentinelSource: string | null;
    lastError: string | null;
    lastAssistantTextChars: number;
    lastAssistantTextTail: string;
}

interface MeasurementState {
    token: string;
    armedAt: number;
    keydownAt: number | null;
    lastKeydown: PerfKeyboardEvent | null;
    startAt: number | null;
    startedEpochMs: number | null;
    firstTextAt: number | null;
    finalAt: number | null;
    result: E2ePerfMeasurementResult | null;
    observer: MutationObserver | null;
    onKeydown: ((event: KeyboardEvent) => void) | null;
    checkCount: number;
    sentinelSeenAt: number | null;
    sentinelSource: string | null;
    lastError: string | null;
    lastAssistantTextChars: number;
    lastAssistantTextTail: string;
    existingAssistants: Set<string>;
}

export interface E2ePerfMeasurement {
    arm(token: string): void;
    snapshot(): E2ePerfMeasurementSnapshot | null;
    dispose(): void;
}

function elementText(element: Element): string {
    const innerText = (element as HTMLElement).innerText;
    return innerText ?? element.textContent ?? '';
}

export function createE2ePerfMeasurement(): E2ePerfMeasurement {
    let state: MeasurementState | null = null;

    const cleanup = () => {
        if (!state) return;
        state.observer?.disconnect();
        if (state.onKeydown) {
            window.removeEventListener('keydown', state.onKeydown, true);
        }
    };

    const assistantMessages = () => [
        ...document.querySelectorAll<HTMLElement>("[data-message-role='assistant']"),
    ];

    const firstText = () => {
        if (!state) return '';
        const messages = assistantMessages();
        const latestMessage = messages[messages.length - 1];
        const messageId = latestMessage?.getAttribute('data-message-id') ?? null;
        if (!latestMessage || (messageId !== null && state.existingAssistants.has(messageId))) {
            return '';
        }
        return [
            ...latestMessage.querySelectorAll<HTMLElement>(
                '.assistant-message-parts > .assistant-message-part'
            ),
        ]
            .filter(
                (element) =>
                    !element.querySelector('.reasoning-section') &&
                    !element.querySelector('.tool-call-log-wrapper')
            )
            .map((element) => elementText(element).trim())
            .join('');
    };

    const sentinelSource = (token: string) => {
        const messages = assistantMessages();
        for (let index = messages.length - 1; index >= 0; index -= 1) {
            if (elementText(messages[index]!).includes(token)) {
                return `assistant-innerText:${index}`;
            }
        }
        return null;
    };

    const finish = () => {
        if (!state || state.result !== null) return;
        const startAt = state.startAt;
        const keydownAt = state.keydownAt;
        const startedEpochMs = state.startedEpochMs;
        if (startAt === null || keydownAt === null || startedEpochMs === null) return;
        const finalAt = state.sentinelSeenAt ?? performance.now();
        if (state.sentinelSeenAt === null || state.sentinelSource === null) return;
        state.finalAt = finalAt;
        state.result = {
            startAt,
            armedAt: state.armedAt,
            keydownAt,
            lastKeydown: state.lastKeydown!,
            startedEpochMs,
            firstTextAt: state.firstTextAt,
            finalAt,
            durationMs: finalAt - startAt,
            firstTextMs: state.firstTextAt === null ? null : state.firstTextAt - startAt,
            domNodes: document.querySelectorAll('*').length,
            messageCount: document.querySelectorAll('[data-message-role]').length,
            bodyTextChars: document.body.textContent?.length ?? 0,
            sentinelSource: state.sentinelSource,
            sentinelSeenAt: state.sentinelSeenAt,
        };
        cleanup();
    };

    const check = () => {
        if (!state || state.startAt === null) return;
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
            if (state.result !== null || state.sentinelSeenAt !== null) return;
            const source = sentinelSource(state.token);
            if (source) {
                state.sentinelSource = source;
                state.sentinelSeenAt = performance.now();
                setTimeout(finish, 0);
            }
        } catch (error) {
            state.lastError = String(error);
        }
    };

    const arm = (token: string) => {
        cleanup();
        const measurement: MeasurementState = {
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
            existingAssistants: new Set(
                assistantMessages()
                    .map((element) => element.getAttribute('data-message-id'))
                    .filter((id): id is string => id !== null)
            ),
        };
        state = measurement;
        measurement.onKeydown = (event) => {
            if (event.key !== 'Enter') return;
            const at = performance.now();
            measurement.lastKeydown = {
                at,
                isComposing: event.isComposing,
                shiftKey: event.shiftKey,
                targetTag: event.target instanceof Element ? event.target.tagName : null,
                targetClass:
                    event.target instanceof Element
                        ? typeof event.target.className === 'string'
                            ? event.target.className
                            : null
                        : null,
            };
            if (!event.shiftKey && measurement.keydownAt === null) {
                measurement.keydownAt = at;
                measurement.startAt = at;
                measurement.startedEpochMs = performance.timeOrigin + at;
            }
        };
        window.addEventListener('keydown', measurement.onKeydown, true);
        measurement.observer = new MutationObserver(check);
        measurement.observer.observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true,
        });
        check();
    };

    const snapshot = (): E2ePerfMeasurementSnapshot | null => {
        if (!state) return null;
        check();
        return {
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
        };
    };

    const dispose = () => {
        cleanup();
        state = null;
    };

    return { arm, snapshot, dispose };
}
