import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    createShowWidgetBaseStyles,
    createWidgetRenderer,
} from '@/services/BuiltInToolService/tools/widgetTool/showWidget/runtime';

const nativeReplaceChild = Node.prototype.replaceChild;

async function waitForWidgetRender(): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
}

function installScriptExecutionMock(): void {
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
        vi.restoreAllMocks();
        Node.prototype.replaceChild = nativeReplaceChild;
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

    it('preserves widget style blocks and inline styles during ready rendering', async () => {
        const host = document.createElement('div');
        document.body.appendChild(host);

        const renderer = createWidgetRenderer(host);
        renderer.render({
            widgetId: 'styled-widget',
            title: 'Styled widget',
            description: '',
            phase: 'ready',
            html: [
                '<style>.route-card{display:grid;gap:8px;color:rgb(12, 68, 124);}</style>',
                '<section class="route-card" style="border: 1px solid rgb(24, 95, 165); padding: 12px;">',
                '<span>越秀公园</span>',
                '</section>',
            ].join(''),
        });

        await waitForWidgetRender();

        const style = host.querySelector('style:not([data-touchai-widget-base-style])');
        const card = host.querySelector<HTMLElement>('.route-card');

        expect(style?.textContent).toContain('.route-card');
        expect(style?.textContent).toContain('[data-touchai-widget-host=');
        expect(style?.textContent).toContain('display:grid');
        expect(card?.getAttribute('style')).toContain('border: 1px solid');
        expect(card?.getAttribute('style')).toContain('padding: 12px');

        renderer.destroy();
    });

    it('keeps runtime-injected base styles aligned with flat visual rules', () => {
        const css = createShowWidgetBaseStyles('[data-touchai-widget-host="probe"]');

        expect(css).not.toMatch(/\bbox-shadow\s*:/i);
        expect(css).not.toMatch(/\btext-shadow\s*:/i);
        expect(css).not.toMatch(/\bfilter\s*:\s*(?!none\b)/i);
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
