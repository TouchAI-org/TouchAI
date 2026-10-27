// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWidgetRenderer } from '@/services/BuiltInToolService/tools/widgetTool/showWidget/runtime';
import { log } from '@/services/ObservabilityService';

/**
 * Widget CSS and widget scripts come from a model, so both arrive in shapes a hand-written
 * stylesheet never would: escaped quotes inside attribute selectors, selectors already scoped,
 * dangling commas, top-level statements, and handlers with odd escape sequences. Each of those
 * has to end up either correctly scoped or safely dropped, never leaking onto the app page.
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

afterEach(() => {
    document.body.innerHTML = '';
    delete (window as Window & { sendPrompt?: unknown }).sendPrompt;
    delete (window as Window & { openLink?: unknown }).openLink;
});

describe('user sees a draft whose style block is already complete', () => {
    it('user sees the finished style block applied while the widget is still a draft', async () => {
        const host = mountHost();
        const renderer = createWidgetRenderer(host);

        renderDraft(renderer, '<style>.card{color:red}</style><div class="card">Card</div>');

        await waitForCondition(() => host.querySelector('.card') !== null);

        // The block is closed, so there is no half-written CSS to hide: the user gets it now.
        const styles = renderedStyles(host);
        expect(styles).toHaveLength(1);
        expect(styles[0]).toContain('.card{color:red}');
        expect(styles[0]).toContain('[data-touchai-widget-host=');

        renderer.destroy();
    });

    it('user gets a style-only draft applied without any visible content', async () => {
        const host = mountHost();
        const renderer = createWidgetRenderer(host);
        const root = host.querySelector<HTMLElement>('[data-touchai-widget-root="true"]')!;

        renderDraft(renderer, '<style>.skeleton{color:red}</style>');

        await new Promise((resolve) => window.setTimeout(resolve, 50));

        // The sheet is scoped and carried, but there is nothing for the user to look at yet.
        const visible = Array.from(root.querySelectorAll('*')).filter(
            (element) => element.tagName !== 'STYLE'
        );
        expect(visible).toEqual([]);

        renderer.destroy();
    });
});

describe('user gets widget CSS with awkward selectors scoped correctly', () => {
    it('user gets an attribute selector with an escaped quote kept intact and scoped', async () => {
        const host = mountHost();
        const renderer = createWidgetRenderer(host);
        const hostSelector = `[data-touchai-widget-host="${host.dataset.touchaiWidgetHost}"]`;

        renderReady(
            renderer,
            [
                '<style>[data-note="a\\"b"]{color:red}</style>',
                '<div data-note="a&quot;b">Note</div>',
            ].join('')
        );

        await waitForCondition(() => host.querySelector('[data-note]') !== null);

        const [styleText] = renderedStyles(host);
        expect(styleText).toContain(`${hostSelector} [data-note="a\\"b"]{color:red}`);

        renderer.destroy();
    });

    it('user gets an empty selector in a selector list skipped rather than left dangling', async () => {
        const host = mountHost();
        const renderer = createWidgetRenderer(host);
        const hostSelector = `[data-touchai-widget-host="${host.dataset.touchaiWidgetHost}"]`;

        renderReady(renderer, '<style>.a, , .b{color:red}</style><div class="a">A</div>');

        await waitForCondition(() => host.querySelector('.a') !== null);

        const [styleText] = renderedStyles(host);
        expect(styleText).toContain(`${hostSelector} .a, ${hostSelector} .b{color:red}`);
        expect(styleText).not.toContain(', ,');

        renderer.destroy();
    });

    it('user gets a rule that is already scoped left as written instead of double-scoped', async () => {
        const host = mountHost();
        const renderer = createWidgetRenderer(host);
        const hostSelector = `[data-touchai-widget-host="${host.dataset.touchaiWidgetHost}"]`;

        renderReady(
            renderer,
            `<style>${hostSelector} .card{color:red}</style><div class="card">Card</div>`
        );

        await waitForCondition(() => host.querySelector('.card') !== null);

        const [styleText] = renderedStyles(host);
        expect(styleText).toContain(`${hostSelector} .card{color:red}`);
        // A second scope prefix would make the selector match nothing.
        expect(styleText).not.toContain(`${hostSelector} ${hostSelector}`);

        renderer.destroy();
    });

    it('user gets a stylesheet whose last rule has no closing brace still applied', async () => {
        const host = mountHost();
        const renderer = createWidgetRenderer(host);

        renderReady(renderer, '<style>.a{color:red}\n.b{color:blue}</style><div class="a">A</div>');

        await waitForCondition(() => host.querySelector('.a') !== null);

        // A truncated stylesheet must not lose the rules that were complete.
        const [styleText] = renderedStyles(host);
        expect(styleText).toContain('.a{color:red}');

        renderer.destroy();
    });

    it('user gets a stray top-level at-statement dropped instead of leaking onto the page', async () => {
        const host = mountHost();
        const renderer = createWidgetRenderer(host);

        renderReady(
            renderer,
            '<style>@charset "utf-8";.card{color:blue}</style><div class="card">Card</div>'
        );

        await waitForCondition(() => host.querySelector('.card') !== null);

        const [styleText] = renderedStyles(host);
        expect(styleText).not.toContain('@charset');
        expect(styleText).toContain('.card{color:blue}');

        renderer.destroy();
    });

    it('user gets a trailing import dropped even when it is the last thing in the sheet', async () => {
        const host = mountHost();
        const renderer = createWidgetRenderer(host);

        renderReady(
            renderer,
            '<style>.a{color:red}\n@import url("https://evil.example/x.css");</style>'
        );

        await waitForCondition(
            () => host.querySelector('style:not([data-touchai-widget-base-style])') !== null
        );

        const [styleText] = renderedStyles(host);
        expect(styleText).not.toContain('@import');
        expect(styleText).not.toContain('evil.example');

        renderer.destroy();
    });

    it('user gets a style element with no rules left as an empty scoped sheet', async () => {
        const host = mountHost();
        const renderer = createWidgetRenderer(host);

        renderReady(renderer, '<style></style><div>content</div>');

        await waitForCondition(() => host.textContent?.includes('content') === true);

        expect(renderedStyles(host)).toEqual(['']);

        renderer.destroy();
    });
});

describe('user gets widget script escapes decoded in an action', () => {
    it('user sees a tab and a backslash decoded in a legacy handler', async () => {
        const sendPrompt = vi.fn();
        (window as Window & { sendPrompt?: (text: string) => void }).sendPrompt = sendPrompt;

        const host = mountHost();
        const renderer = createWidgetRenderer(host);

        renderReady(
            renderer,
            [
                `<button id="tab" type="button" onclick="sendPrompt('a\\tb')">Tab</button>`,
                `<button id="bs" type="button" onclick="sendPrompt('a\\\\b')">Backslash</button>`,
            ].join('')
        );

        await waitForCondition(() => host.querySelector('#tab') !== null);

        expect(host.querySelector('#tab')?.getAttribute('data-send-prompt')).toBe('a\tb');
        expect(host.querySelector('#bs')?.getAttribute('data-send-prompt')).toBe('a\\b');

        host.querySelector('#tab')!.dispatchEvent(
            new MouseEvent('click', { bubbles: true, cancelable: true })
        );
        host.querySelector('#bs')!.dispatchEvent(
            new MouseEvent('click', { bubbles: true, cancelable: true })
        );

        expect(sendPrompt).toHaveBeenNthCalledWith(1, 'a\tb');
        expect(sendPrompt).toHaveBeenNthCalledWith(2, 'a\\b');

        renderer.destroy();
    });

    it('user gets a handler ending in a lone backslash dropped instead of sending junk', async () => {
        const sendPrompt = vi.fn();
        (window as Window & { sendPrompt?: (text: string) => void }).sendPrompt = sendPrompt;

        const host = mountHost();
        const renderer = createWidgetRenderer(host);

        renderReady(
            renderer,
            [
                '<button id="trailing" type="button" onclick="sendPrompt(\'a\\\\\')">Trailing</button>',
                '<button id="ok" type="button" data-send-prompt="fine">OK</button>',
            ].join('')
        );

        await waitForCondition(() => host.querySelector('#ok') !== null);

        expect(host.querySelector('#ok')?.getAttribute('data-send-prompt')).toBe('fine');

        renderer.destroy();
    });

    it('user gets an empty handler and a blank action dropped without breaking the widget', async () => {
        const sendPrompt = vi.fn();
        (window as Window & { sendPrompt?: (text: string) => void }).sendPrompt = sendPrompt;

        const host = mountHost();
        const renderer = createWidgetRenderer(host);

        renderReady(
            renderer,
            [
                '<button id="empty" type="button" onclick="">Empty</button>',
                `<button id="blank" type="button" onclick="sendPrompt('   ')">Blank</button>`,
                '<div id="content">still here</div>',
            ].join('')
        );

        await waitForCondition(() => host.querySelector('#content') !== null);

        expect(host.querySelector('#empty')?.getAttribute('onclick')).toBeNull();
        expect(host.querySelector('#empty')?.getAttribute('data-send-prompt')).toBeNull();
        expect(host.querySelector('#blank')?.getAttribute('data-send-prompt')).toBeNull();
        expect(host.querySelector('#content')?.textContent).toBe('still here');

        renderer.destroy();
    });
});

describe('user clicks a widget action with an address the app will not open', () => {
    it('user gets no window opened for a blank action address', async () => {
        const open = vi.spyOn(window, 'open').mockImplementation(() => null);
        const host = mountHost();
        const renderer = createWidgetRenderer(host);

        renderReady(
            renderer,
            '<button id="blank" type="button" data-open-link="   ">Blank</button>'
        );

        await waitForCondition(() => host.querySelector('#blank') !== null);

        host.querySelector('#blank')!.dispatchEvent(
            new MouseEvent('click', { bubbles: true, cancelable: true })
        );

        expect(open).not.toHaveBeenCalled();

        open.mockRestore();
        renderer.destroy();
    });

    it('user gets no window opened for a relative action address', async () => {
        const open = vi.spyOn(window, 'open').mockImplementation(() => null);
        const host = mountHost();
        const renderer = createWidgetRenderer(host);

        renderReady(
            renderer,
            '<button id="relative" type="button" data-open-link="/settings">Settings</button>'
        );

        await waitForCondition(() => host.querySelector('#relative') !== null);

        host.querySelector('#relative')!.dispatchEvent(
            new MouseEvent('click', { bubbles: true, cancelable: true })
        );

        expect(open).not.toHaveBeenCalled();

        open.mockRestore();
        renderer.destroy();
    });

    it('user gets a mail address in a widget left to the system handler', async () => {
        const open = vi.spyOn(window, 'open').mockImplementation(() => null);
        const host = mountHost();
        const renderer = createWidgetRenderer(host);

        renderReady(renderer, '<a id="mail" href="mailto:team@example.com">Mail</a>');

        await waitForCondition(() => host.querySelector('#mail') !== null);

        host.querySelector('#mail')!.dispatchEvent(
            new MouseEvent('click', { bubbles: true, cancelable: true })
        );

        expect(open).not.toHaveBeenCalled();

        open.mockRestore();
        renderer.destroy();
    });
});

describe('user gets widget media constrained to the message column', () => {
    it('user sees an svg capped at the column width', async () => {
        const host = mountHost();
        const renderer = createWidgetRenderer(host);

        renderReady(
            renderer,
            '<svg viewBox="0 0 100 50"><rect width="100" height="50"></rect></svg>'
        );

        await waitForCondition(() => host.querySelector('svg') !== null);

        // An svg with a viewBox but no inline width would otherwise grow past the column.
        const svg = host.querySelector<HTMLElement>('svg')!;
        expect(svg.style.maxWidth).toBe('100%');

        renderer.destroy();
    });

    it('user sees a widget image capped at the column width', async () => {
        const host = mountHost();
        const renderer = createWidgetRenderer(host);

        renderReady(renderer, '<img src="https://example.com/chart.png" alt="Chart">');

        await waitForCondition(() => host.querySelector('img') !== null);

        expect(host.querySelector<HTMLElement>('img')!.style.maxWidth).toBe('100%');

        renderer.destroy();
    });
});

describe('user gets widget script attributes carried across', () => {
    it('user sees an inline script attribute kept on the executed script', async () => {
        const host = mountHost();
        const renderer = createWidgetRenderer(host);

        renderReady(
            renderer,
            [
                '<div id="result">pending</div>',
                '<script data-widget-script="probe">document.getElementById("result").textContent = "ran";</script>',
            ].join('')
        );

        await waitForCondition(() => host.querySelector('#result')?.textContent === 'ran');

        expect(host.querySelector('#result')?.textContent).toBe('ran');

        renderer.destroy();
    });

    it('user gets an inline script with no text content ignored without an error', async () => {
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

describe('user gets a widget script that reaches for the page outside it', () => {
    it('user gets no active element reported while focus is outside the widget', async () => {
        const outsideInput = document.createElement('input');
        outsideInput.id = 'app-input';
        document.body.appendChild(outsideInput);
        outsideInput.focus();

        const host = mountHost();
        const renderer = createWidgetRenderer(host);

        renderReady(
            renderer,
            [
                '<div id="inside">content</div>',
                '<script>',
                'window.__probe = document.activeElement === null ? "none" : "something";',
                '</script>',
            ].join('')
        );

        await waitForCondition(
            () => (window as Window & { __probe?: unknown }).__probe !== undefined
        );

        expect((window as Window & { __probe?: unknown }).__probe).toBe('none');

        delete (window as Window & { __probe?: unknown }).__probe;
        renderer.destroy();
    });
});
