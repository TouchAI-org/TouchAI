import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const flow = process.env.TOUCHAI_PERF_FLOW ?? '';
const arm = process.env.TOUCHAI_PERF_ARM ?? '';
const runId = process.env.TOUCHAI_PERF_RUN_ID ?? '';
const block = process.env.TOUCHAI_PERF_BLOCK ?? '';
const eventsFile = process.env.TOUCHAI_PERF_EVENTS ?? '';
const historyLevel = Number(process.env.TOUCHAI_PERF_HISTORY_LEVEL) || 0;
const warmSampleCount =
    process.env.TOUCHAI_PERF_WARM_SAMPLES === undefined
        ? 8
        : Math.max(0, Number(process.env.TOUCHAI_PERF_WARM_SAMPLES) || 0);
const progressWarmupTasks = Number(process.env.TOUCHAI_PERF_PROGRESS_WARMUPS) || 4;
const progressMeasuredTasks = Number(process.env.TOUCHAI_PERF_PROGRESS_TASKS) || 16;
const startupSettleMs = Number(process.env.TOUCHAI_PERF_STARTUP_SETTLE_MS) || 8000;

function appendEvent(value) {
    if (!eventsFile) return;
    fs.mkdirSync(path.dirname(eventsFile), { recursive: true });
    fs.appendFileSync(
        eventsFile,
        `${JSON.stringify({
            at: Date.now(),
            arm,
            runId,
            block,
            flow,
            ...value,
        })}\n`
    );
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function promptId(sample) {
    return `${arm[0]}-${block}-${sample}-${Date.now().toString(36)}`;
}

function doneTokenFor(id) {
    return `PERF710_DONE_${createHash('sha256').update(id).digest('hex').slice(0, 16)}`;
}

async function waitForMainWindow() {
    await browser.waitUntil(
        async () =>
            await browser.execute(() =>
                Boolean(document.querySelector("[data-testid='search-view']"))
            ),
        {
            timeout: 60000,
            timeoutMsg: 'The main search view did not become visible.',
        }
    );
    const editor = await $("[data-testid='search-editor-host'] .ProseMirror");
    await editor.waitForDisplayed({ timeout: 60000 });
}

async function clearEditor() {
    await focusEditorDom();
    await browser.keys(['Control', 'a']);
    await browser.keys(['Backspace']);
    await browser.waitUntil(
        async () =>
            await browser.execute(() => {
                const editorElement = document.querySelector(
                    "[data-testid='search-editor-host'] .ProseMirror"
                );
                return (editorElement?.textContent ?? '').trim().length === 0;
            }),
        {
            timeout: 15000,
            timeoutMsg: 'The prompt editor did not clear.',
        }
    );
}

async function typePrompt(prompt) {
    let lastActual = '';
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        await clearEditor();
        await focusEditorDom();
        let keystrokes = 0;
        if (attempt === 1) {
            await browser.keys([prompt]);
            keystrokes = prompt.length;
            await sleep(250);
        }
        while (keystrokes < prompt.length * 4) {
            lastActual = await browser.execute(() => {
                const editorElement = document.querySelector(
                    "[data-testid='search-editor-host'] .ProseMirror"
                );
                return editorElement?.textContent ?? '';
            });
            if (lastActual === prompt) return;
            if (!prompt.startsWith(lastActual)) break;
            if (attempt === 1) break;

            const expectedBefore = lastActual;
            const character = prompt[lastActual.length];
            await browser.keys([character]);
            keystrokes += 1;
            try {
                await browser.waitUntil(
                    async () =>
                        await browser.execute((before) => {
                            const editorElement = document.querySelector(
                                "[data-testid='search-editor-host'] .ProseMirror"
                            );
                            return (editorElement?.textContent ?? '') !== before;
                        }, expectedBefore),
                    {
                        timeout: 750,
                        interval: 25,
                        timeoutMsg: 'The prompt editor did not accept the next keyboard character.',
                    }
                );
            } catch {
                // Retry from the latest DOM value; a dropped key remains a prefix.
            }
        }
        lastActual = await browser.execute(() => {
            const editorElement = document.querySelector(
                "[data-testid='search-editor-host'] .ProseMirror"
            );
            return editorElement?.textContent ?? '';
        });
        if (lastActual === prompt) return;
        appendEvent({
            type: 'prompt-input-retry',
            attempt,
            keystrokes,
            expectedChars: prompt.length,
            actualChars: lastActual.length,
            actualTail: lastActual.slice(-96),
        });
    }
    throw new Error(
        `The prompt editor did not receive the exact performance prompt after 3 attempts. ` +
            `Expected ${prompt.length} chars, received ${lastActual.length}; tail=${JSON.stringify(
                lastActual.slice(-96)
            )}`
    );
}

async function armRendererMeasurement(doneToken) {
    await browser.execute((token) => {
        const state = {
            token,
            armedAt: null,
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

        const cleanup = () => {
            state.observer?.disconnect();
            document.removeEventListener('keydown', state.onKeydown, true);
        };

        const assistantMessages = () => [
            ...document.querySelectorAll("[data-message-role='assistant']"),
        ];

        const firstText = () => {
            const messages = assistantMessages();
            const latestMessage = messages.at(-1);
            if (!latestMessage) return '';
            const parts = [
                ...latestMessage.querySelectorAll(
                    '.assistant-message-parts > .assistant-message-part'
                ),
            ];
            return parts
                .filter(
                    (element) =>
                        !element.querySelector('.reasoning-section') &&
                        !element.querySelector('.tool-call-log-wrapper')
                )
                .map((element) => (element.textContent ?? '').trim())
                .join('');
        };

        const sentinelSource = () => {
            const messages = assistantMessages();
            for (let index = messages.length - 1; index >= 0; index -= 1) {
                if ((messages[index].textContent ?? '').includes(token)) {
                    return `assistant-textContent:${index}`;
                }
            }
            if ((document.body.innerText ?? '').includes(token)) {
                return 'body-innerText';
            }
            return null;
        };

        const finish = () => {
            if (state.result !== null) return;
            state.finalAt = state.sentinelSeenAt ?? performance.now();
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
        };

        const check = () => {
            if (state.startAt === null) return;
            try {
                state.checkCount += 1;
                const messages = assistantMessages();
                const latestMessage = messages.at(-1);
                const latestText = latestMessage?.textContent ?? '';
                state.lastAssistantTextChars = latestText.length;
                state.lastAssistantTextTail = latestText.slice(-192);
                if (state.firstTextAt === null && firstText().length > 0) {
                    state.firstTextAt = performance.now();
                }
                if (state.result !== null || state.sentinelSeenAt !== null) return;
                const source = sentinelSource();
                if (source) {
                    state.sentinelSource = source;
                    state.sentinelSeenAt = performance.now();
                    setTimeout(() => {
                        if (state.result === null) finish();
                    }, 0);
                }
            } catch (error) {
                state.lastError = String(error);
            }
        };

        state.onKeydown = (event) => {
            if (event.key !== 'Enter') return;
            const at = performance.now();
            state.lastKeydown = {
                at,
                isComposing: event.isComposing,
                shiftKey: event.shiftKey,
                targetTag: event.target?.tagName ?? null,
                targetClass: event.target?.className ?? null,
            };
            if (!event.shiftKey && state.keydownAt === null) {
                state.keydownAt = at;
                state.startAt = state.keydownAt;
                state.startedEpochMs = performance.timeOrigin + state.startAt;
            }
        };

        state.checkNow = check;
        state.armedAt = performance.now();
        state.startAt = state.armedAt;
        state.startedEpochMs = performance.timeOrigin + state.startAt;
        document.addEventListener('keydown', state.onKeydown, true);
        state.observer = new MutationObserver(check);
        state.observer.observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true,
        });
        window.__PERF710_STATE__ = state;
        check();
    }, doneToken);
}

async function ensureSearchSurface() {
    const inspect = () =>
        browser.execute(() => {
            const trigger = document.querySelector('button[data-history-trigger="true"]');
            return {
                historyTriggerActive:
                    trigger instanceof HTMLButtonElement &&
                    trigger.classList.contains('toolbar-button--active'),
                historyTriggerDisabled:
                    trigger instanceof HTMLButtonElement ? trigger.disabled : null,
                activeElement: document.activeElement?.tagName ?? null,
                activeElementClass: document.activeElement?.className ?? null,
                editorText:
                    document.querySelector("[data-testid='search-editor-host'] .ProseMirror")
                        ?.textContent ?? null,
                messageCount: document.querySelectorAll('[data-message-role]').length,
            };
        });

    let state = await inspect();
    appendEvent({ type: 'search-surface-check', phase: 'before', ...state });
    if (state.historyTriggerActive) {
        await clickSelector(
            'button[data-history-trigger="true"]',
            'The active history popup trigger could not be closed.',
            60000
        );
        await browser.waitUntil(
            async () =>
                await browser.execute(
                    () =>
                        !document
                            .querySelector('button[data-history-trigger="true"]')
                            ?.classList.contains('toolbar-button--active')
                ),
            {
                timeout: 60000,
                interval: 100,
                timeoutMsg: 'The session history surface did not close.',
            }
        );
        state = await inspect();
        appendEvent({ type: 'search-surface-check', phase: 'after-close', ...state });
    }
    if (state.historyTriggerActive) {
        throw new Error('The search surface is still covered by the session history popup.');
    }
    await focusEditorDom();
    return state;
}

/**
 * Focus the prompt editor without clicking a cached WebDriver element.
 *
 * A session reset can detach the editor node while WebKitWebDriver still holds
 * its old element id. Clicking that id can hang for the full connection timeout
 * instead of returning a stale-element error. A DOM focus is immediate, works
 * for both the initial and re-created editor, and keeps keyboard input targeted.
 */
async function focusEditorDom() {
    const focused = await browser.execute(() => {
        const editorElement = document.querySelector(
            "[data-testid='search-editor-host'] .ProseMirror"
        );
        if (!(editorElement instanceof HTMLElement)) return false;
        editorElement.focus();
        return (
            document.activeElement === editorElement ||
            editorElement.contains(document.activeElement)
        );
    });
    if (!focused) {
        throw new Error('The prompt editor could not receive keyboard focus.');
    }
}

function timeoutAfter(milliseconds, message) {
    return new Promise((_, reject) => {
        setTimeout(() => reject(new Error(message)), milliseconds);
    });
}

async function captureSentinelTimeout(doneToken, error) {
    let diagnostic;
    try {
        diagnostic = await Promise.race([
            browser.execute((token) => {
                const state = window.__PERF710_STATE__ ?? null;
                const assistantMessages = [
                    ...document.querySelectorAll("[data-message-role='assistant']"),
                ];
                const assistants = assistantMessages.map((element, index) => {
                    const text = element.textContent ?? '';
                    return {
                        index,
                        chars: text.length,
                        hasToken: text.includes(token),
                        tail: text.slice(-256),
                    };
                });
                const bodyText = document.body.textContent ?? '';
                const bodyInnerText = document.body.innerText ?? '';
                return {
                    state: state
                        ? {
                              token: state.token,
                              armedAt: state.armedAt,
                              keydownAt: state.keydownAt,
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
                          }
                        : null,
                    assistants,
                    bodyTextHasToken: bodyText.includes(token),
                    bodyInnerTextHasToken: bodyInnerText.includes(token),
                    bodyTextChars: bodyText.length,
                    bodyTextTail: bodyText.slice(-512),
                    bodyInnerTextChars: bodyInnerText.length,
                    bodyInnerTextTail: bodyInnerText.slice(-512),
                };
            }, doneToken),
            timeoutAfter(30000, 'Timed out while collecting renderer sentinel diagnostics.'),
        ]);
    } catch (diagnosticError) {
        diagnostic = {
            diagnosticError: String(diagnosticError),
        };
    }

    const evidenceDirectory =
        process.env.TOUCHAI_PERF_RUN_LOG_DIR ||
        (eventsFile ? path.dirname(eventsFile) : process.cwd());
    fs.mkdirSync(evidenceDirectory, { recursive: true });
    const artifactBase = path.join(evidenceDirectory, `${runId || 'perf'}-sentinel-timeout`);
    fs.writeFileSync(`${artifactBase}.json`, `${JSON.stringify(diagnostic, null, 2)}\n`);
    appendEvent({
        type: 'renderer-sentinel-timeout',
        error: String(error),
        diagnosticPath: `${artifactBase}.json`,
        screenshotPath: null,
    });
    return { diagnostic, diagnosticPath: `${artifactBase}.json`, screenshotPath: null };
}

async function waitRendererMeasurement(doneToken, timeoutMs = 180000) {
    try {
        await Promise.race([
            browser.waitUntil(
                async () =>
                    await browser.execute(() => {
                        const state = window.__PERF710_STATE__;
                        state?.checkNow?.();
                        return Boolean(state?.result);
                    }),
                {
                    timeout: timeoutMs,
                    timeoutMsg: 'The renderer did not reach the performance sentinel.',
                }
            ),
            timeoutAfter(
                timeoutMs + 1000,
                `The renderer did not reach the performance sentinel within ${timeoutMs}ms.`
            ),
        ]);
    } catch (error) {
        const evidence = await captureSentinelTimeout(doneToken, error);
        throw new Error(
            `${error instanceof Error ? error.message : String(error)} ` +
                `Diagnostics: ${evidence.diagnosticPath}; screenshot: ${
                    evidence.screenshotPath ?? 'unavailable'
                }`,
            { cause: error }
        );
    }
    const result = await browser.execute(() => {
        const value = window.__PERF710_STATE__?.result ?? null;
        delete window.__PERF710_STATE__;
        return value;
    });
    if (!result || typeof result.durationMs !== 'number') {
        throw new Error('Renderer performance result was missing.');
    }
    return result;
}

async function waitForSessionSettled(timeoutMs = 120000) {
    await browser.waitUntil(
        async () =>
            await browser.execute(() => {
                const button = document.querySelector(
                    ".toolbar-fade-overlay button[data-drag-exclude='true']"
                );
                return Boolean(button) && !button.classList.contains('toolbar-button--disabled');
            }),
        {
            timeout: timeoutMs,
            timeoutMsg: 'The task did not settle after the sentinel appeared.',
        }
    );
}

async function focusPromptEditor() {
    const focus = await browser.execute(() => {
        const editorElement = document.querySelector(
            "[data-testid='search-editor-host'] .ProseMirror"
        );
        if (!(editorElement instanceof HTMLElement)) {
            return {
                focused: false,
                activeElement: document.activeElement?.tagName ?? null,
                activeElementClass: document.activeElement?.className ?? null,
                editorText: null,
                messageCount: document.querySelectorAll('[data-message-role]').length,
            };
        }
        editorElement.focus();
        const focused =
            document.activeElement === editorElement ||
            editorElement.contains(document.activeElement);
        const state = window.__PERF710_STATE__;
        if (state) {
            const startAt = performance.now();
            state.startAt = startAt;
            state.startedEpochMs = performance.timeOrigin + startAt;
        }
        const historyTrigger = document.querySelector('button[data-history-trigger="true"]');
        return {
            focused,
            activeElement: document.activeElement?.tagName ?? null,
            activeElementClass: document.activeElement?.className ?? null,
            editorText: editorElement.textContent ?? '',
            messageCount: document.querySelectorAll('[data-message-role]').length,
            historyTriggerActive:
                historyTrigger instanceof HTMLButtonElement &&
                historyTrigger.classList.contains('toolbar-button--active'),
        };
    });
    if (!focus.focused) {
        throw new Error('The prompt editor could not receive keyboard focus before submission.');
    }
    return focus;
}

async function submitAndMeasure(sample, options = {}) {
    const id = promptId(sample);
    const doneToken = doneTokenFor(id);
    const rounds = options.rounds ?? 12;
    const chunks = options.chunks ?? 24;
    const chunkBytes = options.chunkBytes ?? 24;
    const alternate = options.alternate ? 1 : 0;
    const marker = [
        'PERF710',
        `flow=${flow}`,
        `promptId=${id}`,
        `rounds=${rounds}`,
        `chunks=${chunks}`,
        `chunkBytes=${chunkBytes}`,
        `alternate=${alternate}`,
        `chunkDelayMs=${options.chunkDelayMs ?? 8}`,
    ].join('|');
    const prompt = `TouchAI performance workload ${marker}`;

    await typePrompt(prompt);
    await ensureSearchSurface();
    await armRendererMeasurement(doneToken);
    await focusEditorDom();
    const focus = await focusPromptEditor();
    if (focus.historyTriggerActive) {
        throw new Error('The session history surface reopened before prompt submission.');
    }
    await sleep(100);
    const submittedAt = Date.now();
    await browser.keys(['\uE007']);
    const submission = await browser.execute(() => {
        const editorElement = document.querySelector(
            "[data-testid='search-editor-host'] .ProseMirror"
        );
        const state = window.__PERF710_STATE__;
        return {
            activeElement: document.activeElement?.tagName ?? null,
            activeElementClass: document.activeElement?.className ?? null,
            editorText: editorElement?.textContent ?? '',
            messageCount: document.querySelectorAll('[data-message-role]').length,
            keydownAt: state?.keydownAt ?? null,
            lastKeydown: state?.lastKeydown ?? null,
        };
    });
    appendEvent({ type: 'submission-dispatch', focus, submission });
    const result = await waitRendererMeasurement(doneToken, options.timeoutMs);
    const completedAt = Date.now();
    await waitForSessionSettled();

    const record = {
        type: options.recordType ?? 'latency',
        mode: options.mode ?? null,
        sample,
        submittedAt,
        completedAt,
        rounds,
        chunks,
        chunkBytes,
        alternate: Boolean(alternate),
        promptId: id,
        ...result,
    };
    appendEvent(record);
    return record;
}

async function waitForNoMessages(timeoutMs = 30000) {
    await browser.waitUntil(
        async () =>
            (await browser.execute(
                () => document.querySelectorAll('[data-message-role]').length
            )) === 0,
        {
            timeout: timeoutMs,
            timeoutMsg: 'The conversation did not return to an empty session.',
        }
    );
}

async function sessionMessageCount() {
    return await browser.execute(() => document.querySelectorAll('[data-message-role]').length);
}

async function waitForStableSessionLayout(timeoutMs = 5000, stableMs = 750) {
    const deadline = Date.now() + timeoutMs;
    let previous = null;
    let stableSince = null;

    while (Date.now() < deadline) {
        const signature = await browser.execute(() => {
            const rect = (element) => {
                if (!(element instanceof HTMLElement)) return null;
                const value = element.getBoundingClientRect();
                return [value.x, value.y, value.width, value.height].map(
                    (part) => Math.round(part * 100) / 100
                );
            };
            return JSON.stringify({
                host: rect(document.querySelector("[data-testid='conversation-panel-host']")),
                view: rect(document.querySelector("[data-testid='search-view']")),
                documentHeight: document.documentElement.scrollHeight,
            });
        });
        const now = Date.now();

        if (signature === previous) {
            if (stableSince !== null && now - stableSince >= stableMs) return true;
        } else {
            previous = signature;
            stableSince = now;
        }
        await sleep(100);
    }

    return false;
}

async function waitForNoMessagesIfPossible(timeoutMs) {
    try {
        await waitForNoMessages(timeoutMs);
        return true;
    } catch {
        return false;
    }
}

async function captureSessionResetFailure(attempts) {
    let diagnostic;
    try {
        diagnostic = await browser.execute(() => {
            const button = document.querySelector(
                ".toolbar-fade-overlay button[data-drag-exclude='true']"
            );
            const rect = (element) => {
                if (!(element instanceof HTMLElement)) return null;
                const value = element.getBoundingClientRect();
                return {
                    x: value.x,
                    y: value.y,
                    width: value.width,
                    height: value.height,
                };
            };
            const animations =
                typeof document.getAnimations === 'function'
                    ? document
                          .getAnimations()
                          .slice(0, 20)
                          .map((animation) => ({
                              playState: animation.playState,
                              currentTime: animation.currentTime,
                              duration: animation.effect?.getTiming().duration ?? null,
                          }))
                    : [];
            const editor = document.querySelector(
                "[data-testid='search-editor-host'] .ProseMirror"
            );

            return {
                messageCount: document.querySelectorAll('[data-message-role]').length,
                toolbarButtonCount: document.querySelectorAll(
                    ".toolbar-fade-overlay button[data-drag-exclude='true']"
                ).length,
                button: button
                    ? {
                          ariaLabel: button.getAttribute('aria-label'),
                          className: button.className,
                          disabled: button instanceof HTMLButtonElement && button.disabled,
                      }
                    : null,
                editorText: editor?.textContent ?? null,
                activeElement: document.activeElement?.tagName ?? null,
                view: rect(document.querySelector("[data-testid='search-view']")),
                conversationHost: rect(
                    document.querySelector("[data-testid='conversation-panel-host']")
                ),
                animations,
                bodyTextTail: document.body.textContent?.slice(-512) ?? '',
            };
        });
    } catch (error) {
        diagnostic = { diagnosticError: String(error) };
    }

    const evidenceDirectory =
        process.env.TOUCHAI_PERF_RUN_LOG_DIR ||
        (eventsFile ? path.dirname(eventsFile) : process.cwd());
    fs.mkdirSync(evidenceDirectory, { recursive: true });
    const diagnosticPath = path.join(
        evidenceDirectory,
        `${runId || 'perf'}-session-reset-failure.json`
    );
    fs.writeFileSync(diagnosticPath, `${JSON.stringify({ attempts, diagnostic }, null, 2)}\n`);
    return { diagnostic, diagnosticPath };
}

async function clickSelector(selector, timeoutMsg, timeoutMs = 30000) {
    await browser.waitUntil(
        async () =>
            await browser.execute((cssSelector) => {
                const element = document.querySelector(cssSelector);
                if (!(element instanceof HTMLElement)) return false;
                if (
                    element instanceof HTMLButtonElement &&
                    (element.disabled || element.classList.contains('toolbar-button--disabled'))
                ) {
                    return false;
                }
                element.click();
                return true;
            }, selector),
        {
            timeout: timeoutMs,
            interval: 100,
            timeoutMsg,
        }
    );
}

async function startNewSession() {
    let remaining = await sessionMessageCount();
    if (remaining === 0) {
        await clearEditor();
        return;
    }

    await waitForStableSessionLayout();
    const attempts = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const startedAt = Date.now();
        let clickError = null;
        try {
            await clickSelector(
                ".toolbar-fade-overlay button[data-drag-exclude='true']",
                'The conversation toolbar has no clickable new-session button.',
                10000
            );
        } catch (error) {
            clickError = String(error);
        }

        if (!clickError) await sleep(250);
        const cleared =
            !clickError && (await waitForNoMessagesIfPossible(attempt === 3 ? 15000 : 8000));
        remaining = await sessionMessageCount();
        attempts.push({
            attempt,
            startedAt,
            elapsedMs: Date.now() - startedAt,
            clickError,
            cleared,
            remaining,
        });

        if (remaining === 0) {
            appendEvent({ type: 'session-reset', attempts });
            await clearEditor();
            return;
        }
        if (attempt < 3) await sleep(1500);
    }

    const evidence = await captureSessionResetFailure(attempts);
    appendEvent({
        type: 'session-reset-failure',
        attempts,
        diagnosticPath: evidence.diagnosticPath,
    });
    throw new Error(
        `The conversation did not return to an empty session after ${attempts.length} click attempts. ` +
            `Diagnostics: ${evidence.diagnosticPath}`
    );
}

async function domMetrics() {
    return await browser.execute(() => ({
        domNodes: document.querySelectorAll('*').length,
        messageCount: document.querySelectorAll('[data-message-role]').length,
        assistantMessageCount: document.querySelectorAll("[data-message-role='assistant']").length,
        bodyTextChars: document.body.textContent?.length ?? 0,
    }));
}

async function runLatency() {
    // Let startup-only work (update feed, model metadata refresh, tool sync)
    // finish before the cold sample. The wait is symmetric for both arms and
    // keeps the metric about the first user prompt, not unrelated boot I/O.
    await sleep(startupSettleMs);
    await submitAndMeasure('cold', {
        mode: 'cold',
        rounds: 12,
        chunks: 24,
        chunkBytes: 32,
    });

    if (warmSampleCount === 0) return;

    await startNewSession();
    await submitAndMeasure('warmup', {
        recordType: 'latency-warmup',
        mode: 'warmup',
        rounds: 12,
        chunks: 24,
        chunkBytes: 32,
    });

    for (let sample = 0; sample < warmSampleCount; sample += 1) {
        await startNewSession();
        await submitAndMeasure(sample, {
            mode: 'warm',
            rounds: 12,
            chunks: 24,
            chunkBytes: 32,
        });
    }
}

async function runTask(sample, recordType) {
    await startNewSession();
    appendEvent({ type: 'task-phase', phase: 'start', taskIndex: sample, recordType });
    await submitAndMeasure(sample, {
        recordType,
        rounds: 24,
        chunks: 128,
        chunkBytes: 1024,
        alternate: true,
        chunkDelayMs: 1,
        timeoutMs: 600000,
    });
    appendEvent({ type: 'task-phase', phase: 'end', taskIndex: sample, recordType });
}

async function runProgress() {
    for (let sample = 0; sample < progressWarmupTasks; sample += 1) {
        await runTask(`warmup-${sample}`, 'progress-warmup');
    }
    appendEvent({ type: 'progress-window', phase: 'start', ...(await domMetrics()) });
    for (let sample = 0; sample < progressMeasuredTasks; sample += 1) {
        await runTask(sample, 'progress-task');
    }
    appendEvent({ type: 'progress-window', phase: 'end', ...(await domMetrics()) });
    await sleep(5000);
    appendEvent({ type: 'progress-window', phase: 'settled', ...(await domMetrics()) });
}

async function mainWindowHandle() {
    return await browser.getWindowHandle();
}

async function switchToPopup(originalHandle, timeoutMs = 30000) {
    await browser.waitUntil(
        async () => {
            const handles = await browser.getWindowHandles();
            for (const handle of handles) {
                if (handle === originalHandle) continue;
                await browser.switchToWindow(handle);
                const found = await browser.execute(() =>
                    Boolean(document.querySelector('.history-session-row'))
                );
                if (found) return true;
            }
            await browser.switchToWindow(originalHandle);
            return false;
        },
        {
            timeout: timeoutMs,
            interval: 250,
            timeoutMsg: 'The session history popup did not become available.',
        }
    );
}

async function captureHistoryOpenFailure(error, originalHandle) {
    try {
        await browser.switchToWindow(originalHandle);
    } catch {
        // Keep collecting evidence from whichever window is still active.
    }

    let diagnostic;
    try {
        diagnostic = await browser.execute(() => ({
            title: document.title,
            url: window.location.href,
            bodyTextChars: document.body.textContent?.length ?? 0,
            bodyTextTail: (document.body.textContent ?? '').slice(-512),
            messageCount: document.querySelectorAll('[data-message-role]').length,
            historyTriggerCount: document.querySelectorAll('[data-history-trigger="true"]').length,
            editorText: document.querySelector("[data-testid='search-editor-host'] .ProseMirror")
                ?.textContent,
            buttons: [...document.querySelectorAll('button')].map((button) => ({
                ariaLabel: button.getAttribute('aria-label'),
                dataHistoryTrigger: button.getAttribute('data-history-trigger'),
                className: button.className,
            })),
        }));
    } catch (diagnosticError) {
        diagnostic = {
            diagnosticError: String(diagnosticError),
        };
    }

    const evidenceDirectory =
        process.env.TOUCHAI_PERF_RUN_LOG_DIR ||
        (eventsFile ? path.dirname(eventsFile) : process.cwd());
    fs.mkdirSync(evidenceDirectory, { recursive: true });
    const artifactBase = path.join(
        evidenceDirectory,
        `${runId || 'perf'}-${flow}-history-open-failure`
    );
    fs.writeFileSync(`${artifactBase}.json`, `${JSON.stringify(diagnostic, null, 2)}\n`);

    let screenshotPath = null;
    try {
        const screenshot = await Promise.race([
            browser.takeScreenshot(),
            new Promise((resolve) => {
                setTimeout(() => resolve(null), 3000);
            }),
        ]);
        if (screenshot) {
            screenshotPath = `${artifactBase}.png`;
            fs.writeFileSync(screenshotPath, Buffer.from(screenshot, 'base64'));
        }
    } catch (screenshotError) {
        appendEvent({
            type: 'history-open-screenshot-error',
            error: String(screenshotError),
        });
    }

    appendEvent({
        type: 'history-open-failure',
        error: String(error),
        diagnosticPath: `${artifactBase}.json`,
        screenshotPath,
    });
    return { diagnosticPath: `${artifactBase}.json`, screenshotPath };
}

async function openSeededSession() {
    const originalHandle = await mainWindowHandle();
    appendEvent({ type: 'long-phase', phase: 'open-start', historyLevel });
    const hasHistoryTrigger = await browser.execute(() =>
        Boolean(document.querySelector('button[data-history-trigger="true"]'))
    );
    appendEvent({
        type: 'history-open-dispatch',
        method: hasHistoryTrigger ? 'toolbar-click' : 'keyboard-shortcut',
    });
    try {
        if (hasHistoryTrigger) {
            await clickSelector(
                'button[data-history-trigger="true"]',
                'The session history toolbar trigger did not become clickable.'
            );
        } else {
            await focusEditorDom();
            await browser.keys(['Control', 'h']);
        }
        await switchToPopup(originalHandle);
    } catch (error) {
        const evidence = await captureHistoryOpenFailure(error, originalHandle);
        throw new Error(
            `${error instanceof Error ? error.message : String(error)} ` +
                `Diagnostics: ${evidence.diagnosticPath}; screenshot: ${
                    evidence.screenshotPath ?? 'unavailable'
                }`,
            { cause: error }
        );
    }
    await clickSelector(
        '.history-session-row',
        'The seeded session row did not become clickable.',
        60000
    );
    await browser.switchToWindow(originalHandle);
    await waitForMainWindow();
    await browser.waitUntil(
        async () =>
            (await browser.execute(
                () => document.querySelectorAll('[data-message-role]').length
            )) >= historyLevel,
        {
            timeout: 5 * 60 * 1000,
            timeoutMsg: `The seeded ${historyLevel}-message session did not finish rendering.`,
        }
    );
    await clearEditor();
    appendEvent({
        type: 'long-phase',
        phase: 'open-complete',
        historyLevel,
        ...(await domMetrics()),
    });
}

async function runLongSession() {
    appendEvent({ type: 'long-phase', phase: 'idle', ...(await domMetrics()) });
    await sleep(3000);
    appendEvent({ type: 'long-phase', phase: 'baseline', ...(await domMetrics()) });
    await openSeededSession();
    await sleep(10000);
    appendEvent({ type: 'long-phase', phase: 'retained', ...(await domMetrics()) });
    appendEvent({ type: 'long-phase', phase: 'stream-start', ...(await domMetrics()) });
    await submitAndMeasure(0, {
        recordType: 'long-stream',
        mode: 'long-stream',
        rounds: 2,
        chunks: 32,
        chunkBytes: 256,
        timeoutMs: 300000,
    });
    appendEvent({ type: 'long-phase', phase: 'terminal', ...(await domMetrics()) });
    await sleep(10000);
    appendEvent({ type: 'long-phase', phase: 'settled', ...(await domMetrics()) });
}

describe('user runs the RFC 710 native performance workload', () => {
    it('user completes the configured release workload with observable metrics', async () => {
        await waitForMainWindow();
        appendEvent({ type: 'run-start' });

        if (flow === 'latency') {
            await runLatency();
        } else if (flow === 'progress') {
            await runProgress();
        } else if (flow === 'long-session') {
            await runLongSession();
        } else {
            throw new Error(`Unknown TOUCHAI_PERF_FLOW: ${flow}`);
        }

        appendEvent({ type: 'run-end', ...(await domMetrics()) });
    });
});
