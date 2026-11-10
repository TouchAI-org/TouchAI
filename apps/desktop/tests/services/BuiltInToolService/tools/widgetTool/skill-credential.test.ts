import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ToolEvent } from '@/services/AgentService/contracts/tooling';
import { WidgetSkillAccess } from '@/services/AgentService/skills/widgetAccess';
import { builtInTools } from '@/services/BuiltInToolService/tools/widgetTool';
import { showWidgetTool } from '@/services/BuiltInToolService/tools/widgetTool/showWidget';
import type { BaseBuiltInToolExecutionContext } from '@/services/BuiltInToolService/types';

function createRequest() {
    const widgetSkillAccess = new WidgetSkillAccess();
    const events: ToolEvent[] = [];
    const context = {
        callId: 'widget-call',
        iteration: 1,
        widgetSkillAccess,
        emitToolEvent: (event: ToolEvent) => events.push(event),
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

describe('given a widget mutation requires the current request skill credential', () => {
    beforeEach(() => {
        let sequence = 0;
        vi.spyOn(crypto, 'randomUUID').mockImplementation(
            () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`
        );
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe.each(mutations)('given the model is $label', ({ args, expected }) => {
        it.each([
            ['missing key', {}],
            ['wrong key', { skill_key: 'wrong-private-credential' }],
            ['old boolean', { i_have_seen_read_me: true }],
            ['old camel-case boolean', { iHaveSeenReadMe: true }],
            ['boolean key', { skill_key: true }],
            ['object key', { skill_key: { value: 'private-nested-credential' } }],
            ['empty key', { skill_key: '' }],
        ])(
            'user sees no widget change when the model supplies a %s',
            async (_label, credential) => {
                const { context, events } = createRequest();
                context.widgetSkillAccess.activate('{{WIDGET_SKILL_KEY}}');

                await expect(
                    showWidgetTool.execute({ ...args, ...credential }, {}, context)
                ).rejects.toThrow(/skill_key/);
                expect(events).toEqual([]);
            }
        );

        it('user sees the requested widget change when the model supplies the activated key', async () => {
            const { context, events } = createRequest();
            const key = context.widgetSkillAccess.activate('{{WIDGET_SKILL_KEY}}');

            const result = await showWidgetTool.execute({ ...args, skill_key: key }, {}, context);

            expect(result).toMatchObject({ status: 'success', isError: false });
            expect(events).toEqual([expect.objectContaining(expected)]);
            expect(JSON.stringify({ events, result })).not.toContain(key);
        });

        it('user sees no widget change when the request has no credential access', async () => {
            const { context, events } = createRequest();
            const key = context.widgetSkillAccess.activate('{{WIDGET_SKILL_KEY}}');

            await expect(
                showWidgetTool.execute(
                    { ...args, skill_key: key, i_have_seen_read_me: true },
                    {},
                    { ...context, widgetSkillAccess: undefined }
                )
            ).rejects.toThrow(/skill_key/);
            expect(events).toEqual([]);
        });

        it('user sees no widget change when the request has not activated the skill', async () => {
            const { context, events } = createRequest();

            await expect(
                showWidgetTool.execute(
                    {
                        ...args,
                        skill_key: 'unissued-private-credential',
                        i_have_seen_read_me: true,
                    },
                    {},
                    context
                )
            ).rejects.toThrow(/skill_key/);
            expect(events).toEqual([]);
        });

        it('user sees no widget change when a previous request key is reused', async () => {
            const { context, events } = createRequest();
            const previousKey = context.widgetSkillAccess.activate('{{WIDGET_SKILL_KEY}}');
            context.widgetSkillAccess.clear();
            const currentKey = context.widgetSkillAccess.activate('{{WIDGET_SKILL_KEY}}');

            await expect(
                showWidgetTool.execute(
                    { ...args, skill_key: previousKey, i_have_seen_read_me: true },
                    {},
                    context
                )
            ).rejects.toThrow(/skill_key/);
            expect(events).toEqual([]);
            await expect(
                showWidgetTool.execute({ ...args, skill_key: currentKey }, {}, context)
            ).resolves.toMatchObject({ status: 'success' });
            expect(events).toEqual([expect.objectContaining(expected)]);
        });
    });

    it.each([
        ['wrong credential', { skill_key: 'private-credential-value' }],
        ['malformed credential', { skill_key: ['private-credential-value'] }],
        [
            'invalid lifecycle',
            { skill_key: 'private-credential-value', mode: 'private-credential-value' },
        ],
    ])(
        'user receives credential-free diagnostics when the model submits a %s',
        async (_label, args) => {
            const { context, events } = createRequest();
            context.widgetSkillAccess.activate('{{WIDGET_SKILL_KEY}}');

            const error = await showWidgetTool
                .execute(
                    {
                        widget_code: '<section>Content</section>',
                        i_have_seen_read_me: true,
                        ...args,
                    },
                    {},
                    context
                )
                .catch((failure: unknown) => failure);

            expect(error).toBeInstanceOf(Error);
            expect(String(error)).not.toContain('private-credential-value');
            expect(events).toEqual([]);
        }
    );

    it('user receives credential-free diagnostics when authorized markup violates design rules', async () => {
        const { context, events } = createRequest();
        const key = context.widgetSkillAccess.activate('{{WIDGET_SKILL_KEY}}');

        const error = await showWidgetTool
            .execute(
                {
                    skill_key: key,
                    widget_code: '<section style="box-shadow:0 0 2px">Content</section>',
                },
                {},
                context
            )
            .catch((failure: unknown) => failure);

        expect(error).toBeInstanceOf(Error);
        expect(String(error)).toContain('ShowWidget design validation failed');
        expect(String(error)).not.toContain(key);
        expect(events).toEqual([]);
    });

    it('user discovers only the rendering tool when reading the widget tool group', () => {
        expect(builtInTools.map((tool) => tool.id)).toEqual(['show_widget']);
    });

    it('user sees a required string credential when reading the widget input contract', () => {
        expect(showWidgetTool.inputSchema.required).toContain('skill_key');
        expect(showWidgetTool.inputSchema.properties).toMatchObject({
            skill_key: { type: 'string' },
        });
        expect(showWidgetTool.inputSchema.properties).not.toHaveProperty('i_have_seen_read_me');
        expect(showWidgetTool.inputSchema.properties).not.toHaveProperty('iHaveSeenReadMe');
        expect(JSON.stringify(showWidgetTool.inputSchema)).not.toContain('{{WIDGET_SKILL_KEY}}');
    });
});
