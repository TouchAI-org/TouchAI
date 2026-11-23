// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { afterEach, describe, expect, it } from 'vitest';

import {
    installRailNavigationMeasurement,
    installRendererMeasurement,
    RAIL_NAVIGATION_ELEMENT_ID,
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

function appendConversationLog(busy = 'true') {
    const host = document.createElement('div');
    host.setAttribute('data-testid', 'conversation-panel-host');
    const log = document.createElement('div');
    log.setAttribute('role', 'log');
    log.setAttribute('aria-busy', busy);
    host.append(log);
    document.body.append(host);
    return log;
}

function appendRail(count = 2) {
    const scroller = document.createElement('div');
    scroller.setAttribute('data-slot', 'message-scroller');
    const viewport = document.createElement('section');
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, value: 400 });
    viewport.scrollTop = 600;
    const rail = document.createElement('nav');
    rail.setAttribute('data-slot', 'message-scroller-rail');
    const buttons = Array.from({ length: count }, (_, index) => index).map((index) => {
        const button = document.createElement('button');
        button.setAttribute('data-slot', 'message-scroller-rail-item');
        button.addEventListener('click', () => {
            viewport.scrollTop = index === 0 ? 0 : 600;
            buttons.forEach((candidate, candidateIndex) => {
                if (candidateIndex === index) candidate.setAttribute('aria-current', 'location');
                else candidate.removeAttribute('aria-current');
            });
        });
        rail.append(button);
        return button;
    });
    buttons[count - 1].setAttribute('aria-current', 'location');
    scroller.append(viewport, rail);
    document.body.append(scroller);
}

afterEach(() => {
    window.__TOUCHAI_PERF_MEASUREMENT_CLEANUP__?.();
    document.getElementById(RENDERER_MEASUREMENT_ELEMENT_ID)?.remove();
    document.getElementById(RAIL_NAVIGATION_ELEMENT_ID)?.remove();
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

    it('user sees a final idle snapshot after streaming settles', async () => {
        const log = appendConversationLog();
        installSerializedMeasurement('TOKEN-FINAL');

        dispatchEnter();
        appendAssistant('assistant-final', 'TOKEN-FINAL');
        await new Promise((resolve) => setTimeout(resolve, 20));
        log.setAttribute('aria-busy', 'false');
        await new Promise((resolve) => setTimeout(resolve, 120));

        const settled = readMeasurement()?.settledResult;
        expect(settled).toMatchObject({
            busy: 'false',
            atEnd: true,
        });
        expect(settled?.frameCount).toBeGreaterThan(0);
        expect(settled?.mutationCount).toBeGreaterThan(0);
        expect(settled?.frameGapSamples).toBeGreaterThan(0);
        expect(settled?.frameGapSamples).toBe((settled?.frameCount ?? 0) - 1);
        expect(settled?.frameGapP95Ms).toBeGreaterThanOrEqual(0);
        expect(settled?.frameGapMaxMs).toBeGreaterThanOrEqual(settled?.frameGapP95Ms ?? 0);
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

    it('user measures navigation to both ends of the native rail', async () => {
        appendRail();
        const installer = Function(`return (${installRailNavigationMeasurement.toString()});`)();
        installer(2, 2, 1000);

        await new Promise((resolve) => setTimeout(resolve, 300));
        const result = JSON.parse(
            document.getElementById(RAIL_NAVIGATION_ELEMENT_ID)?.textContent ?? '{}'
        ).result;

        expect(result).toMatchObject({
            turnCount: 2,
            tickCount: 2,
            sampled: false,
        });
        expect(result?.steps).toHaveLength(2);
        expect(result?.steps[0]).toMatchObject({
            target: 'first',
            targetIndex: 0,
            moved: true,
            focusedBefore: true,
            focusedAfter: true,
            activeTarget: true,
        });
        expect(result?.steps[1]).toMatchObject({
            target: 'last',
            targetIndex: 1,
            moved: true,
            focusedAfter: true,
            activeTarget: true,
        });
    });

    it.each([
        [250, 250],
        [500, 500],
        [250, 96],
        [500, 96],
    ])('user navigates %s turns using the declared %s destinations', async (turns, ticks) => {
        appendRail(ticks);
        const installer = Function(`return (${installRailNavigationMeasurement.toString()});`)();
        installer(turns, ticks, 1000);
        await new Promise((resolve) => setTimeout(resolve, 300));
        const measurement = JSON.parse(
            document.getElementById(RAIL_NAVIGATION_ELEMENT_ID).textContent
        );
        expect(measurement.error).toBeFalsy();
        expect(measurement.result.tickCount).toBe(ticks);
        expect(
            measurement.result.steps.every(
                (step) => step.moved && step.focusedAfter && step.activeTarget
            )
        ).toBe(true);
    });
});
