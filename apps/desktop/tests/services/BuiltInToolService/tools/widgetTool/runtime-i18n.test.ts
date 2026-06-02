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
        const isScriptReplacement =
            newChild instanceof HTMLScriptElement && oldChild instanceof HTMLScriptElement;
        const originalInlineScript =
            isScriptReplacement && !newChild.src ? newChild.textContent || '' : null;

        if (originalInlineScript !== null) {
            newChild.textContent = '';
        }

        const replacedNode = nativeReplaceChild.call(this, newChild, oldChild);

        if (!isScriptReplacement) {
            return replacedNode;
        }

        if (newChild instanceof HTMLScriptElement && newChild.src) {
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
        } else if (originalInlineScript !== null) {
            new Function(originalInlineScript)();
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
        delete (window as Window & { sendPrompt?: unknown }).sendPrompt;
        delete (window as Window & { openLink?: unknown }).openLink;
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

    it('dispatches widget prompt actions from data attributes and safe legacy onclick handlers', async () => {
        const sendPrompt = vi.fn();
        (window as Window & { sendPrompt?: (text: string) => void }).sendPrompt = sendPrompt;

        const host = document.createElement('div');
        document.body.appendChild(host);

        const renderer = createWidgetRenderer(host);
        renderer.render({
            widgetId: 'action-widget',
            title: 'Action widget',
            description: '',
            phase: 'ready',
            html: [
                '<button type="button" data-send-prompt="Compare one more scenario">Compare</button>',
                '<svg viewBox="0 0 80 32">',
                `<g id="legacy-node" onclick="sendPrompt('Tell me more about this stop')">`,
                '<rect width="80" height="32"></rect>',
                '</g>',
                '</svg>',
            ].join(''),
        });

        await waitForWidgetRender();

        host.querySelector('button')?.dispatchEvent(
            new MouseEvent('click', { bubbles: true, cancelable: true })
        );
        host.querySelector('#legacy-node')?.dispatchEvent(
            new MouseEvent('click', { bubbles: true, cancelable: true })
        );

        expect(sendPrompt).toHaveBeenCalledTimes(2);
        expect(sendPrompt).toHaveBeenNthCalledWith(1, 'Compare one more scenario');
        expect(sendPrompt).toHaveBeenNthCalledWith(2, 'Tell me more about this stop');
        expect(host.querySelector('#legacy-node')?.getAttribute('onclick')).toBeNull();

        renderer.destroy();
    });

    it('ignores unsafe data-open-link action URLs', async () => {
        const openLink = vi.fn();
        (window as Window & { openLink?: (url: string) => void }).openLink = openLink;

        const host = document.createElement('div');
        document.body.appendChild(host);

        const renderer = createWidgetRenderer(host);
        renderer.render({
            widgetId: 'link-action-widget',
            title: 'Link action widget',
            description: '',
            phase: 'ready',
            html: [
                '<button type="button" data-open-link="https://example.com/report">Open report</button>',
                '<button id="unsafe-link" type="button" data-open-link="javascript:alert(1)">Unsafe</button>',
            ].join(''),
        });

        await waitForWidgetRender();

        host.querySelector('button')?.dispatchEvent(
            new MouseEvent('click', { bubbles: true, cancelable: true })
        );
        host.querySelector('#unsafe-link')?.dispatchEvent(
            new MouseEvent('click', { bubbles: true, cancelable: true })
        );

        expect(openLink).toHaveBeenCalledOnce();
        expect(openLink).toHaveBeenCalledWith('https://example.com/report');

        renderer.destroy();
    });

    it('leaves relative anchor links for the host router', async () => {
        const openLink = vi.fn();
        (window as Window & { openLink?: (url: string) => void }).openLink = openLink;

        const host = document.createElement('div');
        document.body.appendChild(host);

        const renderer = createWidgetRenderer(host);
        renderer.render({
            widgetId: 'relative-link-widget',
            title: 'Relative link widget',
            description: '',
            phase: 'ready',
            html: '<a id="internal-link" href="/settings">Settings</a>',
        });

        await waitForWidgetRender();

        let wasPreventedByWidget = true;
        host.addEventListener('click', (event) => {
            wasPreventedByWidget = event.defaultPrevented;
            event.preventDefault();
        });

        const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
        host.querySelector('#internal-link')?.dispatchEvent(clickEvent);

        expect(wasPreventedByWidget).toBe(false);
        expect(openLink).not.toHaveBeenCalled();

        renderer.destroy();
    });

    it('keeps script-bound widget interactions available for internal calculations', async () => {
        installScriptExecutionMock();

        const host = document.createElement('div');
        document.body.appendChild(host);

        const renderer = createWidgetRenderer(host);
        renderer.render({
            widgetId: 'calculation-widget',
            title: 'Calculation widget',
            description: '',
            phase: 'ready',
            html: [
                '<button id="increment" type="button">Increment</button>',
                '<span id="count">0</span>',
                '<script>',
                'const button = document.getElementById("increment");',
                'const output = document.getElementById("count");',
                'button.addEventListener("click", () => { output.textContent = String(Number(output.textContent) + 1); });',
                '</script>',
            ].join(''),
        });

        await waitForWidgetRender();

        host.querySelector('#increment')?.dispatchEvent(
            new MouseEvent('click', { bubbles: true, cancelable: true })
        );

        expect(host.querySelector('#count')?.textContent).toBe('1');

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
