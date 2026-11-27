import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { evidenceRoot, startupSettleMs } from '../../scripts/perf/lib/config.mjs';
import { railTickCount, workloadFor } from '../../scripts/perf/lib/workload.mjs';
import { focusMain } from '../test/support/agent-ui.js';
import { fillSearchDraft, pressEditorKey } from '../test/support/conversation-queue.js';
import { callE2eBridge, waitForE2eBridge } from '../test/support/desktop.js';
import {
    installRailNavigationMeasurement,
    installRendererMeasurement,
    RAIL_NAVIGATION_ELEMENT_ID,
    RENDERER_MEASUREMENT_ELEMENT_ID,
} from './renderer-measurement.js';
import {
    isSeededSessionReady,
    seededSessionMessageId,
    waitForSessionSettled,
} from './session-state.js';

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
const progressMeasuredTasks = Number(process.env.TOUCHAI_PERF_PROGRESS_TASKS) || 8;
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
    return `${runId}-${sample}`;
}

function doneTokenFor(id) {
    return `TOUCHAI_PERF_DONE_${createHash('sha256').update(id).digest('hex').slice(0, 16)}`;
}

async function waitForMainWindow() {
    await waitForE2eBridge(60000);
    await $("[data-testid='search-editor-host'] .ProseMirror").waitForDisplayed({ timeout: 60000 });
}

async function injectAppWorldScript(source, elementId, message) {
    const installed = await browser.execute(
        (installSource, elementId) => {
            const script = document.createElement('script');
            script.textContent = installSource;
            (document.head ?? document.documentElement).append(script);
            script.remove();
            return Boolean(document.getElementById(elementId));
        },
        source,
        elementId
    );
    if (!installed) {
        throw new Error(message);
    }
}

async function readAppWorldState(elementId) {
    return await browser.execute((elementId) => {
        const raw = document.getElementById(elementId)?.textContent;
        if (!raw) return null;
        try {
            return JSON.parse(raw);
        } catch (error) {
            return { lastError: `Invalid renderer measurement state: ${String(error)}` };
        }
    }, elementId);
}

async function armRendererMeasurement(doneToken) {
    const source = `(${installRendererMeasurement.toString()})(${JSON.stringify(doneToken)});`;
    await injectAppWorldScript(
        source,
        RENDERER_MEASUREMENT_ELEMENT_ID,
        'The renderer measurement bridge did not install.'
    );
}

async function readRendererMeasurement() {
    return await readAppWorldState(RENDERER_MEASUREMENT_ELEMENT_ID);
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
        const state = await withTimeout(
            readRendererMeasurement(),
            30000,
            'Timed out while collecting renderer measurement state.'
        );
        const domDiagnostic = await withTimeout(
            browser.execute((token) => {
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
        diagnostic = { state, ...domDiagnostic };
    } catch (diagnosticError) {
        diagnostic = {
            diagnosticError: String(diagnosticError),
        };
    }

    const evidenceDirectory =
        process.env.TOUCHAI_PERF_RUN_LOG_DIR ||
        (eventsFile ? path.dirname(eventsFile) : process.cwd());
    fs.mkdirSync(evidenceDirectory, { recursive: true });
    const diagnosticPath = path.join(evidenceDirectory, `${runId || 'perf'}-sentinel-timeout.json`);
    fs.writeFileSync(diagnosticPath, `${JSON.stringify(diagnostic, null, 2)}\n`);
    appendEvent({
        type: 'renderer-sentinel-timeout',
        error: String(error),
        diagnosticPath,
    });
    return diagnosticPath;
}

async function waitRendererMeasurement(doneToken, timeoutMs = 180000) {
    try {
        await withTimeout(
            browser.waitUntil(
                async () => {
                    const state = await readRendererMeasurement();
                    return Boolean(state?.settledResult);
                },
                {
                    timeout: timeoutMs,
                    timeoutMsg: 'The renderer did not settle after the performance sentinel.',
                }
            ),
            timeoutMs + 1000,
            `The renderer did not settle after the performance sentinel within ${timeoutMs}ms.`
        );
    } catch (error) {
        const diagnosticPath = await captureSentinelTimeout(doneToken, error);
        throw new Error(
            `${error instanceof Error ? error.message : String(error)} Diagnostics: ${diagnosticPath}`,
            { cause: error }
        );
    }
    const state = await readRendererMeasurement();
    const result = state?.result ?? null;
    const settled = state?.settledResult ?? null;
    if (
        !result ||
        result.keydownAt === null ||
        !Number.isFinite(result.durationMs) ||
        result.durationMs <= 0 ||
        !settled ||
        settled.busy !== 'false' ||
        !Number.isFinite(settled.durationMs) ||
        settled.durationMs <= 0 ||
        !Number.isFinite(settled.frameCount) ||
        settled.frameCount <= 0 ||
        !Number.isFinite(settled.mutationCount) ||
        settled.mutationCount <= 0
    ) {
        throw new Error('Renderer performance result or final state was missing.');
    }
    return { ...result, settled };
}

async function captureNativeScreenshot(name) {
    const directory =
        process.env.TOUCHAI_PERF_RUN_LOG_DIR ||
        (eventsFile ? path.dirname(eventsFile) : process.cwd());
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `${name}.png`);
    await browser.saveScreenshot(file);
    if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
        throw new Error(`Native screenshot was not written: ${file}`);
    }
    return path.relative(evidenceRoot, file);
}

async function measureRailNavigation() {
    const turnCount = Math.ceil(historyLevel / 2);
    const expectedTicks = railTickCount(turnCount, process.env.TOUCHAI_PERF_RAIL_POLICY);
    const source = `(${installRailNavigationMeasurement.toString()})(${turnCount}, ${expectedTicks});`;
    await injectAppWorldScript(
        source,
        RAIL_NAVIGATION_ELEMENT_ID,
        'The native rail navigation measurement did not install.'
    );

    let measurement = null;
    let measurementError = null;
    await withTimeout(
        browser.waitUntil(
            async () => {
                const state = await readAppWorldState(RAIL_NAVIGATION_ELEMENT_ID);
                if (state?.error) measurementError = state.error;
                if (state?.result) measurement = state.result;
                return Boolean(measurement || measurementError);
            },
            {
                timeout: 30000,
                timeoutMsg: 'The native rail navigation did not settle.',
            }
        ),
        31000,
        'The native rail navigation did not settle.'
    );
    if (measurementError) throw new Error(measurementError);
    if (!measurement) throw new Error('Native rail navigation evidence was missing.');

    const screenshot = await captureNativeScreenshot(`long-${historyLevel}-rail`);
    appendEvent({
        type: 'long-rail',
        historyLevel,
        screenshot,
        ...measurement,
    });
    return measurement;
}

async function submitAndMeasure(sample, options = {}) {
    options = { ...workloadFor(flow), ...options };
    const id = promptId(sample);
    const doneToken = doneTokenFor(id);
    const rounds = options.rounds ?? 12;
    const chunks = options.chunks ?? 24;
    const chunkBytes = options.chunkBytes ?? 24;
    const alternate = options.alternate ? 1 : 0;
    const marker = [
        'TOUCHAI_PERF',
        `runId=${runId}`,
        `arm=${arm}`,
        `block=${block}`,
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
    const screenshot = options.screenshotName
        ? await captureNativeScreenshot(options.screenshotName)
        : null;

    const record = {
        type: options.recordType ?? 'latency',
        mode: options.mode ?? null,
        sample,
        submittedAt,
        completedAt,
        rounds,
        chunks,
        chunkBytes,
        chunkDelayMs: options.chunkDelayMs,
        alternate: Boolean(alternate),
        promptId: id,
        screenshot,
        ...result,
    };
    appendEvent(record);
    return record;
}

async function startNewSession() {
    await focusMain();
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
    });

    if (warmSampleCount === 0) return;

    await startNewSession();
    await submitAndMeasure('warmup', {
        recordType: 'latency-warmup',
        mode: 'warmup',
    });

    for (let sample = 0; sample < warmSampleCount; sample += 1) {
        await startNewSession();
        await submitAndMeasure(sample, {
            mode: 'warm',
        });
    }
}

async function runTask(sample, recordType) {
    await startNewSession();
    await submitAndMeasure(sample, {
        recordType,
        timeoutMs: 600000,
    });
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
}

async function runLongSession() {
    await sleep(3000);
    appendEvent({ type: 'long-phase', phase: 'baseline', ...(await domMetrics()) });
    await openSeededSession();
    await sleep(10000);
    appendEvent({ type: 'long-phase', phase: 'retained', ...(await domMetrics()) });
    await measureRailNavigation();
    appendEvent({ type: 'long-phase', phase: 'stream-start', ...(await domMetrics()) });
    await submitAndMeasure(0, {
        recordType: 'long-stream',
        mode: 'long-stream',
        timeoutMs: 300000,
        screenshotName: `long-${historyLevel}-stream-settled`,
    });
    appendEvent({ type: 'long-phase', phase: 'terminal', ...(await domMetrics()) });
    await sleep(10000);
    appendEvent({ type: 'long-phase', phase: 'settled', ...(await domMetrics()) });
}

describe('user runs the native performance workload', () => {
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
    });
});
