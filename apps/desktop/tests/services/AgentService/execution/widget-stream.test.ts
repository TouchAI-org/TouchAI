import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    createPublicWidgetStream,
    publicToolCall,
} from '@/services/AgentService/execution/widgetStream';
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
    return { access, key, chunk, project: createPublicWidgetStream(access) };
}

describe('given the widget read credential is private to execution', () => {
    afterEach(() => vi.useRealTimers());
    it('user given a completed credential before streaming markup when receiving a draft then sees only the markup', async () => {
        const { key, chunk, project } = fixture();
        const result = await project(chunk(`{"skill_key":"${key}","widget_code":"<section>Hello`));
        expect(result.toolCallDeltas).toHaveLength(1);
        expect(result.toolCallDeltas?.[0]?.argumentsDelta).toBeUndefined();
        expect(JSON.parse(result.toolCallDeltas![0]!.argumentsBuffer)).toEqual({
            widget_code: '<section>Hello',
        });
        expect(JSON.stringify(result)).not.toContain(key);
    });

    it('user given markup before an unfinished credential when the stream pauses then sees no prematurely authorized draft', async () => {
        const { key, chunk, project } = fixture();
        const prefix = `{"widget_code":"<section>Hidden</section>","skill_key":"${key}`;
        expect((await project(chunk(prefix))).toolCallDeltas).toEqual([]);
        expect((await project(chunk(`${prefix}-wrong"}`))).toolCallDeltas).toEqual([]);
        expect((await project(chunk(`${prefix}"}`))).toolCallDeltas).toHaveLength(1);
    });

    it('user given a terminated request when an old credential arrives then sees no widget call or draft', async () => {
        const { access, key, chunk, project } = fixture();
        access.clear();
        const argumentsBuffer = JSON.stringify({ skill_key: key, widget_code: '<p>Old</p>' });
        const result = await project({
            ...chunk(argumentsBuffer),
            toolCalls: [{ id: 'widget', name: 'builtin__show_widget', arguments: argumentsBuffer }],
        });
        expect(result.toolCallDeltas).toEqual([]);
        expect(result.toolCalls).toEqual([]);
    });

    it('user receives coalesced large widget drafts while text and other tool updates continue immediately', async () => {
        vi.useFakeTimers();
        const { key, chunk, project } = fixture();
        const prefix = `{"skill_key":"${key}","widget_code":"<p>${'x'.repeat(3000)}`;
        expect((await project(chunk(prefix))).toolCallDeltas).toHaveLength(1);
        const other = { index: 1, callId: 'other', name: 'other_tool', argumentsBuffer: '{}' };
        const burst = await project({
            ...chunk(`${prefix} next`),
            content: 'Still answering',
            toolCallDeltas: [...chunk(`${prefix} next`).toolCallDeltas, other],
        });
        expect(burst.content).toBe('Still answering');
        expect(burst.toolCallDeltas).toEqual([other]);
        await vi.advanceTimersByTimeAsync(150);
        const latest = await project(chunk(`${prefix} newest`));
        expect(latest.toolCallDeltas).toHaveLength(1);
        expect(latest.toolCallDeltas![0]!.argumentsBuffer).toContain('newest');
        expect(JSON.stringify(latest)).not.toContain(key);
    });

    it('user receives complete widget arguments immediately even inside the draft interval', async () => {
        vi.useFakeTimers();
        const { key, chunk, project } = fixture();
        const prefix = `{"skill_key":"${key}","widget_code":"<p>${'x'.repeat(3000)}`;
        await project(chunk(prefix));
        const final = `${prefix} finished</p>"}`;
        const complete = chunk(final);
        const result = await project({
            ...complete,
            toolCallDeltas: complete.toolCallDeltas.map((delta) => ({
                ...delta,
                isComplete: true,
            })),
        });
        expect(result.toolCallDeltas?.[0]?.argumentsBuffer).toContain('finished</p>');
        const done = await project({
            ...chunk(final),
            done: true,
            toolCalls: [{ id: 'widget', name: 'builtin__show_widget', arguments: final }],
        });
        expect(done.toolCalls).toHaveLength(1);
        expect(JSON.stringify(done)).not.toContain(key);
    });

    it('user receives a widget when its credential arrives after markup without retaining a rejected authorization', async () => {
        vi.useFakeTimers();
        const { key, chunk, project } = fixture();
        const prefix = `{"widget_code":"<p>${'x'.repeat(3000)}</p>"`;
        expect((await project(chunk(prefix))).toolCallDeltas).toEqual([]);
        expect((await project(chunk(`${prefix},"skill_key":"${key}`))).toolCallDeltas).toEqual([]);
        await vi.advanceTimersByTimeAsync(150);
        const result = await project(chunk(`${prefix},"skill_key":"${key}","title":"Ready`));
        expect(result.toolCallDeltas).toHaveLength(1);
        expect(JSON.stringify(result)).not.toContain(key);
    });

    it('user starts another model step and receives its first draft without the previous step delaying it', async () => {
        vi.useFakeTimers();
        const { access, key, chunk, project } = fixture();
        const prefix = `{"skill_key":"${key}","widget_code":"<p>${'x'.repeat(3000)}`;
        await project(chunk(prefix));
        const nextStep = createPublicWidgetStream(access);
        expect((await nextStep(chunk(`${prefix} next step`))).toolCallDeltas).toHaveLength(1);
        access.clear();
        await vi.advanceTimersByTimeAsync(150);
        expect((await nextStep(chunk(`${prefix} revoked`))).toolCallDeltas).toEqual([]);
    });

    it('user receives interleaved widget drafts independently and sees a corrected shorter draft immediately', async () => {
        vi.useFakeTimers();
        const { key, chunk, project } = fixture();
        const prefix = `{"skill_key":"${key}","widget_code":"<p>${'x'.repeat(4000)}`;
        await project(chunk(prefix));
        const second = chunk(`${prefix} second`);
        second.toolCallDeltas[0]!.callId = 'second';
        expect((await project(second)).toolCallDeltas?.[0]?.callId).toBe('second');
        const corrected = prefix.slice(0, -500);
        expect((await project(chunk(corrected))).toolCallDeltas).toHaveLength(1);
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
