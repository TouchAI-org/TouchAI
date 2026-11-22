import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { createEmulator, defineEmulator } from 'emulate';

import { DEFAULT_PORT } from './lib/config.mjs';

const DEFAULT_CHUNK_DELAY_MS = 16;
const EXPECTED_TOOL_NAME = 'builtin__setting';
const EXPECTED_TOOL_ARGUMENTS = { action: 'get', keys: ['language'] };
const encoder = new TextEncoder();

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function createJsonLineSink(file) {
    let pending = Promise.resolve();
    return {
        write(value) {
            if (!file) return;
            const line = `${JSON.stringify(value)}\n`;
            pending = pending
                .then(() => fs.promises.appendFile(file, line))
                .catch((error) => {
                    console.error('TOUCHAI_PERF model server could not append its log:', error);
                });
        },
        flush() {
            return pending;
        },
    };
}

function contentText(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.map((part) => (part && typeof part.text === 'string' ? part.text : '')).join('');
}

function expectedToolCallId(promptId, round) {
    return `perf_call_${promptId}_${round}`;
}

function sameJsonValue(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}

function expectedSettingCall(call, promptId, round) {
    return call?.id === expectedToolCallId(promptId, round);
}

function validateToolHistory(messages, prompt, rounds) {
    const promptId = prompt.fields.promptId;
    const afterPrompt = messages.slice(prompt.userIndex + 1);
    let cursor = 0;
    let count = 0;

    while (count < rounds) {
        let callIndex = cursor;
        while (
            callIndex < afterPrompt.length &&
            afterPrompt[callIndex]?.role !== 'tool' &&
            !Array.isArray(afterPrompt[callIndex]?.tool_calls)
        ) {
            callIndex += 1;
        }
        const message = afterPrompt[callIndex];
        const call = Array.isArray(message?.tool_calls)
            ? message.tool_calls.find((item) => expectedSettingCall(item, promptId, count))
            : null;
        if (!message || !call) {
            break;
        }
        const callId = expectedToolCallId(promptId, count);
        if (
            message.tool_calls.length !== 1 ||
            call.type !== 'function' ||
            call.function?.name !== EXPECTED_TOOL_NAME
        ) {
            return {
                count: 0,
                error: `Invalid performance tool history: round ${count + 1} used the wrong tool call.`,
            };
        }
        let args;
        try {
            args =
                typeof call.function.arguments === 'string'
                    ? JSON.parse(call.function.arguments)
                    : call.function.arguments;
        } catch {
            return {
                count: 0,
                error: `Invalid performance tool history: round ${count + 1} has malformed arguments.`,
            };
        }
        if (!sameJsonValue(args, EXPECTED_TOOL_ARGUMENTS)) {
            return {
                count: 0,
                error: `Invalid performance tool history: round ${count + 1} read the wrong setting.`,
            };
        }

        const result = afterPrompt[callIndex + 1];
        if (result?.role !== 'tool' || result.tool_call_id !== callId) {
            return {
                count: 0,
                error: `Invalid performance tool history: round ${count + 1} has no matching call ID result.`,
            };
        }
        if (
            result.isError === true ||
            !/\(language\)\s*:\s*(?:en-US|zh-CN)\b/.test(contentText(result.content))
        ) {
            return {
                count: 0,
                error: `Invalid performance tool history: round ${count + 1} did not read the setting successfully.`,
            };
        }

        cursor = callIndex + 2;
        count += 1;
    }

    const leftover = afterPrompt.slice(cursor);
    if (leftover.some((message) => message?.role === 'tool')) {
        return {
            count: 0,
            error: 'Invalid performance tool history: unexpected or mismatched tool result.',
        };
    }
    if (leftover.some((message) => message?.tool_calls?.length)) {
        return {
            count: 0,
            error: 'Invalid performance tool history: unexpected or incomplete tool call.',
        };
    }
    return { count, error: null };
}

function parsePerfPrompt(messages) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.role !== 'user') continue;

        const text = contentText(message.content);
        const marker = text.match(/TOUCHAI_PERF\|[^\n]+/)?.[0];
        if (!marker) continue;

        const fields = Object.fromEntries(
            marker
                .split('|')
                .slice(1)
                .map((entry) => entry.split('='))
                .filter(([key, value]) => key && value !== undefined)
        );
        return {
            fields,
            userIndex: index,
            doneToken: `TOUCHAI_PERF_DONE_${createHash('sha256')
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

async function streamResponse(stream, prompt, options, toolCount) {
    const rounds = Math.max(0, Number(prompt.fields.rounds) || 0);
    const alternate = prompt.fields.alternate === '1';
    const chunkDelayMs = Number(prompt.fields.chunkDelayMs) || options.chunkDelayMs;

    if (toolCount < rounds) {
        const toolCall = {
            index: 0,
            id: `perf_call_${prompt.fields.promptId}_${toolCount}`,
            type: 'function',
            function: {
                name: EXPECTED_TOOL_NAME,
                arguments: JSON.stringify(EXPECTED_TOOL_ARGUMENTS),
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
        log: createJsonLineSink(logFile),
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
                    return c.json(
                        { error: { message: 'Missing TOUCHAI_PERF prompt marker.' } },
                        400
                    );
                }

                const model = typeof body.model === 'string' ? body.model : 'perf-model';
                const rounds = Math.max(0, Number(prompt.fields.rounds) || 0);
                const history = validateToolHistory(messages, prompt, rounds);
                if (history.error) {
                    state.log.write({
                        type: 'invalid-tool-history',
                        at: Date.now(),
                        promptId: prompt.fields.promptId ?? null,
                        flow: prompt.fields.flow ?? null,
                        error: history.error,
                    });
                    return c.json({ error: { message: history.error } }, 400);
                }
                const toolCount = history.count;
                const id = `chatcmpl-perf-${createHash('sha256')
                    .update(`${prompt.fields.promptId}:${toolCount}`)
                    .digest('hex')
                    .slice(0, 12)}`;
                const response = createCompletionStream({ id, model });

                state.log.write({
                    type: 'request',
                    at: Date.now(),
                    promptId: prompt.fields.promptId ?? null,
                    flow: prompt.fields.flow ?? null,
                    toolCount,
                    rounds,
                    alternate: prompt.fields.alternate === '1',
                });

                Promise.resolve()
                    .then(() => streamResponse(response, prompt, state, toolCount))
                    .then((completed) => {
                        if (!completed) return;
                        state.log.write({
                            type: 'complete',
                            at: Date.now(),
                            promptId: prompt.fields.promptId ?? null,
                            flow: prompt.fields.flow ?? null,
                        });
                    })
                    .catch((error) => {
                        state.log.write({
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
        flush: () => state.log.flush(),
        close: async () => {
            await emulator.close();
            await state.log.flush();
        },
    };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const portArgIndex = process.argv.indexOf('--port');
    const logArgIndex = process.argv.indexOf('--log');
    const port = portArgIndex >= 0 ? Number(process.argv[portArgIndex + 1]) : undefined;
    const logFile = logArgIndex >= 0 ? process.argv[logArgIndex + 1] : undefined;
    const running = await startPerfModelServer({ port, logFile });
    console.log(`TOUCHAI_PERF model server listening on ${running.endpoint}`);
    await new Promise((resolve) => {
        process.once('SIGINT', resolve);
        process.once('SIGTERM', resolve);
    });
    await running.close();
}
