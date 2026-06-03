import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    createShowWidgetBaseStyles,
    createWidgetRenderer,
} from '@/services/BuiltInToolService/tools/widgetTool/showWidget/runtime';

const nativeReplaceChild = Node.prototype.replaceChild;
const nativeAppendChild = Node.prototype.appendChild;

async function waitForWidgetRender(): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
}

async function waitForCondition(condition: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 40; attempt += 1) {
        if (condition()) {
            return;
        }

        await new Promise((resolve) => window.setTimeout(resolve, 0));
    }

    throw new Error('Timed out waiting for widget condition');
}

function installExternalScriptLoadMock(): void {
    const scheduleMockScriptLoad = (node: Node): void => {
        if (!(node instanceof HTMLScriptElement) || !node.src) {
            return;
        }

        window.setTimeout(() => {
            if (node.src.includes('chart.umd.js')) {
                (window as Window & { Chart?: unknown }).Chart = function Chart() {
                    (
                        window as Window & { __touchaiChartConstructed?: boolean }
                    ).__touchaiChartConstructed = true;
                };
            }
            node.dispatchEvent(new Event('load'));
        }, 0);
    };

    vi.spyOn(Node.prototype, 'replaceChild').mockImplementation(function (
        this: Node,
        newChild: Node,
        oldChild: Node
    ) {
        const isScriptReplacement =
            newChild instanceof HTMLScriptElement && oldChild instanceof HTMLScriptElement;

        const replacedNode = nativeReplaceChild.call(this, newChild, oldChild);

        if (!isScriptReplacement) {
            return replacedNode;
        }

        scheduleMockScriptLoad(newChild);

        return replacedNode;
    } as typeof Node.prototype.replaceChild);

    vi.spyOn(Node.prototype, 'appendChild').mockImplementation(function (
        this: Node,
        newChild: Node
    ) {
        const appendedNode = nativeAppendChild.call(this, newChild);
        scheduleMockScriptLoad(newChild);
        return appendedNode;
    } as typeof Node.prototype.appendChild);
}

describe('show widget renderer i18n opt-out', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        Node.prototype.replaceChild = nativeReplaceChild;
        Node.prototype.appendChild = nativeAppendChild;
        document.body.innerHTML = '';
        delete document.body.dataset.widgetBody;
        delete document.body.dataset.thisDocumentBody;
        delete document.documentElement.dataset.widgetDocumentElement;
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

    it('preserves style blocks from full document head markup', async () => {
        const host = document.createElement('div');
        document.body.appendChild(host);

        const renderer = createWidgetRenderer(host);
        renderer.render({
            widgetId: 'full-document-style-widget',
            title: 'Full document style widget',
            description: '',
            phase: 'ready',
            html: [
                '<!doctype html><html><head>',
                '<style>.head-style-card{display:grid;color:rgb(12, 68, 124);}</style>',
                '</head><body>',
                '<section class="head-style-card">Head styled content</section>',
                '</body></html>',
            ].join(''),
        });

        await waitForWidgetRender();

        const style = host.querySelector('style:not([data-touchai-widget-base-style])');
        const card = host.querySelector<HTMLElement>('.head-style-card');

        expect(card?.textContent).toBe('Head styled content');
        expect(style?.textContent).toContain('.head-style-card');
        expect(style?.textContent).toContain('[data-touchai-widget-host=');
        expect(style?.textContent).toContain('display:grid');

        renderer.destroy();
    });

    it('keeps runtime-injected base styles aligned with flat visual rules', () => {
        const css = createShowWidgetBaseStyles('[data-touchai-widget-host="probe"]');

        expect(css).not.toMatch(/\bbox-shadow\s*:/i);
        expect(css).not.toMatch(/\btext-shadow\s*:/i);
        expect(css).not.toMatch(/\bfilter\s*:\s*(?!none\b)/i);
    });

    it('caps rendered widgets at the designed visualization width', () => {
        const css = createShowWidgetBaseStyles('[data-touchai-widget-host="probe"]');
        const host = document.createElement('div');
        document.body.appendChild(host);

        const renderer = createWidgetRenderer(host);
        const root = host.querySelector<HTMLElement>('[data-touchai-widget-root="true"]');

        expect(css).toContain('max-width: 680px');
        expect(css).toContain('margin-left: auto');
        expect(css).toContain('margin-right: auto');
        expect(host.style.width).toBe('100%');
        expect(host.style.maxWidth).toBe('680px');
        expect(host.style.marginLeft).toBe('auto');
        expect(host.style.marginRight).toBe('auto');
        expect(root?.style.width).toBe('100%');
        expect(root?.style.maxWidth).toBe('100%');

        renderer.destroy();
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

    it('hardens external anchor fallback opens without an opener reference', async () => {
        const open = vi.spyOn(window, 'open').mockImplementation(() => null);
        const host = document.createElement('div');
        document.body.appendChild(host);

        const renderer = createWidgetRenderer(host);
        renderer.render({
            widgetId: 'fallback-link-widget',
            title: 'Fallback link widget',
            description: '',
            phase: 'ready',
            html: '<a id="external-link" href="https://example.com/report">Report</a>',
        });

        await waitForWidgetRender();

        host.querySelector('#external-link')?.dispatchEvent(
            new MouseEvent('click', { bubbles: true, cancelable: true })
        );

        expect(open).toHaveBeenCalledWith(
            'https://example.com/report',
            '_blank',
            'noopener,noreferrer'
        );

        renderer.destroy();
    });

    it('keeps script-bound widget interactions available for internal calculations', async () => {
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

    it('scopes direct document body, documentElement, and this.document access to the widget root', async () => {
        const host = document.createElement('div');
        document.body.appendChild(host);

        const renderer = createWidgetRenderer(host);
        renderer.render({
            widgetId: 'document-facade-widget',
            title: 'Document facade widget',
            description: '',
            phase: 'ready',
            html: [
                '<section id="inside">content</section>',
                '<script>',
                'document.body.dataset.widgetBody = "scoped";',
                'document.documentElement.dataset.widgetDocumentElement = "scoped";',
                'this.document.body.dataset.thisDocumentBody = "scoped";',
                'const child = document.createElement("span");',
                'child.id = "body-child";',
                'document.body.appendChild(child);',
                '</script>',
            ].join(''),
        });

        await waitForWidgetRender();

        const root = host.querySelector<HTMLElement>('[data-touchai-widget-root="true"]');

        expect(document.body.dataset.widgetBody).toBeUndefined();
        expect(document.documentElement.dataset.widgetDocumentElement).toBeUndefined();
        expect(document.body.dataset.thisDocumentBody).toBeUndefined();
        expect(document.body.querySelector(':scope > #body-child')).toBeNull();
        expect(root?.dataset.widgetBody).toBe('scoped');
        expect(root?.dataset.widgetDocumentElement).toBe('scoped');
        expect(root?.dataset.thisDocumentBody).toBe('scoped');
        expect(root?.querySelector('#body-child')).not.toBeNull();

        renderer.destroy();
    });

    it('runs button-bound inline calculations that auto-trigger on render', async () => {
        const host = document.createElement('div');
        document.body.appendChild(host);

        const renderer = createWidgetRenderer(host);
        renderer.render({
            widgetId: 'coin-calculation-widget',
            title: 'Coin calculation widget',
            description: '',
            phase: 'ready',
            html: [
                '<input id="amount" type="number" value="41">',
                '<button id="calculate" type="button">Calculate</button>',
                '<div id="result"></div>',
                '<div id="steps"></div>',
                '<script>',
                'document.getElementById("calculate").addEventListener("click", function() {',
                'const amount = parseInt(document.getElementById("amount").value);',
                'const coins = [25, 10, 5, 1];',
                'let remaining = amount;',
                'let totalCoins = 0;',
                'for (const coin of coins) {',
                'const count = Math.floor(remaining / coin);',
                'remaining %= coin;',
                'totalCoins += count;',
                '}',
                'document.getElementById("result").textContent = String(totalCoins);',
                'document.getElementById("steps").textContent = "done";',
                '});',
                'document.getElementById("calculate").click();',
                '</script>',
            ].join(''),
        });

        await waitForWidgetRender();

        expect(host.querySelector('#result')?.textContent).toBe('4');
        expect(host.querySelector('#steps')?.textContent).toBe('done');

        renderer.destroy();
    });

    it('binds duplicate-id widget scripts to their own rendered root', async () => {
        const firstHost = document.createElement('div');
        const secondHost = document.createElement('div');
        document.body.append(firstHost, secondHost);

        const firstRenderer = createWidgetRenderer(firstHost);
        const secondRenderer = createWidgetRenderer(secondHost);
        const duplicateIdHtml = [
            '<button id="btn-s" type="button">Next</button>',
            '<span id="st">idle</span>',
            '<script>',
            'window.document.getElementById("btn-s").onclick = function() {',
            'window.document.getElementById("st").textContent = "clicked";',
            '};',
            '</script>',
        ].join('');

        firstRenderer.render({
            widgetId: 'first-duplicate-id-widget',
            title: 'First duplicate id widget',
            description: '',
            phase: 'ready',
            html: duplicateIdHtml,
        });
        await waitForCondition(() => firstHost.querySelector('[id="st"]')?.textContent === 'idle');

        secondRenderer.render({
            widgetId: 'second-duplicate-id-widget',
            title: 'Second duplicate id widget',
            description: '',
            phase: 'ready',
            html: duplicateIdHtml,
        });

        await waitForCondition(
            () =>
                firstHost.querySelector('[id="st"]')?.textContent === 'idle' &&
                secondHost.querySelector('[id="st"]')?.textContent === 'idle'
        );

        secondHost
            .querySelector('[id="btn-s"]')
            ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

        expect(firstHost.querySelector('[id="st"]')?.textContent).toBe('idle');
        expect(secondHost.querySelector('[id="st"]')?.textContent).toBe('clicked');

        firstRenderer.destroy();
        secondRenderer.destroy();
    });

    it('keeps sample-style onclick timers scoped when duplicate widgets are rendered', async () => {
        const firstHost = document.createElement('div');
        const secondHost = document.createElement('div');
        document.body.append(firstHost, secondHost);

        const firstRenderer = createWidgetRenderer(firstHost);
        const secondRenderer = createWidgetRenderer(secondHost);
        const sampleStyleHtml = [
            '<section>',
            '<button id="btn-s" type="button">Next</button>',
            '<button id="btn-a" type="button">Auto</button>',
            '<span id="st">idle</span>',
            '<div id="rem">41 cents</div>',
            '<div class="d" data-v="25"><span class="cn">x0</span></div>',
            '<div class="d" data-v="10"><span class="cn">x0</span></div>',
            '<script>',
            'const D = [25, 10, 5, 1];',
            'let rem = 41;',
            'let stepLock = false;',
            'let autoId = null;',
            'function ui() {',
            'document.getElementById("rem").textContent = rem + " cents";',
            'document.querySelectorAll(".d").forEach((element) => {',
            'element.querySelector(".cn").textContent = "x" + (Number(element.dataset.v) <= rem ? 1 : 0);',
            '});',
            '}',
            'function step() {',
            'if (stepLock || rem <= 0) return;',
            'const ch = D.find((coin) => coin <= rem);',
            'stepLock = true;',
            'document.getElementById("st").textContent = "selected " + ch;',
            'setTimeout(() => {',
            'rem -= ch;',
            'ui();',
            'document.getElementById("st").textContent = "remaining " + rem;',
            'stepLock = false;',
            '}, 0);',
            '}',
            'function auto() {',
            'if (autoId) { clearInterval(autoId); autoId = null; return; }',
            'autoId = setInterval(() => { if (!stepLock && rem > 0) step(); }, 10);',
            '}',
            'document.getElementById("btn-s").onclick = step;',
            'document.getElementById("btn-a").onclick = auto;',
            'ui();',
            '</script>',
            '</section>',
        ].join('');

        firstRenderer.render({
            widgetId: 'first-sample-style-widget',
            title: 'First sample style widget',
            description: '',
            phase: 'ready',
            html: sampleStyleHtml,
        });
        await waitForCondition(
            () => firstHost.querySelector('[id="rem"]')?.textContent === '41 cents'
        );

        secondRenderer.render({
            widgetId: 'second-sample-style-widget',
            title: 'Second sample style widget',
            description: '',
            phase: 'ready',
            html: sampleStyleHtml,
        });
        await waitForCondition(
            () =>
                firstHost.querySelector('[id="rem"]')?.textContent === '41 cents' &&
                secondHost.querySelector('[id="rem"]')?.textContent === '41 cents'
        );

        secondHost
            .querySelector('[id="btn-s"]')
            ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

        await waitForCondition(
            () => secondHost.querySelector('[id="rem"]')?.textContent === '16 cents'
        );

        expect(firstHost.querySelector('[id="st"]')?.textContent).toBe('idle');
        expect(firstHost.querySelector('[id="rem"]')?.textContent).toBe('41 cents');
        expect(secondHost.querySelector('[id="st"]')?.textContent).toBe('remaining 16');
        expect(secondHost.querySelector('[id="rem"]')?.textContent).toBe('16 cents');

        firstRenderer.destroy();
        secondRenderer.destroy();
    });

    it('keeps sample-style addEventListener SVG actions interactive', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const host = document.createElement('div');
        document.body.appendChild(host);

        const renderer = createWidgetRenderer(host);
        renderer.render({
            widgetId: 'svg-action-widget',
            title: 'SVG action widget',
            description: '',
            phase: 'ready',
            html: [
                '<section>',
                '<button id="btn-step" type="button">Step</button>',
                '<svg width="100%" viewBox="0 0 160 80" id="coin-svg">',
                '<g id="step-area"></g>',
                '</svg>',
                '<div id="explanation">Ready</div>',
                '<script>',
                'const stepArea = document.getElementById("step-area");',
                'const explanation = document.getElementById("explanation");',
                'explanation.dataset.scriptRan = "true";',
                'document.getElementById("btn-step").dataset.bound = "true";',
                'let chosen = [];',
                'function renderSteps(){',
                'stepArea.innerHTML = "";',
                'chosen.forEach((coin, index) => {',
                'const group = document.createElementNS("http://www.w3.org/2000/svg", "g");',
                'group.innerHTML = `<rect x="${10 + index * 50}" y="20" width="40" height="24" rx="4"></rect><text x="${30 + index * 50}" y="34">${coin}</text>`;',
                'stepArea.appendChild(group);',
                '});',
                'explanation.textContent = `picked ${chosen.join(",")}`;',
                '}',
                'document.getElementById("btn-step").addEventListener("click", () => {',
                'chosen.push(25);',
                'renderSteps();',
                '});',
                '</script>',
                '</section>',
            ].join(''),
        });

        await waitForWidgetRender();

        const button = host.querySelector('[id="btn-step"]');
        expect(button).not.toBeNull();
        expect(consoleError).not.toHaveBeenCalled();
        expect(host.querySelector<HTMLElement>('[id="explanation"]')?.dataset.scriptRan).toBe(
            'true'
        );
        expect(host.querySelector<HTMLElement>('[id="btn-step"]')?.dataset.bound).toBe('true');

        button?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

        expect(consoleError).not.toHaveBeenCalled();

        await waitForCondition(
            () => host.querySelector('[id="explanation"]')?.textContent === 'picked 25'
        );

        expect(host.querySelector('[id="step-area"] rect')).not.toBeNull();
        expect(host.querySelector('[id="step-area"] text')?.textContent).toBe('25');

        renderer.destroy();
    });

    it('keeps reported coin-change controls, SVG updates, and timers interactive', async () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const host = document.createElement('div');
        document.body.appendChild(host);

        const renderer = createWidgetRenderer(host);
        renderer.render({
            widgetId: 'reported-coin-change-widget',
            title: 'Reported coin change widget',
            description: '',
            phase: 'ready',
            html: [
                '<section style="display:grid;gap:16px;max-width:640px">',
                '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">',
                '<label>Amount</label>',
                '<input type="range" id="amount-slider" min="1" max="99" value="41" />',
                '<span id="amount-display">41</span>',
                '</div>',
                '<div>',
                '<button id="btn-auto" type="button">Auto</button>',
                '<button id="btn-step" type="button">Step</button>',
                '<button id="btn-reset" type="button">Reset</button>',
                '</div>',
                '<svg width="100%" viewBox="0 0 640 260" id="coin-svg">',
                '<text x="30" y="20">Denominations</text>',
                '<g id="denom-row"></g>',
                '<text x="30" y="100">Steps</text>',
                '<g id="step-area"></g>',
                '<text x="30" y="220">Result</text>',
                '<g id="result-area"></g>',
                '</svg>',
                '<div id="explanation">Ready</div>',
                '</section>',
                '<script>',
                'const DENOMS = [25, 10, 5, 1];',
                "const COIN_COLORS = {25:'#534AB7',10:'#0F6E56',5:'#BA7517',1:'#D85A30'};",
                "const COIN_NAMES = {25:'25c',10:'10c',5:'5c',1:'1c'};",
                'let target = 41;',
                'let chosen = [];',
                'let remaining = 41;',
                'let animTimer = null;',
                "const denomRow = document.getElementById('denom-row');",
                "const stepArea = document.getElementById('step-area');",
                "const resultArea = document.getElementById('result-area');",
                "const explanation = document.getElementById('explanation');",
                'function drawDenoms(){',
                "denomRow.innerHTML = '';",
                'DENOMS.forEach((d,i)=>{',
                'const x = 30 + i*90;',
                "const g = document.createElementNS('http://www.w3.org/2000/svg','g');",
                'g.innerHTML = `<rect x="${x}" y="30" width="72" height="44" rx="8" fill="${COIN_COLORS[d]}" opacity="0.18" stroke="${COIN_COLORS[d]}" stroke-width="0.5"></rect><text x="${x+36}" y="48" text-anchor="middle" dominant-baseline="central">${COIN_NAMES[d]}</text>`;',
                'denomRow.appendChild(g);',
                '});',
                '}',
                'function reset(){',
                'if(animTimer){clearInterval(animTimer);animTimer=null;}',
                'chosen = [];',
                'remaining = target;',
                "stepArea.innerHTML = '';",
                "resultArea.innerHTML = '';",
                'explanation.textContent = `Target ${target}. Greedy picks the largest possible coin each step.`;',
                "document.getElementById('btn-step').disabled = false;",
                "document.getElementById('btn-auto').disabled = false;",
                '}',
                'function doStep(){',
                'if(remaining<=0){',
                "document.getElementById('btn-step').disabled = true;",
                "document.getElementById('btn-auto').disabled = true;",
                'showResult();',
                'return false;',
                '}',
                'let pick = DENOMS.find(d=>d<=remaining);',
                'chosen.push(pick);',
                'remaining -= pick;',
                'renderSteps();',
                'return true;',
                '}',
                'function renderSteps(){',
                "stepArea.innerHTML = '';",
                'let totalSoFar = 0;',
                'chosen.forEach((c,i)=>{',
                'totalSoFar += c;',
                'const x = 30 + (i%10)*60;',
                'const y = 110 + Math.floor(i/10)*50;',
                "const g = document.createElementNS('http://www.w3.org/2000/svg','g');",
                'g.innerHTML = `<rect x="${x}" y="${y}" width="48" height="36" rx="8" fill="${COIN_COLORS[c]}" opacity="0.22" stroke="${COIN_COLORS[c]}" stroke-width="0.5"></rect><text x="${x+24}" y="${y+14}" text-anchor="middle" dominant-baseline="central">${COIN_NAMES[c]}</text><text x="${x+24}" y="${y+29}" text-anchor="middle" dominant-baseline="central">total ${totalSoFar}</text>`;',
                'stepArea.appendChild(g);',
                '});',
                'explanation.textContent = `Picked ${chosen.length}, total ${totalSoFar}, remaining ${remaining}.`;',
                '}',
                'function showResult(){',
                'resultArea.innerHTML = \'<text x="30" y="242">done</text>\';',
                '}',
                "document.getElementById('amount-slider').addEventListener('input',e=>{",
                'target = +e.target.value;',
                "document.getElementById('amount-display').textContent = target;",
                'drawDenoms();',
                'reset();',
                '});',
                "document.getElementById('btn-step').addEventListener('click',doStep);",
                "document.getElementById('btn-reset').addEventListener('click',reset);",
                "document.getElementById('btn-auto').addEventListener('click',()=>{",
                'if(animTimer){clearInterval(animTimer);animTimer=null;return;}',
                'animTimer = setInterval(()=>{',
                'if(!doStep()) clearInterval(animTimer);',
                '},500);',
                '});',
                'drawDenoms();',
                'reset();',
                '</script>',
            ].join(''),
        });

        await waitForCondition(() => host.querySelectorAll('[id="denom-row"] rect').length === 4);

        expect(consoleError).not.toHaveBeenCalled();
        expect(host.querySelector('[id="explanation"]')?.textContent).toContain('Target 41');

        host.querySelector('[id="btn-step"]')?.dispatchEvent(
            new MouseEvent('click', { bubbles: true, cancelable: true })
        );
        await waitForCondition(
            () =>
                host.querySelector('[id="explanation"]')?.textContent ===
                'Picked 1, total 25, remaining 16.'
        );
        expect(host.querySelector('[id="step-area"] rect')).not.toBeNull();
        expect(host.querySelector('[id="step-area"] text')?.textContent).toBe('25c');

        const slider = host.querySelector<HTMLInputElement>('[id="amount-slider"]');
        expect(slider).not.toBeNull();
        slider!.value = '30';
        slider!.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        expect(host.querySelector('[id="amount-display"]')?.textContent).toBe('30');
        expect(host.querySelector('[id="step-area"] rect')).toBeNull();
        expect(host.querySelector('[id="explanation"]')?.textContent).toContain('Target 30');

        host.querySelector('[id="btn-auto"]')?.dispatchEvent(
            new MouseEvent('click', { bubbles: true, cancelable: true })
        );
        await new Promise((resolve) => window.setTimeout(resolve, 550));
        expect(host.querySelector('[id="explanation"]')?.textContent).toBe(
            'Picked 1, total 25, remaining 5.'
        );
        host.querySelector('[id="btn-auto"]')?.dispatchEvent(
            new MouseEvent('click', { bubbles: true, cancelable: true })
        );

        expect(consoleError).not.toHaveBeenCalled();

        renderer.destroy();
    });

    it('does not execute non-classic inline script payloads', async () => {
        const host = document.createElement('div');
        document.body.appendChild(host);

        const renderer = createWidgetRenderer(host);
        renderer.render({
            widgetId: 'json-script-widget',
            title: 'JSON script widget',
            description: '',
            phase: 'ready',
            html: [
                '<script type="application/json">',
                '{"value":"window.__touchaiWidgetInitRan = true"}',
                '</script>',
            ].join(''),
        });

        await waitForWidgetRender();

        expect(
            (window as Window & { __touchaiWidgetInitRan?: boolean }).__touchaiWidgetInitRan
        ).toBeUndefined();

        renderer.destroy();
    });

    it('does not load unsafe external widget script URLs captured before sanitization', async () => {
        const appendedScriptUrls: string[] = [];
        vi.spyOn(Node.prototype, 'appendChild').mockImplementation(function (
            this: Node,
            newChild: Node
        ) {
            if (newChild instanceof HTMLScriptElement) {
                appendedScriptUrls.push(newChild.src);
            }

            return nativeAppendChild.call(this, newChild);
        } as typeof Node.prototype.appendChild);

        const host = document.createElement('div');
        document.body.appendChild(host);

        const renderer = createWidgetRenderer(host);
        renderer.render({
            widgetId: 'unsafe-script-url-widget',
            title: 'Unsafe script URL widget',
            description: '',
            phase: 'ready',
            html: [
                '<section>',
                '<div id="result">pending</div>',
                '</section>',
                '<script src="javascript:window.__touchaiWidgetInitRan=true"></script>',
                '<script src="/local-widget.js"></script>',
                '<script>',
                'document.getElementById("result").textContent = "safe inline ran";',
                '</script>',
            ].join(''),
        });

        await waitForWidgetRender();

        expect(appendedScriptUrls).toEqual([]);
        expect(
            (window as Window & { __touchaiWidgetInitRan?: boolean }).__touchaiWidgetInitRan
        ).toBeUndefined();
        expect(host.querySelector('#result')?.textContent).toBe('safe inline ran');

        renderer.destroy();
    });

    it('waits for an allowed external widget script before running the following initializer', async () => {
        installExternalScriptLoadMock();

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
