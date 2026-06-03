import { describe, expect, it, vi } from 'vitest';

import type { BaseBuiltInToolExecutionContext } from '@/services/BuiltInToolService';
import { executeShowWidgetTool } from '@/services/BuiltInToolService/tools/widgetTool/showWidget';

function createContext(): BaseBuiltInToolExecutionContext {
    return {
        callId: 'call-1',
        iteration: 1,
        emitToolEvent: vi.fn(),
        hasExecutedBuiltInTool: (toolId) => toolId === 'visualize_read_me',
    };
}

describe('ShowWidget design validation', () => {
    it.each([
        ['style', '<style>.root{display:grid}</style><section class="root">content</section>'],
        ['script', '<script>window.__probe = true</script><section>content</section>'],
        [
            'link',
            '<link rel="stylesheet" href="https://example.com/widget.css"><section>content</section>',
        ],
        ['meta', '<meta name="viewport" content="width=device-width"><section>content</section>'],
        ['title', '<title>Widget</title><section>content</section>'],
        [
            'comment-prefixed style',
            '<!-- preface --><style>.root{display:grid}</style><section class="root">content</section>',
        ],
        [
            'comment-prefixed script',
            '<!-- preface --><script>window.__probe = true</script><section>content</section>',
        ],
    ])('rejects leading %s blocks before the visible root element', async (_label, widgetCode) => {
        await expect(
            executeShowWidgetTool(
                {
                    i_have_seen_read_me: true,
                    widget_code: widgetCode,
                },
                {},
                createContext()
            )
        ).rejects.toThrow('ShowWidget widget_code must start with a visible root element');
    });

    it('allows comments when the first real element is visible', async () => {
        await expect(
            executeShowWidgetTool(
                {
                    i_have_seen_read_me: true,
                    widget_code: '<!--<style>.ignored{}</style>--><section>content</section>',
                },
                {},
                createContext()
            )
        ).resolves.toMatchObject({ status: 'success' });
    });

    it.each([
        ['quoted', '<svg viewBox="0 0 100 60"><rect width="100" height="60" filter="none"/></svg>'],
        [
            'unquoted',
            '<svg viewBox="0 0 100 60"><rect width="100" height="60" filter=none /></svg>',
        ],
    ])('allows %s SVG filter none attributes', async (_label, widgetCode) => {
        await expect(
            executeShowWidgetTool(
                {
                    i_have_seen_read_me: true,
                    widget_code: widgetCode,
                },
                {},
                createContext()
            )
        ).resolves.toMatchObject({ status: 'success' });
    });

    it.each([
        [
            'SVG gradients',
            '<svg viewBox="0 0 100 60"><defs><linearGradient id="g"><stop offset="0%" stop-color="#fff"/></linearGradient></defs><rect width="100" height="60" fill="url(#g)"/></svg>',
        ],
        [
            'SVG filters',
            '<svg viewBox="0 0 100 60"><defs><filter id="blur"><feGaussianBlur stdDeviation="4"/></filter></defs><rect width="100" height="60" filter="url(#blur)"/></svg>',
        ],
        [
            'unquoted SVG filter attributes',
            '<svg viewBox="0 0 100 60"><rect width="100" height="60" filter=url(#blur)/></svg>',
        ],
        [
            'SVG patterns',
            '<svg viewBox="0 0 100 60"><defs><pattern id="p" width="4" height="4" patternUnits="userSpaceOnUse"><circle r="1"/></pattern></defs><rect width="100" height="60" fill="url(#p)"/></svg>',
        ],
    ])('rejects %s that conflict with flat visual rules', async (_label, widgetCode) => {
        await expect(
            executeShowWidgetTool(
                {
                    i_have_seen_read_me: true,
                    widget_code: widgetCode,
                },
                {},
                createContext()
            )
        ).rejects.toThrow('ShowWidget design validation failed');
    });
});
