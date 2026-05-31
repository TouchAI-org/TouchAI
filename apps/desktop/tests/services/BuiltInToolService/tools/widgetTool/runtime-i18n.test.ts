import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWidgetRenderer } from '@/services/BuiltInToolService/tools/widgetTool/showWidget/runtime';

async function waitForWidgetRender(): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
}

function installScriptExecutionMock(): void {
    const nativeReplaceChild = Node.prototype.replaceChild;

    vi.spyOn(Node.prototype, 'replaceChild').mockImplementation(function (
        this: Node,
        newChild: Node,
        oldChild: Node
    ) {
        const replacedNode = nativeReplaceChild.call(this, newChild, oldChild);

        if (newChild instanceof HTMLScriptElement) {
            if (newChild.src) {
                window.setTimeout(() => {
                    if (newChild.src.includes('chart.umd.js')) {
                        (window as Window & { Chart?: unknown }).Chart = function Chart() {
                            (
                                window as Window & { __touchaiChartConstructed?: boolean }
                            ).__touchaiChartConstructed = true;
                        };
                    }
                    newChild.dispatchEvent(new Event('load'));
                }, 0);
            } else {
                new Function(newChild.textContent || '')();
            }
        }

        return replacedNode;
    } as typeof Node.prototype.replaceChild);
}

describe('show widget renderer i18n opt-out', () => {
    afterEach(() => {
        document.body.innerHTML = '';
        delete (window as Window & { __touchaiWidgetInitRan?: boolean }).__touchaiWidgetInitRan;
        delete (window as Window & { Chart?: unknown }).Chart;
        delete (window as Window & { __touchaiChartConstructed?: boolean })
            .__touchaiChartConstructed;
    });

    it('marks the renderer host and root as not eligible for global DOM localization', () => {
        const host = document.createElement('div');
        document.body.appendChild(host);

        const renderer = createWidgetRenderer(host);
        const root = host.querySelector('[data-touchai-widget-root="true"]');

        expect(host.getAttribute('data-no-i18n')).toBe('true');
        expect(host.getAttribute('translate')).toBe('no');
        expect(root?.getAttribute('data-no-i18n')).toBe('true');
        expect(root?.getAttribute('translate')).toBe('no');

        renderer.destroy();
    });

    it('executes ready-phase inline widget initializers after sanitizing the inert markup', async () => {
        installScriptExecutionMock();

        const host = document.createElement('div');
        document.body.appendChild(host);

        const renderer = createWidgetRenderer(host);
        renderer.render({
            widgetId: 'chart-widget',
            title: 'Chart widget',
            description: '',
            phase: 'ready',
            html: [
                '<div id="chart-probe"></div>',
                '<script>',
                'window.__touchaiWidgetInitRan = true;',
                'document.getElementById("chart-probe").dataset.initialized = "true";',
                '</script>',
            ].join(''),
        });

        await waitForWidgetRender();

        expect(
            (window as Window & { __touchaiWidgetInitRan?: boolean }).__touchaiWidgetInitRan
        ).toBe(true);
        expect(host.querySelector('#chart-probe')?.getAttribute('data-initialized')).toBe('true');

        renderer.destroy();
    });

    it('waits for an allowed external widget script before running the following initializer', async () => {
        installScriptExecutionMock();

        const host = document.createElement('div');
        document.body.appendChild(host);

        const renderer = createWidgetRenderer(host);
        renderer.render({
            widgetId: 'chart-widget',
            title: 'Chart widget',
            description: '',
            phase: 'ready',
            html: [
                '<div style="position: relative; width: 100%; height: 300px;">',
                '<canvas id="myChart"></canvas>',
                '</div>',
                '<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js"></script>',
                '<script>',
                'if (window.Chart) new window.Chart(document.getElementById("myChart"), {});',
                '</script>',
            ].join(''),
        });

        await waitForWidgetRender();

        expect(
            (window as Window & { __touchaiChartConstructed?: boolean }).__touchaiChartConstructed
        ).toBe(true);

        renderer.destroy();
    });
});
