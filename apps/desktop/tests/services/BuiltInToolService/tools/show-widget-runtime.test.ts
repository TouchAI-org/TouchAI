// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { describe, expect, it } from 'vitest';

import {
    buildShowWidgetDraftFromArgumentsBuffer,
    createShowWidgetBaseStyles,
    isShowWidgetResourceUrlAllowed,
    SHOW_WIDGET_ALLOWED_RESOURCE_HOSTS,
} from '@/services/BuiltInToolService/tools/widgetTool/showWidget/runtime';

/**
 * Removes every @keyframes block by matching braces. A regex that stops at the first closing
 * brace would swallow the CSS after the keyframes and silently stop checking it.
 */
function stripKeyframes(css: string): string {
    let result = '';
    let index = 0;

    while (index < css.length) {
        const at = css.indexOf('@keyframes', index);
        if (at < 0) {
            result += css.slice(index);
            break;
        }

        result += css.slice(index, at);

        let depth = 0;
        let cursor = css.indexOf('{', at);
        if (cursor < 0) break;

        for (; cursor < css.length; cursor += 1) {
            if (css[cursor] === '{') depth += 1;
            if (css[cursor] === '}') {
                depth -= 1;
                if (depth === 0) {
                    cursor += 1;
                    break;
                }
            }
        }

        index = cursor;
    }

    return result;
}

/** Every selector in the sheet, split so a group like `body, .card` becomes two entries. */
function extractOrdinarySelectors(css: string): string[] {
    const withoutKeyframes = stripKeyframes(css);
    const selectors: string[] = [];

    for (const match of withoutKeyframes.matchAll(/([^{}]+)\{/g)) {
        const prelude = match[1]!.trim();
        // At-rule preludes (@media, @supports) are not selectors; their inner rules are
        // matched by the same loop.
        if (!prelude || prelude.startsWith('@')) continue;

        for (const part of prelude.split(',')) {
            const selector = part.trim();
            if (selector.length > 0) selectors.push(selector);
        }
    }

    return selectors;
}

/**
 * The widget tool streams its arguments, so a draft has to be built from JSON that is still
 * being written. Rendering a wrong draft means the user sees a broken widget appear and then
 * jump; rendering nothing means the tool looks dead while it works.
 */
describe('user watches a widget draft appear while the tool is still writing', () => {
    it('user gets a draft from a buffer whose html is only partly written', () => {
        const draft = buildShowWidgetDraftFromArgumentsBuffer(
            'call-1',
            '{"widgetId":"chart","widget_code":"<div class=\\"c-purple\\">'
        );

        expect(draft).not.toBeNull();
        expect(draft?.widgetId).toBe('chart');
        expect(draft?.html).toContain('c-purple');
        expect(draft?.phase).toBe('draft');
        expect(draft?.mode).toBe('render');
    });

    it('user gets the html field accepted as an alias for the widget code', () => {
        const draft = buildShowWidgetDraftFromArgumentsBuffer('call-1', '{"html":"<p>hi</p>"}');

        expect(draft?.html).toBe('<p>hi</p>');
    });

    it('user gets the escaped characters decoded in a partly written string', () => {
        const draft = buildShowWidgetDraftFromArgumentsBuffer(
            'call-1',
            '{"title":"line one\\nline two\\ttabbed","html":"<p>x</p>"}'
        );

        expect(draft?.title).toBe('line one\nline two\ttabbed');
    });

    it('user gets a unicode escape decoded in a partly written string', () => {
        const draft = buildShowWidgetDraftFromArgumentsBuffer(
            'call-1',
            '{"title":"\\u4e2d\\u6587","html":"<p>x</p>"}'
        );

        expect(draft?.title).toBe('中文');
    });

    it('user gets the call id used as the widget id when none was written yet', () => {
        const draft = buildShowWidgetDraftFromArgumentsBuffer('call-42', '{"html":"<p>x</p>"}');

        expect(draft?.widgetId).toBe('call-42');
        expect(draft?.callId).toBe('call-42');
    });

    it('user gets no draft while the buffer still says nothing useful', () => {
        // A draft with no id, title or html would flash an empty widget.
        expect(buildShowWidgetDraftFromArgumentsBuffer('call-1', '')).toBeNull();
        expect(buildShowWidgetDraftFromArgumentsBuffer('call-1', '{"mode":')).toBeNull();
        expect(buildShowWidgetDraftFromArgumentsBuffer('call-1', '{"unknown":"x"}')).toBeNull();
    });

    it('user gets the remove mode honoured while it is being written', () => {
        const draft = buildShowWidgetDraftFromArgumentsBuffer(
            'call-1',
            '{"mode":"remove","widgetId":"chart"}'
        );

        expect(draft?.mode).toBe('remove');
    });

    it('user does not get an unknown mode taken from the buffer', () => {
        const draft = buildShowWidgetDraftFromArgumentsBuffer(
            'call-1',
            '{"mode":"delete-everything","widgetId":"chart"}'
        );

        // An unrecognised mode falls back to rendering rather than removing something.
        expect(draft?.mode).toBe('render');
    });

    it('user gets a still-open value kept as what has been written so far', () => {
        // The closing quote has not arrived yet; the partial reader keeps what it has.
        const draft = buildShowWidgetDraftFromArgumentsBuffer(
            'call-1',
            '{"html":"<div>still writing'
        );

        expect(draft?.html).toBe('<div>still writing');
    });

    it('user gets a carriage-return escape turned into a real line break', () => {
        const draft = buildShowWidgetDraftFromArgumentsBuffer(
            'call-1',
            '{"title":"first\\rsecond","html":"<p>x</p>"}'
        );

        expect(draft?.title).toBe('first\rsecond');
    });

    it('user gets a malformed unicode escape kept as written instead of a broken character', () => {
        // A provider can stream `\u` before the four hex digits arrive; the draft must not
        // swallow the characters that follow it.
        const draft = buildShowWidgetDraftFromArgumentsBuffer(
            'call-1',
            '{"title":"\\uZZZZ tail","html":"<p>x</p>"}'
        );

        expect(draft?.title).toBe('\\uZZZZ tail');
    });

    it('user gets no draft from a field name that was written before its value', () => {
        // The key arrived but the colon and value are still in flight.
        expect(buildShowWidgetDraftFromArgumentsBuffer('call-1', '{"widgetId"')).toBeNull();
    });

    it('user gets a non-string mode ignored while the value is still being written', () => {
        const draft = buildShowWidgetDraftFromArgumentsBuffer(
            'call-1',
            '{"mode":123,"widgetId":"chart"}'
        );

        // An unreadable mode must not remove a widget that is being rendered.
        expect(draft?.mode).toBe('render');
    });
});

/**
 * A widget may load scripts and styles from the network. The allowlist is the only thing
 * between a model-authored page and an arbitrary origin.
 */
describe('user gets widget resources limited to the allowlist', () => {
    it('user gets an empty resource accepted because nothing is loaded', () => {
        expect(isShowWidgetResourceUrlAllowed('')).toBe(true);
        expect(isShowWidgetResourceUrlAllowed('   ')).toBe(true);
    });

    it('user gets a relative path resolved against the app origin and refused', () => {
        // A relative URL resolves to the app's own http origin, which is not on the CDN
        // allowlist, so a widget cannot pull from the app's own address space either.
        expect(isShowWidgetResourceUrlAllowed('#section')).toBe(false);
        expect(isShowWidgetResourceUrlAllowed('/local/style.css')).toBe(false);
    });

    it('user gets an absolute url on an allowlisted host accepted', () => {
        // The check is on the resolved host, so an absolute URL naming an allowlisted host
        // passes regardless of what the document base happens to be.
        expect(isShowWidgetResourceUrlAllowed('https://cdn.jsdelivr.net/npm/chart.js')).toBe(true);
    });

    it('user gets every allowlisted host accepted', () => {
        // Without this the loop would pass on an empty list and prove nothing.
        expect(SHOW_WIDGET_ALLOWED_RESOURCE_HOSTS.length).toBeGreaterThan(0);

        for (const host of SHOW_WIDGET_ALLOWED_RESOURCE_HOSTS) {
            expect(isShowWidgetResourceUrlAllowed(`https://${host}/lib.js`)).toBe(true);
        }
    });

    it('user gets an unlisted host refused', () => {
        expect(isShowWidgetResourceUrlAllowed('https://evil.example/lib.js')).toBe(false);
        expect(isShowWidgetResourceUrlAllowed('https://cdnjs.cloudflare.com.attacker.test/x')).toBe(
            false
        );
    });

    it('user gets a non-http scheme treated as local', () => {
        // Only network protocols are gated; a data: or blob: URL never leaves the machine.
        expect(isShowWidgetResourceUrlAllowed('data:text/plain,hi')).toBe(true);
        expect(isShowWidgetResourceUrlAllowed('blob:https://example.com/uuid')).toBe(true);
    });

    it('user gets a malformed url refused rather than allowed', () => {
        expect(isShowWidgetResourceUrlAllowed('http://[invalid')).toBe(false);
    });
});

/**
 * Widget styles are generated from the app's own tokens so a widget cannot look foreign.
 */
describe('user gets widget styles that follow the app theme', () => {
    it('user gets every ordinary base selector scoped to the host element', () => {
        const css = createShowWidgetBaseStyles('#widget-host');

        // A rule such as `body { display: none }` would leak into the whole app, so every
        // ordinary selector is checked, not just the presence of one scoped rule.
        const selectors = extractOrdinarySelectors(css);

        expect(selectors.length).toBeGreaterThan(0);
        for (const selector of selectors) {
            expect(selector, `unscoped selector: ${selector}`).toContain('#widget-host');
        }
    });

    it('user gets every colour ramp selector scoped to the host', () => {
        const css = createShowWidgetBaseStyles('#widget-host');

        // A ramp class outside the host scope would leak into the rest of the app, so every
        // occurrence has to be scoped, not just the first one.
        const rampSelectors = css.match(/\.c-[a-z]+/g) ?? [];
        expect(rampSelectors.length).toBeGreaterThan(0);

        // Read the selectors, not the source lines: formatting may split a selector.
        const selectors = css.match(/[^{}]*\.c-[a-z]+[^{}]*\{/g) ?? [];
        expect(selectors.length).toBeGreaterThan(0);
        for (const selector of selectors) {
            expect(selector).toContain('#widget-host');
        }
    });

    it('user gets a dark-mode variant so a widget matches the system theme', () => {
        const css = createShowWidgetBaseStyles('#widget-host');

        expect(css).toContain('prefers-color-scheme: dark');
    });
});
