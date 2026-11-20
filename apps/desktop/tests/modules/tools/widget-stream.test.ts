import type { AiStreamChunk } from '@touchai/models/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPublicWidgetStream } from '@/modules/tools';

const cleanups: (() => void)[] = [];
afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    vi.useRealTimers();
});

function fixture() {
    const controller = new AbortController();
    const deferred: AiStreamChunk[] = [];
    const errors: unknown[] = [];
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
    const project = createPublicWidgetStream({
        signal: controller.signal,
        publish: (value) => deferred.push(value),
        reportError: (error) => errors.push(error),
    });
    cleanups.push(project.dispose);
    return { chunk, project, controller, deferred, errors };
}

describe('given the model must acknowledge the loaded widget guide', () => {
    it('user given a completed acknowledgement before streaming markup when receiving a draft then sees the draft', async () => {
        const { chunk, project } = fixture();
        const result = await project(
            chunk(`{"is_read_widget_skill":true,"widget_code":"<section>Hello`)
        );
        expect(result.toolCallDeltas).toHaveLength(1);
        expect(result.toolCallDeltas?.[0]?.argumentsDelta).toBeUndefined();
        expect(JSON.parse(result.toolCallDeltas![0]!.argumentsBuffer)).toEqual({
            is_read_widget_skill: true,
            widget_code: '<section>Hello',
        });
    });

    it('user given markup before an acknowledgement when the stream pauses then sees no premature draft', async () => {
        const { chunk, project } = fixture();
        const prefix = '{"widget_code":"<section>Hidden</section>"';
        expect((await project(chunk(prefix))).toolCallDeltas).toEqual([]);
        expect(
            (await project(chunk(`${prefix},"is_read_widget_skill":false}`))).toolCallDeltas
        ).toEqual([]);
        expect(
            (await project(chunk(`${prefix},"is_read_widget_skill":true}`))).toolCallDeltas
        ).toHaveLength(1);
    });

    it('user given a legacy key when the stream ends then sees no widget call or draft', async () => {
        const { chunk, project } = fixture();
        const argumentsBuffer = JSON.stringify({ skill_key: 'legacy', widget_code: '<p>Old</p>' });
        const result = await project({
            ...chunk(argumentsBuffer),
            toolCalls: [{ id: 'widget', name: 'builtin__show_widget', arguments: argumentsBuffer }],
        });
        expect(result.toolCallDeltas).toEqual([]);
        expect(result.toolCalls).toEqual([]);
    });

    it('user given an acknowledgement with a legacy key when the stream ends then sees no widget call or draft', async () => {
        const { chunk, project } = fixture();
        const argumentsBuffer = JSON.stringify({
            is_read_widget_skill: true,
            skill_key: 'legacy',
            widget_code: '<p>Old</p>',
        });
        const result = await project({
            ...chunk(argumentsBuffer),
            toolCalls: [{ id: 'widget', name: 'builtin__show_widget', arguments: argumentsBuffer }],
        });
        expect(result.toolCallDeltas).toEqual([]);
        expect(result.toolCalls).toEqual([]);
    });

    it('user receives coalesced large widget drafts while text and other tool updates continue immediately', async () => {
        vi.useFakeTimers();
        const { chunk, project, deferred } = fixture();
        const prefix = `{"is_read_widget_skill":true,"widget_code":"<p>${'x'.repeat(3000)}`;
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
        expect(deferred[0]?.toolCallDeltas?.[0]?.argumentsBuffer).toContain('next');
        const latest = await project(chunk(`${prefix} newest`));
        expect(latest.toolCallDeltas).toEqual([]);
        await vi.advanceTimersByTimeAsync(150);
        expect(deferred.at(-1)?.toolCallDeltas?.[0]?.argumentsBuffer).toContain('newest');
    });

    it('user receives complete widget arguments immediately even inside the draft interval', async () => {
        vi.useFakeTimers();
        const { chunk, project } = fixture();
        const prefix = `{"is_read_widget_skill":true,"widget_code":"<p>${'x'.repeat(3000)}`;
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
    });

    it('user receives a widget when its acknowledgement arrives after markup', async () => {
        vi.useFakeTimers();
        const { chunk, project } = fixture();
        const prefix = `{"widget_code":"<p>${'x'.repeat(3000)}</p>"`;
        expect((await project(chunk(prefix))).toolCallDeltas).toEqual([]);
        expect(
            (await project(chunk(`${prefix},"is_read_widget_skill":true`))).toolCallDeltas
        ).toEqual([]);
        await vi.advanceTimersByTimeAsync(150);
        const result = await project(chunk(`${prefix},"is_read_widget_skill":true,"title":"Ready`));
        expect(result.toolCallDeltas).toHaveLength(1);
    });

    it('user starts another model step and receives its first draft without the previous step delaying it', async () => {
        vi.useFakeTimers();
        const { chunk, project } = fixture();
        const prefix = `{"is_read_widget_skill":true,"widget_code":"<p>${'x'.repeat(3000)}`;
        await project(chunk(prefix));
        const nextStep = fixture().project;
        expect((await nextStep(chunk(`${prefix} next step`))).toolCallDeltas).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(150);
        expect((await nextStep(chunk(`${prefix} next`))).toolCallDeltas).toHaveLength(1);
    });

    it('user receives interleaved widget drafts independently and sees a corrected shorter draft immediately', async () => {
        vi.useFakeTimers();
        const { chunk, project } = fixture();
        const prefix = `{"is_read_widget_skill":true,"widget_code":"<p>${'x'.repeat(4000)}`;
        await project(chunk(prefix));
        const second = chunk(`${prefix} second`);
        second.toolCallDeltas[0]!.callId = 'second';
        expect((await project(second)).toolCallDeltas?.[0]?.callId).toBe('second');
        const corrected = prefix.slice(0, -500);
        expect((await project(chunk(corrected))).toolCallDeltas).toHaveLength(1);
    });

    it('user aborts or closes a stream with a pending draft and receives no deferred widget update', async () => {
        vi.useFakeTimers();
        for (const cancel of ['abort', 'close']) {
            const { chunk, project, controller, deferred } = fixture();
            const prefix = `{"is_read_widget_skill":true,"widget_code":"<p>${'x'.repeat(3000)}`;
            await project(chunk(prefix));
            await project(chunk(`${prefix} pending`));
            if (cancel === 'abort') controller.abort();
            else project.dispose();
            await vi.advanceTimersByTimeAsync(150);
            expect(deferred).toEqual([]);
            expect((await project(chunk(`${prefix} late`))).toolCallDeltas).toEqual([]);
        }
    });

    it('user streams more than the bounded draft capacity and only retained calls publish their newest pending draft', async () => {
        vi.useFakeTimers();
        const { chunk, project, deferred } = fixture();
        const prefix = `{"is_read_widget_skill":true,"widget_code":"<p>${'x'.repeat(3000)}`;
        for (let index = 0; index < 33; index++) {
            const initial = chunk(prefix);
            initial.toolCallDeltas[0]!.callId = `widget-${index}`;
            await project(initial);
            const next = chunk(`${prefix} latest ${index}`);
            next.toolCallDeltas[0]!.callId = `widget-${index}`;
            await project(next);
        }
        await vi.advanceTimersByTimeAsync(150);
        const ids = deferred.flatMap(
            (value) => value.toolCallDeltas?.map((delta) => delta.callId) ?? []
        );
        expect(ids).toHaveLength(32);
        expect(ids).not.toContain('widget-0');
        expect(ids.at(-1)).toBe('widget-32');
    });
});
