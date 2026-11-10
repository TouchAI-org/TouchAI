import { describe, expect, it, vi } from 'vitest';

import type { BaseBuiltInToolExecutionContext } from '@/services/BuiltInToolService';
import { resolveToolFailure } from '@/services/BuiltInToolService/errors';
import { executeShowWidgetTool } from '@/services/BuiltInToolService/tools/widgetTool/showWidget';
import { readShowWidgetGuidelines } from '@/services/BuiltInToolService/tools/widgetTool/visualizeReadMe/guidelines';

function createContext(): BaseBuiltInToolExecutionContext {
    return {
        callId: 'call-1',
        iteration: 1,
        emitToolEvent: vi.fn(),
    };
}

describe('user asks for a widget and gets a visible one', () => {
    it('user sees optional title and description preserved in the widget event', async () => {
        const context = createContext();

        await expect(
            executeShowWidgetTool(
                {
                    is_read_widget_skill: true,
                    widget_code: '<section>content</section>',
                    title: 'Revenue',
                    description: 'Weekly revenue trend',
                },
                {},
                context
            )
        ).resolves.toMatchObject({ status: 'success' });
        expect(context.emitToolEvent).toHaveBeenCalledWith({
            type: 'widget_upsert',
            callId: 'call-1',
            widgetId: 'call-1',
            title: 'Revenue',
            description: 'Weekly revenue trend',
            html: '<section>content</section>',
            mode: 'render',
            phase: 'ready',
        });
    });

    it.each([
        ['title', 42],
        ['title', null],
        ['description', 42],
        ['description', null],
    ])(
        'user sees an invalid %s value rejected without emitting a widget event',
        async (field, value) => {
            const context = createContext();

            await expect(
                executeShowWidgetTool(
                    {
                        is_read_widget_skill: true,
                        widget_code: '<section>content</section>',
                        [field]: value,
                    },
                    {},
                    context
                )
            ).rejects.toThrow(`"${field}"`);
            expect(context.emitToolEvent).not.toHaveBeenCalled();
        }
    );

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
    ])(
        'user sees leading %s blocks rejected before the visible root element',
        async (_label, widgetCode) => {
            await expect(
                executeShowWidgetTool(
                    {
                        is_read_widget_skill: true,
                        widget_code: widgetCode,
                    },
                    {},
                    createContext()
                )
            ).rejects.toThrow('ShowWidget widget_code must start with a visible root element');
        }
    );

    it('user sees comments allowed when the first real element is visible', async () => {
        await expect(
            executeShowWidgetTool(
                {
                    is_read_widget_skill: true,
                    widget_code: '<!--<style>.ignored{}</style>--><section>content</section>',
                },
                {},
                createContext()
            )
        ).resolves.toMatchObject({ status: 'success' });
    });

    it('user gets actionable design validation text instead of a generic host failure', async () => {
        const error = await executeShowWidgetTool(
            {
                i_have_seen_read_me: true,
                widget_code: '<svg><linearGradient id="g"></linearGradient></svg>',
            },
            {},
            createContext()
        ).catch((caught: unknown) => caught);
        const failure = resolveToolFailure(error, {
            toolId: 'show_widget',
            fallbackMessage: 'Tool execution failed',
        });

        expect(failure.status).toBe('error');
        expect(failure.message).toContain('ShowWidget design validation failed');
        expect(failure.message).not.toBe('Tool execution failed');
    });

    it('user gets the valid guideline modules named when an unknown module is requested', () => {
        const error = (() => {
            try {
                return readShowWidgetGuidelines(['not-a-module']);
            } catch (caught) {
                return caught;
            }
        })();
        const failure = resolveToolFailure(error, {
            toolId: 'visualize_read_me',
            fallbackMessage: 'Tool execution failed',
        });

        expect(failure.message).toContain('Unknown show widget module: not-a-module');
        expect(failure.message).toContain('Valid modules:');
        expect(failure.message).not.toBe('Tool execution failed');
    });

    it.each([
        ['quoted', '<svg viewBox="0 0 100 60"><rect width="100" height="60" filter="none"/></svg>'],
        [
            'unquoted',
            '<svg viewBox="0 0 100 60"><rect width="100" height="60" filter=none /></svg>',
        ],
    ])('user sees %s SVG filter none attributes allowed', async (_label, widgetCode) => {
        await expect(
            executeShowWidgetTool(
                {
                    is_read_widget_skill: true,
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
    ])(
        'user sees %s rejected when it conflicts with the flat visual rules',
        async (_label, widgetCode) => {
            await expect(
                executeShowWidgetTool(
                    {
                        is_read_widget_skill: true,
                        widget_code: widgetCode,
                    },
                    {},
                    createContext()
                )
            ).rejects.toThrow('ShowWidget design validation failed');
        }
    );
});
