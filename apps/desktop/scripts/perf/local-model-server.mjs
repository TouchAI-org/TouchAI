import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { createEmulator, defineEmulator } from 'emulate';

const DEFAULT_PORT = Number(process.env.TOUCHAI_PERF_PORT) || 3426;
const DEFAULT_CHUNK_DELAY_MS = 16;
const encoder = new TextEncoder();

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function appendJsonLine(file, value) {
    if (!file) return;
    try {
        fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
    } catch (error) {
        console.error('PERF710 model server could not append its log:', error);
    }
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

function createCompletionStream({ id, model }) {
    let controller;
    let ended = false;

    function writeChunk(delta, finishReason = null) {
        if (ended || !controller) return false;
        try {
            controller.enqueue(
                encoder.encode(
                    `data: ${JSON.stringify(chunkPayload({ id, model, delta, finishReason }))}\n\n`
                )
            );
            return true;
        } catch {
            ended = true;
            return false;
        }
    }

    const readable = new ReadableStream({
        start(next) {
            controller = next;
            writeChunk({ role: 'assistant', content: '' });
        },
        cancel() {
            ended = true;
        },
    });

    async function write(delta, delayMs, finishReason = null) {
        if (delayMs > 0) await sleep(delayMs);
        return writeChunk(delta, finishReason);
    }

    async function finish(reason = 'stop', delayMs = 0) {
        if (!(await write({}, delayMs, reason))) return false;
        ended = true;
        try {
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
        } catch {
            // The client already closed the stream.
        }
        return true;
    }

    return {
        readable,
        write,
        finish,
    };
}

async function streamResponse(stream, body, prompt, options) {
    const rounds = Math.max(0, Number(prompt.fields.rounds) || 0);
    const toolCount = body.messages
        .slice(prompt.userIndex + 1)
        .filter((message) => message?.role === 'tool').length;
    const alternate = prompt.fields.alternate === '1';
    const chunkDelayMs = Number(prompt.fields.chunkDelayMs) || options.chunkDelayMs;

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
        if (
            !(await stream.write(
                {
                    tool_calls: [toolCall],
                },
                chunkDelayMs
            ))
        ) {
            return false;
        }
        await stream.finish('tool_calls', chunkDelayMs);
        return false;
    }

    const finalDeltas = finalChunks({
        prompt,
        chunks: prompt.fields.chunks,
        chunkBytes: prompt.fields.chunkBytes,
        alternate,
    });
    for (const delta of finalDeltas) {
        if (!(await stream.write(delta, chunkDelayMs))) return false;
    }

    return await stream.finish('stop', chunkDelayMs);
}

export async function startPerfModelServer(options = {}) {
    const requestedPort = options.port ?? DEFAULT_PORT;
    if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
        throw new Error(`Invalid performance model port: ${requestedPort}`);
    }
    const logFile = options.logFile ?? null;
    if (logFile) {
        fs.mkdirSync(path.dirname(logFile), { recursive: true });
    }
    const state = {
        chunkDelayMs: Number(options.chunkDelayMs) || DEFAULT_CHUNK_DELAY_MS,
        logFile,
    };

    const definition = defineEmulator({
        name: 'touchai-perf-model',
        state: () => ({}),
        setup({ app }) {
            const models = (c) =>
                c.json({
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
                });

            app.get('/v1/models', models);
            app.get('/models', models);

            app.get('/health', (c) => c.json({ ok: true }));

            app.post('/v1/chat/completions', async (c) => {
                let body;
                try {
                    body = await c.req.json();
                } catch {
                    return c.json({ error: { message: 'Invalid JSON body.' } }, 400);
                }

                const messages = Array.isArray(body?.messages) ? body.messages : [];
                const prompt = parsePerfPrompt(messages);
                if (!prompt) {
                    return c.json({ error: { message: 'Missing PERF710 prompt marker.' } }, 400);
                }

                const model = typeof body.model === 'string' ? body.model : 'perf-model';
                const toolCount = messages
                    .slice(prompt.userIndex + 1)
                    .filter((message) => message?.role === 'tool').length;
                const rounds = Math.max(0, Number(prompt.fields.rounds) || 0);
                const id = `chatcmpl-perf-${createHash('sha256')
                    .update(`${prompt.fields.promptId}:${toolCount}`)
                    .digest('hex')
                    .slice(0, 12)}`;
                const response = createCompletionStream({ id, model });

                appendJsonLine(state.logFile, {
                    type: 'request',
                    at: Date.now(),
                    promptId: prompt.fields.promptId ?? null,
                    flow: prompt.fields.flow ?? null,
                    toolCount,
                    rounds,
                    alternate: prompt.fields.alternate === '1',
                });

                Promise.resolve()
                    .then(() => streamResponse(response, body, prompt, state))
                    .then((completed) => {
                        if (!completed) return;
                        appendJsonLine(state.logFile, {
                            type: 'complete',
                            at: Date.now(),
                            promptId: prompt.fields.promptId ?? null,
                            flow: prompt.fields.flow ?? null,
                        });
                    })
                    .catch((error) => {
                        appendJsonLine(state.logFile, {
                            type: 'error',
                            at: Date.now(),
                            error: String(error),
                        });
                        void response.finish('stop');
                    });

                return c.body(response.readable, 200, {
                    'Content-Type': 'text/event-stream',
                    'Cache-Control': 'no-cache, no-transform',
                    Connection: 'keep-alive',
                    'X-Accel-Buffering': 'no',
                });
            });
        },
    });

    const emulator = await createEmulator({
        service: definition,
        port: requestedPort,
        hostname: '127.0.0.1',
    });
    const port = Number(new URL(emulator.url).port);

    return {
        endpoint: `${emulator.url}/v1`,
        port,
        close: () => emulator.close(),
    };
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const portArgIndex = process.argv.indexOf('--port');
    const logArgIndex = process.argv.indexOf('--log');
    const port =
        portArgIndex >= 0
            ? Number(process.argv[portArgIndex + 1])
            : process.env.PERF710_PORT
              ? Number(process.env.PERF710_PORT)
              : undefined;
    const logFile = logArgIndex >= 0 ? process.argv[logArgIndex + 1] : undefined;
    const running = await startPerfModelServer({ port, logFile });
    console.log(`PERF710 model server listening on ${running.endpoint}`);
    await new Promise((resolve) => {
        process.once('SIGINT', resolve);
        process.once('SIGTERM', resolve);
    });
    await running.close();
}
