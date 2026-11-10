import { describe, expect, it } from 'vitest';

import { publicToolCall, publicWidgetChunk } from '@/services/AgentService/execution/widgetStream';
import { WidgetSkillAccess } from '@/services/AgentService/skills/widgetAccess';

function fixture() {
    const access = new WidgetSkillAccess();
    const key = access.activate('{{WIDGET_SKILL_KEY}}');
    const chunk = (argumentsBuffer: string) => ({
        content: '',
        done: false,
        toolCallDeltas: [
            {
                index: 0,
                callId: 'widget',
                name: 'builtin__show_widget',
                argumentsBuffer,
                argumentsDelta: argumentsBuffer,
            },
        ],
    });
    return { access, key, chunk };
}

describe('given the widget read credential is private to execution', () => {
    it('user given a completed credential before streaming markup when receiving a draft then sees only the markup', async () => {
        const { access, key, chunk } = fixture();
        const result = await publicWidgetChunk(
            chunk(`{"skill_key":"${key}","widget_code":"<section>Hello`),
            access
        );
        expect(result.toolCallDeltas).toHaveLength(1);
        expect(result.toolCallDeltas?.[0]?.argumentsDelta).toBeUndefined();
        expect(JSON.parse(result.toolCallDeltas![0]!.argumentsBuffer)).toEqual({
            widget_code: '<section>Hello',
        });
        expect(JSON.stringify(result)).not.toContain(key);
    });

    it('user given markup before an unfinished credential when the stream pauses then sees no prematurely authorized draft', async () => {
        const { access, key, chunk } = fixture();
        const prefix = `{"widget_code":"<section>Hidden</section>","skill_key":"${key}`;
        expect((await publicWidgetChunk(chunk(prefix), access)).toolCallDeltas).toEqual([]);
        expect(
            (await publicWidgetChunk(chunk(`${prefix}-wrong"}`), access)).toolCallDeltas
        ).toEqual([]);
        expect((await publicWidgetChunk(chunk(`${prefix}"}`), access)).toolCallDeltas).toHaveLength(
            1
        );
    });

    it('user given a terminated request when an old credential arrives then sees no widget call or draft', async () => {
        const { access, key, chunk } = fixture();
        access.clear();
        const argumentsBuffer = JSON.stringify({ skill_key: key, widget_code: '<p>Old</p>' });
        const result = await publicWidgetChunk(
            {
                ...chunk(argumentsBuffer),
                toolCalls: [
                    { id: 'widget', name: 'builtin__show_widget', arguments: argumentsBuffer },
                ],
            },
            access
        );
        expect(result.toolCallDeltas).toEqual([]);
        expect(result.toolCalls).toEqual([]);
    });

    it('user given a widget checkpoint when arguments are projected then never retains its credential', () => {
        const { key } = fixture();
        const call = publicToolCall({
            id: 'widget',
            name: 'builtin__show_widget',
            arguments: JSON.stringify({ skill_key: key, widget_code: '<p>Saved</p>' }),
        });
        expect(JSON.parse(call.arguments)).toEqual({ widget_code: '<p>Saved</p>' });
        expect(publicToolCall({ ...call, arguments: `{"skill_key":"${key}` }).arguments).toBe('{}');
    });
});
