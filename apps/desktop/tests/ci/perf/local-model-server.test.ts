// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { startPerfModelServer } from '../../../scripts/perf/local-model-server.mjs';

const cleanup: string[] = [];

function postInvalidJson(port: number): Promise<{ status: number; body: string }> {
    return postRaw(port, '{"messages":');
}

function postRaw(port: number, payload: string): Promise<{ status: number; body: string }> {
    const body = Buffer.from(payload);
    return new Promise((resolve, reject) => {
        const request = http.request(
            {
                host: '127.0.0.1',
                port,
                path: '/v1/chat/completions',
                method: 'POST',
                agent: false,
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': body.length,
                    Connection: 'close',
                },
            },
            (response) => {
                const chunks: Buffer[] = [];
                response.on('data', (chunk: Buffer) => chunks.push(chunk));
                response.on('end', () => {
                    resolve({
                        status: response.statusCode ?? 0,
                        body: Buffer.concat(chunks).toString('utf8'),
                    });
                });
            }
        );
        request.once('error', reject);
        request.end(body);
    });
}

function postChat(port: number, body: unknown): Promise<{ status: number; body: string }> {
    return postRaw(port, JSON.stringify(body));
}

afterAll(() => {
    for (const root of cleanup) fs.rmSync(root, { recursive: true, force: true });
});

describe('user runs the RFC 710 local model server', () => {
    it('user sees a generic error without parser diagnostics for an invalid JSON body', async () => {
        const running = await startPerfModelServer({ port: 0 });

        try {
            const response = await postInvalidJson(running.port);

            expect(response.status).toBe(400);
            expect(JSON.parse(response.body)).toEqual({
                error: { message: 'Invalid JSON body.' },
            });
            expect(response.body).not.toMatch(/SyntaxError|local-model-server/);
        } finally {
            await running.close();
        }
    });

    it('user completes a tool-call round and writes logs beneath a new directory', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'touchai-perf-model-'));
        cleanup.push(root);
        const logFile = path.join(root, 'nested', 'model-server.jsonl');
        const running = await startPerfModelServer({ port: 0, logFile });
        const promptId = 'tool-round';
        const marker = `PERF710|promptId=${promptId}|rounds=1|chunks=1|chunkBytes=8|flow=latency`;

        try {
            const toolResponse = await postChat(running.port, {
                model: 'perf-model',
                messages: [{ role: 'user', content: marker }],
            });
            expect(toolResponse.status).toBe(200);
            expect(toolResponse.body).toContain('"tool_calls"');
            expect(toolResponse.body).toContain('builtin__setting');
            expect(toolResponse.body).toContain('"finish_reason":"tool_calls"');
            expect(toolResponse.body).toContain('data: [DONE]');

            const finalResponse = await postChat(running.port, {
                model: 'perf-model',
                messages: [
                    { role: 'user', content: marker },
                    { role: 'assistant', content: '' },
                    { role: 'tool', content: 'language=en-US' },
                ],
            });
            const doneToken = `PERF710_DONE_${createHash('sha256')
                .update(promptId)
                .digest('hex')
                .slice(0, 16)}`;
            expect(finalResponse.status).toBe(200);
            expect(finalResponse.body).toContain(doneToken);
            expect(finalResponse.body).toContain('"finish_reason":"stop"');
            expect(finalResponse.body).toContain('data: [DONE]');

            const records = fs
                .readFileSync(logFile, 'utf8')
                .trim()
                .split('\n')
                .map((line) => JSON.parse(line));
            expect(records.filter((record) => record.type === 'request')).toHaveLength(2);
            expect(records.filter((record) => record.type === 'complete')).toHaveLength(1);
        } finally {
            await running.close();
        }
    });
});
