import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createWidgetRenderer } from '@/services/BuiltInToolService/tools/widgetTool';

type WidgetGlobals = Window & {
    __scopeEvents?: string[];
};

function globals(): WidgetGlobals {
    return window as WidgetGlobals;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        if (predicate()) {
            return;
        }
        await sleep(5);
    }
    throw new Error('Timed out waiting for widget script side effects');
}

/**
 * 覆盖作用域代理的每一条路径：window 上的定时器、rAF、事件监听、
 * observer 包装以及字符串形式 handler。
 */
function scopedScriptHtml(): string {
    return [
        '<div data-testid="widget-body">x</div>',
        '<script>',
        'window.__scopeEvents = [];',
        'const push = (name) => window.__scopeEvents.push(name);',
        'const timeoutId = window.setTimeout(() => push("windowTimeout"), 0);',
        'window.clearTimeout(timeoutId);',
        'const intervalId = window.setInterval(() => push("interval"), 1000);',
        'window.clearInterval(intervalId);',
        'const frameId = window.requestAnimationFrame(() => push("frame"));',
        'window.cancelAnimationFrame(frameId);',
        'const handler = () => push("resize");',
        'window.addEventListener("resize", handler);',
        'window.removeEventListener("resize", handler);',
        'setTimeout(() => push("bareTimeout"), 0);',
        'setTimeout("window.__scopeEvents.push(\\"evalHandler\\")", 0);',
        'if (typeof window.ResizeObserver === "function") {',
        '  const ro = new window.ResizeObserver(() => push("resizeObserver"));',
        '  ro.observe(document.body);',
        '}',
        'if (typeof window.MutationObserver === "function") {',
        '  const mo = new window.MutationObserver(() => push("mutationObserver"));',
        '  mo.observe(document.body, { childList: true });',
        '}',
        '</script>',
    ].join('');
}

describe('when a widget script uses the scoped window surface', () => {
    let host: HTMLElement;

    beforeEach(() => {
        host = document.createElement('div');
        document.body.appendChild(host);
        delete globals().__scopeEvents;
    });

    afterEach(() => {
        host.remove();
        delete globals().__scopeEvents;
    });

    it('user gets the widget running even when it schedules timers, frames and observers', async () => {
        const renderer = createWidgetRenderer(host);
        renderer.render({
            widgetId: 'scope-widget',
            title: 'Scope',
            description: '',
            html: scopedScriptHtml(),
            phase: 'ready',
        });

        await waitForCondition(() => (globals().__scopeEvents ?? []).includes('bareTimeout'));

        expect(globals().__scopeEvents).toContain('bareTimeout');
        renderer.destroy();
    });

    it('user does not get widget work continuing after the widget is destroyed', async () => {
        const renderer = createWidgetRenderer(host);
        renderer.render({
            widgetId: 'scope-widget-2',
            title: 'Scope',
            description: '',
            html: scopedScriptHtml(),
            phase: 'ready',
        });

        await waitForCondition(() => (globals().__scopeEvents ?? []).includes('bareTimeout'));
        renderer.destroy();
        const eventsAfterDestroy = [...(globals().__scopeEvents ?? [])];

        await sleep(80);
        window.dispatchEvent(new Event('resize'));

        expect(globals().__scopeEvents).toEqual(eventsAfterDestroy);
    });
});
