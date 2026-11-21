// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { afterEach, describe, expect, it } from 'vitest';

import {
    installRendererMeasurement,
    RENDERER_MEASUREMENT_ELEMENT_ID,
} from '../../../e2e-tests/perf/renderer-measurement.js';

function readMeasurement() {
    const raw = document.getElementById(RENDERER_MEASUREMENT_ELEMENT_ID)?.textContent;
    return raw ? JSON.parse(raw) : null;
}

function dispatchEnter(init = {}) {
    const editor = document.createElement('div');
    editor.className = 'ProseMirror';
    document.body.append(editor);
    editor.dispatchEvent(
        new KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
            cancelable: true,
            ...init,
        })
    );
}

function appendAssistant(id, text) {
    const message = document.createElement('div');
    message.setAttribute('data-message-role', 'assistant');
    message.setAttribute('data-message-id', id);
    const parts = document.createElement('div');
    parts.className = 'assistant-message-parts';
    const part = document.createElement('div');
    part.className = 'assistant-message-part';
    part.textContent = text;
    parts.append(part);
    message.append(parts);
    document.body.append(message);
}

function installSerializedMeasurement(token) {
    const installer = Function(`return (${installRendererMeasurement.toString()});`)();
    installer(token);
}

afterEach(() => {
    window.__TOUCHAI_PERF_MEASUREMENT_CLEANUP__?.();
    document.getElementById(RENDERER_MEASUREMENT_ELEMENT_ID)?.remove();
    document.body.innerHTML = '';
});

describe('user measures renderer latency in the application world', () => {
    it('user times Enter until only the new assistant response contains the sentinel', async () => {
        appendAssistant('assistant-old', 'TOKEN-NEW must not match the old response');
        // Match the harness, which serializes the installer into the app's main world.
        installSerializedMeasurement('TOKEN-NEW');

        dispatchEnter();
        const started = readMeasurement();
        expect(started?.startAt).not.toBeNull();
        expect(started?.startedEpochMs).not.toBeNull();
        expect(started?.lastKeydown).toMatchObject({
            isComposing: false,
            shiftKey: false,
            targetClass: 'ProseMirror',
        });

        appendAssistant('assistant-new', 'TOKEN-NEW');
        await new Promise((resolve) => setTimeout(resolve, 10));

        const completed = readMeasurement();
        expect(completed?.result).toMatchObject({
            keydownAt: completed?.startAt,
            sentinelSource: 'assistant-innerText:1',
        });
        expect(completed?.result?.durationMs).toBeGreaterThanOrEqual(0);
        expect(completed?.firstTextAt).not.toBeNull();
    });

    it('user gets Shift+Enter ignored until a plain Enter submits', () => {
        installRendererMeasurement('TOKEN-2');

        dispatchEnter({ shiftKey: true });
        expect(readMeasurement()?.startAt).toBeNull();

        dispatchEnter();
        expect(readMeasurement()?.startAt).not.toBeNull();
    });

    it('user does not get a stale completion after the measurement is disposed', async () => {
        installRendererMeasurement('TOKEN-3');
        dispatchEnter();
        const started = readMeasurement();

        window.__TOUCHAI_PERF_MEASUREMENT_CLEANUP__?.();
        appendAssistant('assistant-3', 'TOKEN-3');
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(readMeasurement()?.result).toBeNull();
        expect(readMeasurement()?.startAt).toBe(started?.startAt);
    });
});
