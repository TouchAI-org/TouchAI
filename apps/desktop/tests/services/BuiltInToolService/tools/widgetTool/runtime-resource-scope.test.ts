import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createWidgetRenderer } from '@/services/BuiltInToolService/tools/widgetTool';

type WidgetGlobals = Window & {
    __widgetTicks?: number;
    __widgetResizes?: number;
};

function widgetHtml(): string {
    return [
        '<div data-testid="widget-body">x</div>',
        '<script>',
        'window.__widgetTicks = 0;',
        'setInterval(function () { window.__widgetTicks = window.__widgetTicks + 1; }, 5);',
        'window.__widgetResizes = 0;',
        "window.addEventListener('resize', function () { window.__widgetResizes = window.__widgetResizes + 1; });",
        '</script>',
    ].join('');
}

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

async function renderReadyWidget(host: HTMLElement) {
    const renderer = createWidgetRenderer(host);
    renderer.render({
        widgetId: 'widget-1',
        title: 'Resource scope',
        description: '',
        html: widgetHtml(),
        phase: 'ready',
    });

    await waitForCondition(() => (globals().__widgetTicks ?? 0) >= 2);
    return renderer;
}

describe('widget script resource scope', () => {
    let host: HTMLElement;

    beforeEach(() => {
        host = document.createElement('div');
        document.body.appendChild(host);
        delete globals().__widgetTicks;
        delete globals().__widgetResizes;
    });

    afterEach(() => {
        host.remove();
        delete globals().__widgetTicks;
        delete globals().__widgetResizes;
    });

    it('runs widget scripts while the widget is mounted', async () => {
        const renderer = await renderReadyWidget(host);

        expect(globals().__widgetTicks).toBeGreaterThan(0);

        renderer.destroy();
    });

    it('clears timers and listeners created by widget scripts on destroy', async () => {
        const renderer = await renderReadyWidget(host);

        renderer.destroy();
        const ticksAfterDestroy = globals().__widgetTicks ?? 0;
        const resizesAfterDestroy = globals().__widgetResizes ?? 0;

        await sleep(80);
        window.dispatchEvent(new Event('resize'));

        expect(globals().__widgetTicks).toBe(ticksAfterDestroy);
        expect(globals().__widgetResizes).toBe(resizesAfterDestroy);
    });
});
