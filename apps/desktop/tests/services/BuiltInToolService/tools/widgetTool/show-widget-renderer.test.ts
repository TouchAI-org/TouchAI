// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWidgetRenderer } from '@/services/BuiltInToolService/tools/widgetTool/showWidget/runtime';
import {
    SHOW_WIDGET_DRAFT_MIN_INTERVAL_MS,
    SHOW_WIDGET_THEME_FALLBACKS,
} from '@/services/BuiltInToolService/tools/widgetTool/showWidget/runtimeConstants';
import { log } from '@/services/ObservabilityService';

/**
 * The renderer is what turns the model's HTML into something the user can look at and click.
 * These tests drive it through its public contract only: a real host element in, rendered DOM,
 * sent prompts, opened links and cleared state out.
 */

async function waitForCondition(condition: () => boolean): Promise<void> {
    await vi.waitFor(() => {
        expect(condition()).toBe(true);
    });
}

function mountHost(): HTMLElement {
    const host = document.createElement('div');
    document.body.appendChild(host);
    return host;
}

function widgetRoot(host: HTMLElement): HTMLElement {
    return host.querySelector<HTMLElement>('[data-touchai-widget-root="true"]')!;
}

function renderedStyles(host: HTMLElement): string[] {
    return Array.from(host.querySelectorAll('style:not([data-touchai-widget-base-style])')).map(
        (style) => style.textContent ?? ''
    );
}

function renderReady(
    renderer: ReturnType<typeof createWidgetRenderer>,
    html: string,
    extra: Partial<{ widgetId: string; title: string; description: string }> = {}
): void {
    renderer.render({
        widgetId: extra.widgetId ?? 'widget-1',
        title: extra.title ?? 'Widget',
        description: extra.description ?? '',
        phase: 'ready',
        html,
    });
}

function renderDraft(
    renderer: ReturnType<typeof createWidgetRenderer>,
    html: string,
    extra: Partial<{ widgetId: string; title: string; description: string }> = {}
): void {
    renderer.render({
        widgetId: extra.widgetId ?? 'widget-1',
        title: extra.title ?? 'Widget',
        description: extra.description ?? '',
        phase: 'draft',
        html,
    });
}

describe('user reads a widget the model wrote', () => {
    afterEach(() => {
        document.body.innerHTML = '';
        delete (window as Window & { sendPrompt?: unknown }).sendPrompt;
        delete (window as Window & { openLink?: unknown }).openLink;
    });

    it('user sees the widget styles the model wrote confined to that one widget', async () => {
        const host = mountHost();
        const renderer = createWidgetRenderer(host);
        const hostSelector = `[data-touchai-widget-host="${host.dataset.touchaiWidgetHost}"]`;

        renderReady(
            renderer,
            [
                '<style>',
                '@import url("https://fonts.example/remote.css");',
                ':root{--brand:#123456;}',
                'html,body{margin:0;}',
                ':host{display:block;}',
                '.card,.card>a:hover{color:red;}',
                '@media (min-width:600px){.card{padding:8px;}}',
                '@keyframes pulse{from{opacity:0}to{opacity:1}}',
                '[data-x="a,b"]{color:blue;}',
                '.quote::before{content:"}";}',
                '.plain{color:red}',
                '</style>',
                '<section class="card">Card</section>',
            ].join('\n')
        );

        await waitForCondition(() => host.querySelector('.card') !== null);

        const [styleText] = renderedStyles(host);
        expect(styleText).toBeDefined();

        // The user's page must not be restyled by widget CSS, so every authored rule has to end
        // up behind the widget's own host attribute.
        expect(styleText).toContain(`${hostSelector}{--brand:#123456;}`);
        expect(styleText).toContain(`${hostSelector}, ${hostSelector}{margin:0;}`);
        expect(styleText).toContain(`${hostSelector}{display:block;}`);
        expect(styleText).toContain(
            `${hostSelector} .card, ${hostSelector} .card>a:hover{color:red;}`
        );
        expect(styleText).toContain(`${hostSelector} [data-x="a,b"]{color:blue;}`);
        expect(styleText).toContain(`${hostSelector} .quote::before{content:"}";}`);
        expect(styleText).toContain(`${hostSelector} .plain{color:red}`);

        // Responsive rules and keyframes have to survive, otherwise a responsive widget renders
        // broken at every width.
        expect(styleText).toContain(
            `@media (min-width:600px){${hostSelector} .card{padding:8px;}}`
        );
        expect(styleText).toContain('@keyframes pulse{from{opacity:0}to{opacity:1}}');

        // Remote imports would load third-party CSS into the app; they are dropped.
        expect(styleText).not.toContain('@import');
        expect(styleText).not.toContain('fonts.example');

        renderer.destroy();
    });

    it('user sees an unfinished style block dropped instead of raw CSS text in the message', async () => {
        const host = mountHost();
        const renderer = createWidgetRenderer(host);

        renderDraft(renderer, '<div>skeleton</div><style>.half{color:red}');

        await waitForCondition(() => host.textContent?.includes('skeleton') === true);

        expect(host.textContent).toContain('skeleton');
        expect(host.textContent).not.toContain('.half');
        expect(renderedStyles(host)).toEqual([]);

        renderer.destroy();
    });

    it('user sees an unfinished script block dropped instead of raw script text in the message', async () => {
        const host = mountHost();
        const renderer = createWidgetRenderer(host);

        renderDraft(renderer, '<div>skeleton</div><script>window.__halfWritten = true');

        await waitForCondition(() => host.textContent?.includes('skeleton') === true);

        expect(host.textContent).toContain('skeleton');
        expect(host.textContent).not.toContain('__halfWritten');
        expect((window as Window & { __halfWritten?: boolean }).__halfWritten).toBeUndefined();

        renderer.destroy();
    });

    it('user sees an unclosed style block in a finished widget dropped rather than break the page', async () => {
        const host = mountHost();
        const renderer = createWidgetRenderer(host);

        renderReady(renderer, '<p>Finished</p><style>.broken{color:red');

        await waitForCondition(() => host.textContent?.includes('Finished') === true);

        expect(host.textContent).toContain('Finished');
        expect(renderedStyles(host)).toEqual(['']);

        renderer.destroy();
    });

    it('user sees the widget labelled for assistive technology even when the model gave no title', async () => {
        const host = mountHost();
        const renderer = createWidgetRenderer(host);

        renderDraft(renderer, '<div>chart</div>', { widgetId: 'chart-1', title: '' });

        expect(host.getAttribute('aria-label')).toBe('ShowWidget');
        expect(host.dataset.widgetId).toBe('chart-1');
        expect(host.dataset.widgetPhase).toBe('draft');

        renderer.destroy();
    });

    it('user sees the widget title used as its accessible label when the model provided one', async () => {
        const host = mountHost();
        const renderer = createWidgetRenderer(host);

        renderDraft(renderer, '<div>chart</div>', { widgetId: 'chart-2', title: 'Revenue chart' });

        expect(host.getAttribute('aria-label')).toBe('Revenue chart');
        expect(host.getAttribute('title')).toBe('Revenue chart');
        expect(host.dataset.widgetPhase).toBe('draft');

        renderer.destroy();
    });

    it('user sees widget images and canvas kept inside the message column', async () => {
        const host = mountHost();
        const renderer = createWidgetRenderer(host);

        renderReady(
            renderer,
            [
                '<img src="https://example.com/chart.png" alt="Chart">',
                '<canvas id="plot"></canvas>',
                '<svg viewBox="0 0 10 10"><rect width="10" height="10"></rect></svg>',
            ].join('')
        );

        await waitForCondition(() => host.querySelector('img') !== null);

        const image = host.querySelector<HTMLElement>('img')!;
        const canvas = host.querySelector<HTMLElement>('canvas')!;
        const svg = host.querySelector<HTMLElement>('svg')!;

        expect(image.style.maxWidth).toBe('100%');
        expect(canvas.style.maxWidth).toBe('100%');
        expect(svg.style.maxWidth).toBe('100%');

        renderer.destroy();
    });
});

describe('user watches a widget draft while the tool is still writing', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('user sees the first draft drawn as soon as it has any content', async () => {
        const host = mountHost();
        const renderer = createWidgetRenderer(host);

        renderDraft(renderer, '<div id="skeleton">Loading chart</div>');

        await waitForCondition(
            () => host.querySelector('#skeleton')?.textContent === 'Loading chart'
        );

        expect(widgetRoot(host).querySelector('#skeleton')).not.toBeNull();

        renderer.destroy();
    });

    it('user sees a burst of draft updates collapsed into the newest one', async () => {
        const host = mountHost();
        const renderer = createWidgetRenderer(host);

        renderDraft(renderer, '<div id="probe">first</div>');
        await waitForCondition(() => host.querySelector('#probe')?.textContent === 'first');

        // Streaming sends far more drafts than a frame can show; drawing each one would make the
        // widget flicker and burn the message column's layout.
        renderDraft(renderer, '<div id="probe">second</div>');
        renderDraft(renderer, '<div id="probe">third</div>');

        expect(host.querySelector('#probe')?.textContent).toBe('first');

        await waitForCondition(() => host.querySelector('#probe')?.textContent === 'third');
        expect(host.querySelector('#probe')?.textContent).toBe('third');
        expect(host.querySelectorAll('#probe')).toHaveLength(1);

        renderer.destroy();
    });

    it('user never gets a draft script executed before the widget is finished', async () => {
        const host = mountHost();
        const renderer = createWidgetRenderer(host);

        renderDraft(renderer, '<script>window.__draftScriptRan = true</script><p>loading</p>');

        await waitForCondition(() => host.textContent?.includes('loading') === true);

        // A draft is a preview of markup, not a program: running the model's script on every
        // streamed chunk would re-run its side effects dozens of times.
        expect(
            (window as Window & { __draftScriptRan?: boolean }).__draftScriptRan
        ).toBeUndefined();
        expect(widgetRoot(host).textContent).toBe('loading');

        renderer.destroy();
    });

    it('user sees the draft updated once after the throttle window instead of on every chunk', async () => {
        const host = mountHost();
        const renderer = createWidgetRenderer(host);

        renderDraft(renderer, '<div id="probe">first</div>');
        await waitForCondition(() => host.querySelector('#probe')?.textContent === 'first');

        renderDraft(renderer, '<div id="probe">second</div>');
        await new Promise((resolve) =>
            window.setTimeout(resolve, SHOW_WIDGET_DRAFT_MIN_INTERVAL_MS + 50)
        );

        expect(host.querySelector('#probe')?.textContent).toBe('second');

        renderer.destroy();
    });
});

describe('user gets a finished widget updated in place', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('user sees the finished widget reuse the draft nodes instead of redrawing the whole block', async () => {
        const host = mountHost();
        const renderer = createWidgetRenderer(host);

        renderDraft(renderer, '<div id="keep">stable</div><p id="change">draft text</p>');
        await waitForCondition(() => host.querySelector('#keep') !== null);

        const keptNode = host.querySelector('#keep');
        const changedNode = host.querySelector('#change');

        renderReady(renderer, '<div id="keep">stable</div><p id="change">final text</p>');

        await waitForCondition(() => host.querySelector('#change')?.textContent === 'final text');

        // Reusing the nodes keeps scroll position, focus and any running animation intact.
        expect(host.querySelector('#keep')).toBe(keptNode);
        expect(host.querySelector('#change')).toBe(changedNode);
        expect(host.querySelectorAll('#keep')).toHaveLength(1);
        expect(host.querySelector('#keep')?.textContent).toBe('stable');

        renderer.destroy();
    });

    it('user sees the widget entrance marker cleared when the fade-in animation ends', async () => {
        const host = mountHost();
        const renderer = createWidgetRenderer(host);

        renderReady(renderer, '<section id="card">Card</section>');

        await waitForCondition(
            () => host.querySelector('#card')?.getAttribute('data-touchai-widget-added') === 'true'
        );

        const card = host.querySelector('#card')!;
        card.dispatchEvent(new Event('animationend'));

        expect(card.getAttribute('data-touchai-widget-added')).toBeNull();

        renderer.destroy();
    });
});

describe('user gets widget scripts run safely', () => {
    afterEach(() => {
        document.body.innerHTML = '';
        delete (window as Window & { __runs?: number }).__runs;
        delete (window as Window & { __afterFailure?: boolean }).__afterFailure;
    });

    it('user does not get the same widget script run twice when the widget re-renders', async () => {
        const host = mountHost();
        const renderer = createWidgetRenderer(host);
        const html = [
            '<div id="count">static</div>',
            '<script>',
            'window.__runs = (window.__runs || 0) + 1;',
            '</script>',
        ].join('');

        renderReady(renderer, html);
        await waitForCondition(() => (window as Window & { __runs?: number }).__runs === 1);

        renderReady(renderer, html);
        await new Promise((resolve) => window.setTimeout(resolve, 50));

        // A widget that appends a row on every run would duplicate its whole UI on re-render.
        expect((window as Window & { __runs?: number }).__runs).toBe(1);
        expect(host.querySelector('#count')?.textContent).toBe('static');
        expect(host.querySelectorAll('#count')).toHaveLength(1);

        renderer.destroy();
    });

    it('user still gets the rest of the widget initialised when one script throws', async () => {
        const consoleError = vi.spyOn(log, 'error').mockImplementation(() => undefined);
        const host = mountHost();
        const renderer = createWidgetRenderer(host);

        renderReady(
            renderer,
            [
                '<div id="result">pending</div>',
                '<script>throw new Error("widget bug")</script>',
                '<script>',
                'window.__afterFailure = true;',
                'document.getElementById("result").textContent = "ready";',
                '</script>',
            ].join('')
        );

        await waitForCondition(() => host.querySelector('#result')?.textContent === 'ready');

        expect((window as Window & { __afterFailure?: boolean }).__afterFailure).toBe(true);
        expect(host.querySelector('#result')?.textContent).toBe('ready');

        consoleError.mockRestore();
        renderer.destroy();
    });

    it('user gets an empty script tag ignored without breaking the widget', async () => {
        const consoleError = vi.spyOn(log, 'error').mockImplementation(() => undefined);
        const host = mountHost();
        const renderer = createWidgetRenderer(host);

        renderReady(renderer, '<div id="content">visible</div><script></script>');

        await waitForCondition(() => host.querySelector('#content') !== null);

        expect(host.querySelector('#content')?.textContent).toBe('visible');
        expect(consoleError).not.toHaveBeenCalled();

        consoleError.mockRestore();
        renderer.destroy();
    });
});

describe('user clicks an action inside a widget', () => {
    afterEach(() => {
        document.body.innerHTML = '';
        delete (window as Window & { sendPrompt?: unknown }).sendPrompt;
        delete (window as Window & { openLink?: unknown }).openLink;
    });

    it('user sees legacy inline handlers turned into safe widget actions', async () => {
        const sendPrompt = vi.fn();
        const openLink = vi.fn();
        (window as Window & { sendPrompt?: (text: string) => void }).sendPrompt = sendPrompt;
        (window as Window & { openLink?: (url: string) => void }).openLink = openLink;

        const host = mountHost();
        const renderer = createWidgetRenderer(host);

        renderReady(
            renderer,
            [
                `<button id="prompt" type="button" onclick="sendPrompt('tell me more')">More</button>`,
                `<button id="escaped" type="button" onclick="sendPrompt('a\\tb\\nc\\bd\\fe')">Escaped</button>`,
                `<button id="link" type="button" onclick="openLink('https://example.com/report')">Report</button>`,
                `<button id="unsupported" type="button" onclick="alert('x')">Alert</button>`,
                `<button id="blank" type="button" onclick="sendPrompt('')">Blank</button>`,
            ].join('')
        );

        await waitForCondition(() => host.querySelector('#prompt') !== null);

        const promptButton = host.querySelector('#prompt')!;
        const escapedButton = host.querySelector('#escaped')!;
        const linkButton = host.querySelector('#link')!;
        const unsupportedButton = host.querySelector('#unsupported')!;
        const blankButton = host.querySelector('#blank')!;

        // The raw handler is gone: only the runtime's own data attributes survive.
        expect(promptButton.getAttribute('onclick')).toBeNull();
        expect(linkButton.getAttribute('onclick')).toBeNull();
        expect(promptButton.getAttribute('data-send-prompt')).toBe('tell me more');
        expect(linkButton.getAttribute('data-open-link')).toBe('https://example.com/report');
        expect(escapedButton.getAttribute('data-send-prompt')).toBe('a\tb\nc\bd\fe');

        // Handlers that are not one of the two supported actions are dropped, not executed.
        expect(unsupportedButton.getAttribute('data-send-prompt')).toBeNull();
        expect(unsupportedButton.getAttribute('data-open-link')).toBeNull();
        expect(blankButton.getAttribute('data-send-prompt')).toBeNull();

        promptButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        escapedButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        linkButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

        expect(sendPrompt).toHaveBeenCalledTimes(2);
        expect(sendPrompt).toHaveBeenNthCalledWith(1, 'tell me more');
        expect(sendPrompt).toHaveBeenNthCalledWith(2, 'a\tb\nc\bd\fe');
        expect(openLink).toHaveBeenCalledOnce();
        expect(openLink).toHaveBeenCalledWith('https://example.com/report');

        renderer.destroy();
    });

    it('user gets no prompt sent when the app has not wired a prompt handler', async () => {
        const host = mountHost();
        const renderer = createWidgetRenderer(host);

        renderReady(
            renderer,
            '<button id="prompt" type="button" data-send-prompt="go on">Go</button>'
        );

        await waitForCondition(() => host.querySelector('#prompt') !== null);

        const event = new MouseEvent('click', { bubbles: true, cancelable: true });

        // Without a host callback the action must stay inert rather than throw, and it must still
        // consume the click so the widget never navigates the app itself.
        expect(() => host.querySelector('#prompt')!.dispatchEvent(event)).not.toThrow();
        expect(event.defaultPrevented).toBe(true);

        renderer.destroy();
    });

    it('user gets an anchor with an unusable url ignored instead of opening a blank window', async () => {
        const open = vi.spyOn(window, 'open').mockImplementation(() => null);
        const host = mountHost();
        const renderer = createWidgetRenderer(host);

        renderReady(renderer, '<a id="broken" href="//[invalid">Broken link</a>');

        await waitForCondition(() => host.querySelector('#broken') !== null);

        host.querySelector('#broken')!.dispatchEvent(
            new MouseEvent('click', { bubbles: true, cancelable: true })
        );

        expect(open).not.toHaveBeenCalled();

        open.mockRestore();
        renderer.destroy();
    });
});

describe('user leaves a widget behind', () => {
    afterEach(() => {
        document.body.innerHTML = '';
        delete (window as Window & { sendPrompt?: unknown }).sendPrompt;
    });

    it('user sees the widget cleaned up when its message is removed', async () => {
        const host = mountHost();
        const renderer = createWidgetRenderer(host);

        renderReady(renderer, '<div id="content">chart</div>', { title: 'Revenue chart' });
        await waitForCondition(() => host.querySelector('#content') !== null);

        renderer.destroy();

        expect(host.childNodes).toHaveLength(0);
        expect(host.dataset.touchaiWidgetHost).toBeUndefined();
        expect(host.dataset.widgetPhase).toBeUndefined();
        expect(host.dataset.widgetId).toBeUndefined();
        expect(host.getAttribute('title')).toBeNull();
        expect(host.getAttribute('aria-label')).toBeNull();
    });

    it('user gets no prompt sent from a widget that was already removed', async () => {
        const sendPrompt = vi.fn();
        (window as Window & { sendPrompt?: (text: string) => void }).sendPrompt = sendPrompt;

        const host = mountHost();
        const renderer = createWidgetRenderer(host);

        renderReady(
            renderer,
            '<button id="prompt" type="button" data-send-prompt="go on">Go</button>'
        );
        await waitForCondition(() => host.querySelector('#prompt') !== null);

        renderer.destroy();

        const leftover = document.createElement('button');
        leftover.setAttribute('data-send-prompt', 'go on');
        host.appendChild(leftover);
        leftover.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

        expect(sendPrompt).not.toHaveBeenCalled();
    });

    it('user sees no late draft painted after the widget was removed', async () => {
        const host = mountHost();
        const renderer = createWidgetRenderer(host);

        renderDraft(renderer, '<div id="probe">first</div>');
        await waitForCondition(() => host.querySelector('#probe')?.textContent === 'first');

        renderDraft(renderer, '<div id="probe">second</div>');
        renderer.destroy();

        await new Promise((resolve) =>
            window.setTimeout(resolve, SHOW_WIDGET_DRAFT_MIN_INTERVAL_MS + 50)
        );

        expect(host.childNodes).toHaveLength(0);
        expect(document.body.querySelector('#probe')).toBeNull();
    });
});

describe('user gets the widget updated when the finished version replaces a draft', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('user sees the finished widget replace a queued draft instead of the draft arriving late', async () => {
        const host = mountHost();
        const renderer = createWidgetRenderer(host);

        renderDraft(renderer, '<p id="probe">draft</p>');
        await waitForCondition(() => host.querySelector('#probe')?.textContent === 'draft');

        // The next draft is inside the throttle window, so it is queued rather than drawn.
        renderDraft(renderer, '<p id="probe">stale draft</p>');
        renderReady(renderer, '<p id="probe">final</p>');

        await waitForCondition(() => host.querySelector('#probe')?.textContent === 'final');

        await new Promise((resolve) =>
            window.setTimeout(resolve, SHOW_WIDGET_DRAFT_MIN_INTERVAL_MS + 50)
        );

        // A queued draft must never overwrite the finished widget with older markup.
        expect(host.querySelector('#probe')?.textContent).toBe('final');

        renderer.destroy();
    });

    it('user sees reordered keyed widget nodes moved instead of rebuilt', async () => {
        const host = mountHost();
        const renderer = createWidgetRenderer(host);

        renderReady(
            renderer,
            [
                '<div data-widget-key="first">First row</div>',
                '<div data-widget-key="second">Second row</div>',
            ].join('')
        );

        await waitForCondition(() => host.querySelectorAll('[data-widget-key]').length === 2);

        const firstRow = host.querySelector('[data-widget-key="first"]');
        const secondRow = host.querySelector('[data-widget-key="second"]');

        renderReady(
            renderer,
            [
                '<div data-widget-key="second">Second row</div>',
                '<div data-widget-key="first">First row</div>',
            ].join('')
        );

        await waitForCondition(
            () =>
                widgetRoot(host).children[0]?.getAttribute('data-widget-key') === 'second' &&
                widgetRoot(host).children[1]?.getAttribute('data-widget-key') === 'first'
        );

        // Rebuilding rows would restart their CSS transitions and drop any listener the widget
        // script attached, so the same nodes have to be moved.
        expect(host.querySelector('[data-widget-key="first"]')).toBe(firstRow);
        expect(host.querySelector('[data-widget-key="second"]')).toBe(secondRow);

        renderer.destroy();
    });

    it('user does not see the fade-in marker on stylesheets the widget brings', async () => {
        const host = mountHost();
        const renderer = createWidgetRenderer(host);

        renderReady(renderer, '<style>.card{color:red}</style><div class="card">Card</div>');

        await waitForCondition(() => host.querySelector('.card') !== null);

        const widgetStyle = host.querySelector('style:not([data-touchai-widget-base-style])')!;
        const card = host.querySelector('.card')!;

        expect(card.getAttribute('data-touchai-widget-added')).toBe('true');
        expect(widgetStyle.getAttribute('data-touchai-widget-added')).toBeNull();

        renderer.destroy();
    });
});

describe('user gets a widget script that sees only its own widget', () => {
    afterEach(() => {
        document.body.innerHTML = '';
        delete (window as Window & { __probe?: unknown }).__probe;
    });

    it('user gets the document lookup methods limited to the widget content', async () => {
        const outside = document.createElement('div');
        outside.className = 'dup';
        outside.id = 'outside-node';
        document.body.appendChild(outside);

        const host = mountHost();
        const renderer = createWidgetRenderer(host);

        renderReady(
            renderer,
            [
                '<div class="dup">one</div>',
                '<div class="dup">two</div>',
                '<script>',
                'window.__probe = {',
                'byClass: document.getElementsByClassName("dup").length,',
                'byTag: document.getElementsByTagName("div").length,',
                'children: document.children.length,',
                'childNodes: document.childNodes.length,',
                'firstElement: document.firstElementChild.className,',
                'firstChild: document.firstChild.nodeName,',
                'outsideId: document.getElementById("outside-node"),',
                '};',
                '</script>',
            ].join('')
        );

        await waitForCondition(
            () => (window as Window & { __probe?: unknown }).__probe !== undefined
        );

        // A widget that counted the app's own nodes would render the wrong data, and one that
        // could reach outside its root could read the whole conversation.
        expect((window as Window & { __probe?: Record<string, unknown> }).__probe).toEqual({
            byClass: 2,
            byTag: 2,
            children: 2,
            childNodes: 2,
            firstElement: 'dup',
            firstChild: 'DIV',
            outsideId: null,
        });

        renderer.destroy();
    });

    it('user gets an id containing quotes still found by the widget script', async () => {
        const host = mountHost();
        const renderer = createWidgetRenderer(host);

        renderReady(
            renderer,
            [
                "<div id='row\"1'>Row one</div>",
                '<script>',
                'document.getElementById(\'row"1\').dataset.hit = "yes";',
                '</script>',
            ].join('')
        );

        await waitForCondition(() => host.querySelector('[data-hit="yes"]') !== null);

        expect(host.querySelector('[data-hit="yes"]')?.textContent).toBe('Row one');

        renderer.destroy();
    });

    it('user gets the widget active element reported only while focus is inside it', async () => {
        const outsideInput = document.createElement('input');
        outsideInput.id = 'app-input';
        document.body.appendChild(outsideInput);

        const host = mountHost();
        const renderer = createWidgetRenderer(host);

        renderReady(
            renderer,
            [
                '<input id="widget-input">',
                '<script>',
                'document.getElementById("widget-input").focus();',
                'window.__probe = document.activeElement && document.activeElement.id;',
                '</script>',
            ].join('')
        );

        await waitForCondition(
            () => (window as Window & { __probe?: unknown }).__probe !== undefined
        );

        expect((window as Window & { __probe?: unknown }).__probe).toBe('widget-input');

        outsideInput.focus();
        expect(host.querySelector<HTMLInputElement>('#widget-input')).not.toBeNull();

        renderer.destroy();
    });
});

describe('user reads a widget that follows the message typography', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('user sees the widget text follow the markdown body font of its message', () => {
        const message = document.createElement('div');
        message.className = 'ai-message';
        const markdown = document.createElement('div');
        markdown.className = 'touchai-markdown';
        markdown.style.fontFamily = 'Georgia, serif';
        markdown.style.fontWeight = '500';
        message.appendChild(markdown);
        document.body.appendChild(message);

        const host = document.createElement('div');
        message.appendChild(host);

        const renderer = createWidgetRenderer(host);

        expect(host.style.fontFamily).toBe('Georgia, serif');
        expect(host.style.fontWeight).toBe('500');
        expect(host.style.getPropertyValue('--touchai-widget-font-body')).toBe('Georgia, serif');

        renderer.destroy();
    });

    it('user sees the widget text follow the reasoning font when the message has no markdown body', () => {
        const message = document.createElement('div');
        message.className = 'ai-message';
        const reasoning = document.createElement('div');
        reasoning.className = 'reasoning-content';
        reasoning.style.fontFamily = 'Menlo, monospace';
        message.appendChild(reasoning);
        document.body.appendChild(message);

        const host = document.createElement('div');
        message.appendChild(host);

        const renderer = createWidgetRenderer(host);

        expect(host.style.fontFamily).toBe('Menlo, monospace');

        renderer.destroy();
    });

    it('user sees the widget keep the app theme colours when the token stylesheet is missing', () => {
        const host = mountHost();
        const renderer = createWidgetRenderer(host);

        // Widget CSS is written against the app's tokens; without the fallback the widget would
        // render with invisible or unstyled text if the stylesheet failed to load.
        expect(host.style.getPropertyValue('--color-text-primary')).toBe(
            SHOW_WIDGET_THEME_FALLBACKS['--color-text-primary']
        );
        expect(host.style.getPropertyValue('--color-background-primary')).toBe(
            SHOW_WIDGET_THEME_FALLBACKS['--color-background-primary']
        );
        expect(host.style.getPropertyValue('--border-radius-md')).toBe(
            SHOW_WIDGET_THEME_FALLBACKS['--border-radius-md']
        );
        expect(host.style.getPropertyValue('--font-mono')).not.toBe('');

        renderer.destroy();
    });
});

describe('user clicks a link inside a widget', () => {
    afterEach(() => {
        document.body.innerHTML = '';
        delete (window as Window & { openLink?: unknown }).openLink;
    });

    it('user gets a non-web link in a widget left alone', async () => {
        const openLink = vi.fn();
        (window as Window & { openLink?: (url: string) => void }).openLink = openLink;

        const host = mountHost();
        const renderer = createWidgetRenderer(host);

        renderReady(renderer, '<a id="mail" href="mailto:team@example.com">Mail us</a>');

        await waitForCondition(() => host.querySelector('#mail') !== null);

        const event = new MouseEvent('click', { bubbles: true, cancelable: true });
        host.querySelector('#mail')!.dispatchEvent(event);

        expect(openLink).not.toHaveBeenCalled();
        expect(event.defaultPrevented).toBe(false);

        renderer.destroy();
    });

    it('user gets a protocol-relative widget link opened as a web address', async () => {
        const openLink = vi.fn();
        (window as Window & { openLink?: (url: string) => void }).openLink = openLink;

        const host = mountHost();
        const renderer = createWidgetRenderer(host);

        renderReady(renderer, '<a id="proto" href="//example.com/report">Report</a>');

        await waitForCondition(() => host.querySelector('#proto') !== null);

        host.querySelector('#proto')!.dispatchEvent(
            new MouseEvent('click', { bubbles: true, cancelable: true })
        );

        expect(openLink).toHaveBeenCalledWith(`${window.location.protocol}//example.com/report`);

        renderer.destroy();
    });

    it('user gets an in-page anchor inside a widget left to scroll the widget itself', async () => {
        const openLink = vi.fn();
        (window as Window & { openLink?: (url: string) => void }).openLink = openLink;

        const host = mountHost();
        const renderer = createWidgetRenderer(host);

        renderReady(renderer, '<a id="anchor" href="#details">Details</a>');

        await waitForCondition(() => host.querySelector('#anchor') !== null);

        const event = new MouseEvent('click', { bubbles: true, cancelable: true });
        host.querySelector('#anchor')!.dispatchEvent(event);

        expect(openLink).not.toHaveBeenCalled();
        expect(event.defaultPrevented).toBe(false);

        renderer.destroy();
    });
});
