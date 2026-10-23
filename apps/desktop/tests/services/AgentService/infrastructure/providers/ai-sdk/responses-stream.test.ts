import { describe, expect, it } from 'vitest';

import { normalizeResponsesReasoningStream } from '@/services/AgentService/infrastructure/providers/ai-sdk/responsesStream';

function sseResponse(lines: string[]): Response {
    return new Response(lines.join(''), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
    });
}

function eventLine(event: Record<string, unknown>): string {
    return `data: ${JSON.stringify(event)}\n\n`;
}

async function readAll(response: Response): Promise<string> {
    return await response.text();
}

describe('user sees streamed reasoning normalized', () => {
    it('user sees non-standard reasoning deltas rewritten into summary deltas', async () => {
        const response = sseResponse([
            eventLine({
                type: 'response.reasoning_text.delta',
                item_id: 'rs_1',
                output_index: 0,
                content_index: 0,
                delta: '思考中',
            }),
            eventLine({ type: 'response.output_text.delta', item_id: 'msg_1', delta: '你好' }),
            'data: [DONE]\n\n',
        ]);

        const output = await readAll(normalizeResponsesReasoningStream(response));
        const events = output
            .split('\n')
            .filter((line) => line.startsWith('data: ') && !line.includes('[DONE]'))
            .map((line) => JSON.parse(line.slice('data: '.length)));

        expect(events[0]).toMatchObject({
            type: 'response.reasoning_summary_text.delta',
            summary_index: 0,
            delta: '思考中',
        });
        expect(events[1]).toMatchObject({ type: 'response.output_text.delta', delta: '你好' });
        expect(output).toContain('data: [DONE]');
    });

    it('user sees standard events and non-data lines untouched', async () => {
        const line = eventLine({
            type: 'response.reasoning_summary_text.delta',
            summary_index: 0,
            delta: '标准',
        });
        const response = sseResponse(['event: message\n', line]);

        const output = await readAll(normalizeResponsesReasoningStream(response));

        expect(output).toBe(`event: message\n${line}`);
    });

    it('user sees events split across chunks still handled', async () => {
        const payload = JSON.stringify({
            type: 'response.reasoning_text.delta',
            item_id: 'rs_2',
            content_index: 0,
            delta: '跨块',
        });
        const full = `data: ${payload}\n\n`;
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode(full.slice(0, 12)));
                controller.enqueue(encoder.encode(full.slice(12)));
                controller.close();
            },
        });
        const response = new Response(body, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
        });

        const output = await readAll(normalizeResponsesReasoningStream(response));
        const event = JSON.parse(output.split('\n')[0]!.slice('data: '.length));

        expect(event).toMatchObject({
            type: 'response.reasoning_summary_text.delta',
            delta: '跨块',
        });
    });

    it('user sees a non event-stream response returned unchanged', async () => {
        const response = new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });

        const normalized = normalizeResponsesReasoningStream(response);

        expect(normalized).toBe(response);
    });

    it('user sees malformed payloads left untouched', async () => {
        const response = sseResponse(['data: not-json\n\n']);

        const output = await readAll(normalizeResponsesReasoningStream(response));

        expect(output).toBe('data: not-json\n\n');
    });
});
