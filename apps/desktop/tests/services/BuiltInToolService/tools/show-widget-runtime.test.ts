// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { describe, expect, it } from 'vitest';

import {
    buildShowWidgetDraftFromArgumentsBuffer,
    createShowWidgetBaseStyles,
    isShowWidgetResourceUrlAllowed,
    SHOW_WIDGET_ALLOWED_RESOURCE_HOSTS,
} from '@/services/BuiltInToolService/tools/widgetTool/showWidget/runtime';

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

    it('user gets every allowlisted host accepted', () => {
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
    it('user gets the base styles scoped to the host element', () => {
        const css = createShowWidgetBaseStyles('#widget-host');

        expect(css).toContain('#widget-host');
        expect(css.length).toBeGreaterThan(0);
    });

    it('user gets the colour ramps scoped to the host as well', () => {
        const css = createShowWidgetBaseStyles('#widget-host');

        // A ramp class outside the host scope would leak into the rest of the app.
        expect(css).toContain('.c-purple');
        expect(css).toMatch(/#widget-host\s+\.c-/);
    });

    it('user gets a dark-mode variant so a widget matches the system theme', () => {
        const css = createShowWidgetBaseStyles('#widget-host');

        expect(css).toContain('prefers-color-scheme: dark');
    });
});
