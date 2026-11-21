// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { afterEach, describe, expect, it } from 'vitest';

import { createE2ePerfMeasurement } from '@/views/SearchView/e2ePerformance';

let measurement: ReturnType<typeof createE2ePerfMeasurement> | null = null;

afterEach(() => {
    measurement?.dispose();
    measurement = null;
    document.body.innerHTML = '';
});

function dispatchEnter(init: KeyboardEventInit = {}) {
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

function appendAssistant(id: string, token: string) {
    const message = document.createElement('div');
    message.setAttribute('data-message-role', 'assistant');
    message.setAttribute('data-message-id', id);
    const parts = document.createElement('div');
    parts.className = 'assistant-message-parts';
    const part = document.createElement('div');
    part.className = 'assistant-message-part';
    part.textContent = token;
    parts.append(part);
    message.append(parts);
    document.body.append(message);
}

describe('user measures the renderer performance workload', () => {
    it('user gets a completed sample from the main renderer when Enter submits', async () => {
        measurement = createE2ePerfMeasurement();
        measurement.arm('TOKEN-1');

        dispatchEnter();
        const started = measurement.snapshot();
        expect(started?.startAt).not.toBeNull();
        expect(started?.startedEpochMs).not.toBeNull();
        expect(started?.lastKeydown).toMatchObject({
            isComposing: false,
            shiftKey: false,
            targetClass: 'ProseMirror',
        });

        appendAssistant('assistant-1', 'TOKEN-1');
        measurement.snapshot();
        await new Promise((resolve) => setTimeout(resolve, 0));

        const completed = measurement.snapshot();
        expect(completed?.result).toMatchObject({
            keydownAt: completed?.startAt,
            sentinelSource: 'assistant-innerText:0',
        });
        expect(completed?.result?.durationMs).toBeGreaterThanOrEqual(0);
        expect(completed?.firstTextAt).not.toBeNull();
    });

    it('user gets Shift+Enter ignored until a plain Enter submits', () => {
        measurement = createE2ePerfMeasurement();
        measurement.arm('TOKEN-2');

        dispatchEnter({ shiftKey: true });
        expect(measurement.snapshot()?.startAt).toBeNull();

        dispatchEnter();
        expect(measurement.snapshot()?.startAt).not.toBeNull();
    });

    it('user gets no stale sample after the measurement is disposed', () => {
        measurement = createE2ePerfMeasurement();
        measurement.arm('TOKEN-3');
        dispatchEnter();

        measurement.dispose();

        expect(measurement.snapshot()).toBeNull();
    });
});
