import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';

const DEFAULT_PORT = Number(process.env.TOUCHAI_PERF_PORT) || 3426;
const DEFAULT_CHUNK_DELAY_MS = 16;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function appendJsonLine(file, value) {
    if (!file) return;
    fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
}

function contentText(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.map((part) => (part && typeof part.text === 'string' ? part.text : '')).join('');
}

function parsePerfPrompt(messages) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.role !== 'user') continue;

        const text = contentText(message.content);
        const marker = text.match(/PERF710\|[^\n]+/)?.[0];
        if (!marker) continue;

        const fields = Object.fromEntries(
            marker
                .split('|')
                .slice(1)
                .map((entry) => entry.split('='))
                .filter(([key, value]) => key && value !== undefined)
        );
        return {
            marker,
            fields,
            userIndex: index,
            doneToken: `PERF710_DONE_${createHash('sha256')
                .update(fields.promptId ?? marker)
                .digest('hex')
                .slice(0, 16)}`,
        };
    }

    return null;
}

function chunkPayload({ id, model, delta, finishReason = null }) {
    return {
        id,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
            {
                index: 0,
                delta,
                finish_reason: finishReason,
            },
        ],
    };
}

function finalChunks({ prompt, chunks, chunkBytes, alternate }) {
    const chunkCount = Math.max(1, Number(chunks) || 1);
    const bytes = Math.max(1, Number(chunkBytes) || 1);
    const fill = 'x'.repeat(bytes);
    const contentChunks = Array.from({ length: chunkCount }, () => fill);
    contentChunks[contentChunks.length - 1] =
        `${fill.slice(0, Math.max(0, fill.length - prompt.doneToken.length - 2))} ${prompt.doneToken}`;

    if (!alternate) {
        return contentChunks.map((content) => ({ content }));
    }

    return contentChunks.flatMap((content, index) => [
        { reasoning: `reasoning-${index}-${'r'.repeat(Math.min(bytes, 512))}\n` },
        { content },
    ]);
}

async function writeSse(res, payload, delayMs) {
    if (delayMs > 0) await sleep(delayMs);
    if (res.destroyed || res.writableEnded) return false;
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
    return true;
}

async function streamResponse(res, requestBody, options) {
    const prompt = parsePerfPrompt(Array.isArray(requestBody.messages) ? requestBody.messages : []);
    if (!prompt) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Missing PERF710 prompt marker.' } }));
        return;
    }

    const rounds = Math.max(0, Number(prompt.fields.rounds) || 0);
    const toolCount = requestBody.messages
        .slice(prompt.userIndex + 1)
        .filter((message) => message?.role === 'tool').length;
    const model = typeof requestBody.model === 'string' ? requestBody.model : 'perf-model';
    const alternate = prompt.fields.alternate === '1';
    const id = `chatcmpl-perf-${createHash('sha256')
        .update(`${prompt.fields.promptId}:${toolCount}`)
        .digest('hex')
        .slice(0, 12)}`;
    const chunkDelayMs = Number(prompt.fields.chunkDelayMs) || options.chunkDelayMs;

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    appendJsonLine(options.logFile, {
        type: 'request',
        at: Date.now(),
        promptId: prompt.fields.promptId ?? null,
        flow: prompt.fields.flow ?? null,
        toolCount,
        rounds,
        alternate,
    });

    const roleWritten = await writeSse(
        res,
        chunkPayload({ id, model, delta: { role: 'assistant', content: '' } }),
        0
    );
    if (!roleWritten) return;

    if (toolCount < rounds) {
        const toolCall = {
            index: 0,
            id: `perf_call_${prompt.fields.promptId}_${toolCount}`,
            type: 'function',
            function: {
                name: 'builtin__setting',
                arguments: '{"action":"get","keys":["language"]}',
            },
        };
        const wroteTool = await writeSse(
            res,
            chunkPayload({
                id,
                model,
                delta: { tool_calls: [toolCall] },
            }),
            chunkDelayMs
        );
        if (!wroteTool) return;
        await writeSse(
            res,
            chunkPayload({ id, model, delta: {}, finishReason: 'tool_calls' }),
            chunkDelayMs
        );
        if (!res.destroyed && !res.writableEnded) {
            res.write('data: [DONE]\n\n');
            res.end();
        }
        return;
    }

    const finalDeltas = finalChunks({
        prompt,
        chunks: prompt.fields.chunks,
        chunkBytes: prompt.fields.chunkBytes,
        alternate,
    });
    for (const delta of finalDeltas) {
        const wrote = await writeSse(res, chunkPayload({ id, model, delta }), chunkDelayMs);
        if (!wrote) return;
    }

    await writeSse(res, chunkPayload({ id, model, delta: {}, finishReason: 'stop' }), chunkDelayMs);
    if (!res.destroyed && !res.writableEnded) {
        res.write('data: [DONE]\n\n');
        res.end();
        appendJsonLine(options.logFile, {
            type: 'complete',
            at: Date.now(),
            promptId: prompt.fields.promptId ?? null,
            flow: prompt.fields.flow ?? null,
        });
    }
}

export async function startPerfModelServer(options = {}) {
    const port = Number(options.port) || DEFAULT_PORT;
    const state = {
        port,
        chunkDelayMs: Number(options.chunkDelayMs) || DEFAULT_CHUNK_DELAY_MS,
        logFile: options.logFile ?? null,
    };

    const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
        if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
                JSON.stringify({
                    object: 'list',
                    data: [
                        {
                            id: 'perf-model',
                            object: 'model',
                            created: 1700000000,
                            owned_by: 'touchai-perf',
                            context_window: 131072,
                            max_output_tokens: 16384,
                            tool_call: true,
                            reasoning: true,
                        },
                    ],
                })
            );
            return;
        }

        if (req.method === 'GET' && url.pathname === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            return;
        }

        if (req.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Not found' } }));
            return;
        }

        const bodyChunks = [];
        req.on('data', (chunk) => bodyChunks.push(chunk));
        req.on('end', () => {
            let body;
            try {
                body = JSON.parse(Buffer.concat(bodyChunks).toString('utf8'));
            } catch {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: { message: 'Invalid JSON body.' } }));
                return;
            }
            void streamResponse(res, body, state).catch((error) => {
                appendJsonLine(state.logFile, {
                    type: 'error',
                    at: Date.now(),
                    error: String(error),
                });
                if (!res.headersSent) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                }
                if (!res.writableEnded) res.end();
            });
        });
    });

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
    });

    return {
        server,
        port,
        close: () =>
            new Promise((resolve) => {
                server.close(() => resolve());
            }),
    };
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const portArgIndex = process.argv.indexOf('--port');
    const logArgIndex = process.argv.indexOf('--log');
    const port =
        portArgIndex >= 0
            ? Number(process.argv[portArgIndex + 1])
            : Number(process.env.PERF710_PORT);
    const logFile = logArgIndex >= 0 ? process.argv[logArgIndex + 1] : undefined;
    const running = await startPerfModelServer({ port, logFile });
    console.log(`PERF710 model server listening on ${running.port}`);
    await new Promise((resolve) => {
        process.once('SIGINT', resolve);
        process.once('SIGTERM', resolve);
    });
    await running.close();
}
