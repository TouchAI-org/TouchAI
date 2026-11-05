// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import http from 'node:http';
import net from 'node:net';

import { describe, expect, it } from 'vitest';

import { startPerfModelServer } from '../../../scripts/perf/710/local-model-server.mjs';

async function findFreePort(): Promise<number> {
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('Expected a TCP address');
    }
    const port = address.port;
    await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
    });
    return port;
}

function postInvalidJson(port: number): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const request = http.request(
            {
                host: '127.0.0.1',
                port,
                path: '/v1/chat/completions',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
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
        request.end('{"messages":');
    });
}

describe('user runs the RFC 710 local model server', () => {
    it('user sees a generic error without parser diagnostics for an invalid JSON body', async () => {
        const port = await findFreePort();
        const running = await startPerfModelServer({ port });

        try {
            const response = await postInvalidJson(port);

            expect(response.status).toBe(400);
            expect(JSON.parse(response.body)).toEqual({
                error: { message: 'Invalid JSON body.' },
            });
            expect(response.body).not.toMatch(/SyntaxError|local-model-server/);
        } finally {
            await running.close();
        }
    });
});
