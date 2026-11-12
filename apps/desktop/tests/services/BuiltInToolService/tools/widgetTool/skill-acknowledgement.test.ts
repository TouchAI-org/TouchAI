import { describe, expect, it } from 'vitest';

import { builtInTools } from '@/services/BuiltInToolService/tools/widgetTool';
import { showWidgetTool } from '@/services/BuiltInToolService/tools/widgetTool/showWidget';
import type { BaseBuiltInToolExecutionContext } from '@/services/BuiltInToolService/types';

function createRequest() {
    const events: unknown[] = [];
    const context = {
        callId: 'widget-call',
        iteration: 1,
        emitToolEvent: (event: unknown) => events.push(event),
    } satisfies BaseBuiltInToolExecutionContext;
    return { context, events };
}

const mutations = [
    {
        label: 'creating a widget',
        args: { widget_code: '<section>First version</section>' },
        expected: { type: 'widget_upsert', widgetId: 'widget-call' },
    },
    {
        label: 'updating a widget',
        args: { widgetId: 'existing-widget', widget_code: '<section>New version</section>' },
        expected: { type: 'widget_upsert', widgetId: 'existing-widget' },
    },
    {
        label: 'removing a widget',
        args: { mode: 'remove', widgetId: 'existing-widget' },
        expected: { type: 'widget_remove', widgetId: 'existing-widget' },
    },
];

describe('given a widget mutation requires the model to acknowledge the loaded guide', () => {
    describe.each(mutations)('given the model is $label', ({ args, expected }) => {
        it.each([
            ['missing acknowledgement', {}],
            ['false acknowledgement', { is_read_widget_skill: false }],
            ['string acknowledgement', { is_read_widget_skill: 'true' }],
            ['number acknowledgement', { is_read_widget_skill: 1 }],
            ['object acknowledgement', { is_read_widget_skill: { value: true } }],
            ['legacy acknowledgement', { i_have_seen_read_me: true }],
            ['legacy credential', { skill_key: 'legacy' }],
        ])(
            'user sees no widget change when the model supplies a %s',
            async (_label, acknowledgement) => {
                const { context, events } = createRequest();

                await expect(
                    showWidgetTool.execute({ ...args, ...acknowledgement }, {}, context)
                ).rejects.toThrow(/is_read_widget_skill/);
                expect(events).toEqual([]);
            }
        );

        it('user sees the requested widget change when the model acknowledges the loaded guide', async () => {
            const { context, events } = createRequest();

            const result = await showWidgetTool.execute(
                { ...args, is_read_widget_skill: true },
                {},
                context
            );

            expect(result).toMatchObject({ status: 'success', isError: false });
            expect(events).toEqual([expect.objectContaining(expected)]);
        });
    });

    it('user receives deterministic diagnostics when acknowledged markup violates design rules', async () => {
        const { context, events } = createRequest();

        const error = await showWidgetTool
            .execute(
                {
                    is_read_widget_skill: true,
                    widget_code: '<section style="box-shadow:0 0 2px">Content</section>',
                },
                {},
                context
            )
            .catch((failure: unknown) => failure);

        expect(error).toBeInstanceOf(Error);
        expect(String(error)).toContain('ShowWidget design validation failed');
        expect(events).toEqual([]);
    });

    it('user sees no widget change when an acknowledgement also carries a legacy credential', async () => {
        const { context, events } = createRequest();

        await expect(
            showWidgetTool.execute(
                {
                    is_read_widget_skill: true,
                    skill_key: 'legacy',
                    widget_code: '<section>content</section>',
                },
                {},
                context
            )
        ).rejects.toThrow(/skill_key/);
        expect(events).toEqual([]);
    });

    it('user discovers only the rendering tool when reading the widget tool group', () => {
        expect(builtInTools.map((tool) => tool.id)).toEqual(['show_widget']);
    });

    it('user sees a required boolean acknowledgement when reading the widget input contract', () => {
        expect(showWidgetTool.inputSchema.required).toContain('is_read_widget_skill');
        expect(showWidgetTool.inputSchema.properties).toMatchObject({
            is_read_widget_skill: { type: 'boolean', const: true },
            title: { type: 'string' },
            description: { type: 'string' },
        });
        expect(showWidgetTool.inputSchema.properties).not.toHaveProperty('skill_key');
    });
});
