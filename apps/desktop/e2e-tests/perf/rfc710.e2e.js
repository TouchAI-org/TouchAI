import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
    isSeededSessionReady,
    seededSessionMessageId,
} from '../../scripts/perf/710/history-session.mjs';
import { focusMain } from '../test/support/agent-ui.js';
import { fillSearchDraft, pressEditorKey } from '../test/support/conversation-queue.js';
import { callE2eBridge, waitForE2eBridge } from '../test/support/desktop.js';
import { waitForSessionSettled } from './completion.js';

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
    await waitForE2eBridge(60000);
    await $("[data-testid='search-editor-host'] .ProseMirror").waitForDisplayed({ timeout: 60000 });
}

async function armRendererMeasurement(doneToken) {
    await browser.execute((token) => {
        const existingAssistants = new Set(
            [...document.querySelectorAll("[data-message-role='assistant']")].map((element) =>
                element.getAttribute('data-message-id')
            )
        );
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
            if (
                !latestMessage ||
                existingAssistants.has(latestMessage.getAttribute('data-message-id'))
            )
                return '';
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
                .map((element) => (element.innerText ?? '').trim())
                .join('');
        };

        const sentinelSource = () => {
            const messages = assistantMessages();
            for (let index = messages.length - 1; index >= 0; index -= 1) {
                if ((messages[index].innerText ?? '').includes(token)) {
                    return `assistant-innerText:${index}`;
                }
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

        state.cleanup = cleanup;
        state.checkNow = check;
        state.armedAt = performance.now();
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

async function withTimeout(operation, milliseconds, message) {
    let timer;
    try {
        return await Promise.race([
            operation,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(message)), milliseconds);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

async function captureSentinelTimeout(doneToken, error) {
    let diagnostic;
    try {
        diagnostic = await withTimeout(
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
            30000,
            'Timed out while collecting renderer sentinel diagnostics.'
        );
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
        await withTimeout(
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
            timeoutMs + 1000,
            `The renderer did not reach the performance sentinel within ${timeoutMs}ms.`
        );
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
        window.__PERF710_STATE__?.cleanup();
        delete window.__PERF710_STATE__;
        return value;
    });
    if (
        !result ||
        result.keydownAt === null ||
        !Number.isFinite(result.durationMs) ||
        result.durationMs <= 0
    ) {
        throw new Error('Renderer performance result was missing.');
    }
    return result;
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

    await focusMain();
    await fillSearchDraft(prompt);
    await armRendererMeasurement(doneToken);
    const submittedAt = Date.now();
    await pressEditorKey('\uE007');
    const result = await waitRendererMeasurement(doneToken, options.timeoutMs);
    const completedAt = Date.now();
    await waitForSessionSettled({
        databasePath: path.join(process.env.TOUCHAI_PERF_APP_ROOT, 'data/touchai.db'),
        prompt,
    });

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

async function startNewSession() {
    await callE2eBridge('clearSessionToIdle');
    await callE2eBridge('resetDraft');
    await browser.waitUntil(
        () => browser.execute(() => document.querySelectorAll('[data-message-role]').length === 0),
        { timeout: 30000, timeoutMsg: 'The conversation did not return to an empty session.' }
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

async function openSeededSession() {
    appendEvent({ type: 'long-phase', phase: 'open-start', historyLevel });
    await focusMain();
    await pressEditorKey('h', { modified: true });
    const history = await $('[data-search-history-popover="true"]');
    await history.waitForDisplayed();
    const row = await history.$(`button.history-session-row*=Perf history ${historyLevel}`);
    await row.waitForDisplayed();
    await row.click();
    const expectedMessageId = seededSessionMessageId(historyLevel);
    await browser.waitUntil(
        async () =>
            isSeededSessionReady({
                historyLevel,
                mountedMessageIds: await browser.execute(() =>
                    [...document.querySelectorAll('[data-message-id]')].map((element) =>
                        element.getAttribute('data-message-id')
                    )
                ),
            }),
        {
            timeout: 300000,
            timeoutMsg: `The seeded session did not mount its final message (${expectedMessageId}).`,
        }
    );
    await history.waitForExist({ reverse: true });
    appendEvent({
        type: 'long-phase',
        phase: 'open-complete',
        historyLevel,
        expectedMessageId,
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
