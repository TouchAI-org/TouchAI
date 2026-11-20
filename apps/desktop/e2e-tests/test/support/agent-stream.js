/**
 * A controllable OpenAI-compatible model used by queue/steer E2E specs.
 *
 * The queue only exists while a real task is running, so a fake DOM snapshot
 * cannot cover it. This emulated provider lets a spec hold a model step open,
 * submit messages through the real editor, then release a tool boundary or
 * finish the turn. Each response plan receives the request that triggered it,
 * which makes both the visible ordering and the actual model delivery order
 * observable.
 *
 * `emulate` provides the HTTP server, streaming body and lifecycle. The plans own
 * only what no rule can express: the moment a frame is written.
 */
import { createEmulator, defineEmulator } from 'emulate';

const REQUEST_TIMEOUT_MS = 15000;
const MODEL_ID = 'touchai-e2e-model';
const encoder = new TextEncoder();

export function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function flattenContent(content) {
    if (typeof content === 'string') {
        return content;
    }
    if (!Array.isArray(content)) {
        return '';
    }
    return content
        .map((part) => {
            if (typeof part === 'string') {
                return part;
            }
            return typeof part?.text === 'string' ? part.text : '';
        })
        .join('');
}

function createCompletionStream(responseIndex) {
    const responseId = `chatcmpl-touchai-e2e-${responseIndex}`;
    const createdAt = Math.floor(Date.now() / 1000);
    let controller;
    let ended = false;

    function write(choices) {
        if (ended || !controller) {
            return;
        }
        try {
            controller.enqueue(
                encoder.encode(
                    `data: ${JSON.stringify({
                        id: responseId,
                        object: 'chat.completion.chunk',
                        created: createdAt,
                        model: MODEL_ID,
                        choices,
                    })}\n\n`
                )
            );
        } catch {
            ended = true;
        }
    }

    const readable = new ReadableStream({
        start(next) {
            controller = next;
            write([{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]);
        },
        cancel() {
            ended = true;
        },
    });

    return {
        readable,
        stream: {
            get ended() {
                return ended;
            },
            text(content) {
                if (!content) {
                    return;
                }
                write([{ index: 0, delta: { content }, finish_reason: null }]);
            },
            toolCall({ id = 'call_touchai_e2e', name, arguments: args }) {
                write([
                    {
                        index: 0,
                        delta: {
                            tool_calls: [
                                {
                                    index: 0,
                                    id,
                                    type: 'function',
                                    function: {
                                        name,
                                        arguments:
                                            typeof args === 'string' ? args : JSON.stringify(args),
                                    },
                                },
                            ],
                        },
                        finish_reason: null,
                    },
                ]);
            },
            disconnect() {
                if (ended || !controller) {
                    return;
                }
                ended = true;
                try {
                    controller.error(new Error('The model connection dropped.'));
                } catch {
                    // The stream already closed on its own.
                }
            },
            finish(reason = 'stop') {
                if (ended || !controller) {
                    return;
                }
                write([{ index: 0, delta: {}, finish_reason: reason }]);
                if (ended) {
                    return;
                }
                ended = true;
                try {
                    controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                    controller.close();
                } catch {
                    // The client already went away.
                }
            },
        },
    };
}

export async function createAgentStreamServer() {
    const plans = [];
    const requests = [];
    let protocolError = null;
    let requestWaiters = [];

    function notifyRequestWaiters() {
        const ready = requestWaiters.filter(({ count }) => requests.length >= count);
        requestWaiters = requestWaiters.filter(({ count }) => requests.length < count);
        for (const waiter of ready) {
            waiter.resolve();
        }
    }

    function recordRequest(requestBody, pathname) {
        const request = {
            index: requests.length,
            pathname,
            body: requestBody,
            receivedAt: Date.now(),
            userTexts: (requestBody.messages ?? [])
                .filter((message) => message?.role === 'user')
                .map((message) => flattenContent(message.content)),
        };
        requests.push(request);
        notifyRequestWaiters();
        return request;
    }

    const definition = defineEmulator({
        name: 'touchai-e2e-model',
        state: () => ({}),
        setup({ app }) {
            app.get('/v1/models', (c) =>
                c.json({
                    object: 'list',
                    data: [
                        {
                            id: MODEL_ID,
                            object: 'model',
                            created: 0,
                            owned_by: 'touchai-e2e',
                        },
                    ],
                })
            );

            app.post('/v1/chat/completions', async (c) => {
                let requestBody;
                try {
                    requestBody = await c.req.json();
                } catch (error) {
                    protocolError = `Could not parse model request: ${String(error)}`;
                    return c.json({ error: { message: protocolError } }, 400);
                }

                const recordedRequest = recordRequest(requestBody, new URL(c.req.url).pathname);
                const plan = plans.shift();

                if (!plan) {
                    protocolError = `No response plan for model request ${recordedRequest.index}.`;
                    return c.json({ error: { message: protocolError } }, 500);
                }

                const { readable, stream } = createCompletionStream(recordedRequest.index + 1);
                Promise.resolve()
                    .then(() => plan({ request: recordedRequest, stream }))
                    .then(() => {
                        if (!stream.ended) {
                            stream.finish('stop');
                        }
                    })
                    .catch((error) => {
                        protocolError = `Response plan ${recordedRequest.index} failed: ${String(error)}`;
                        stream.finish('stop');
                    });

                return c.body(readable, 200, {
                    'content-type': 'text/event-stream; charset=utf-8',
                    'cache-control': 'no-cache',
                });
            });
        },
    });

    const emulator = await createEmulator({ service: definition, port: 0 });
    const endpoint = `http://127.0.0.1:${new URL(emulator.url).port}/v1`;

    return {
        endpoint,
        modelId: MODEL_ID,
        requests,
        get protocolError() {
            return protocolError;
        },
        planNext(plan) {
            plans.push(plan);
        },
        reset() {
            plans.length = 0;
            requests.length = 0;
            protocolError = null;
            for (const waiter of requestWaiters) {
                waiter.reject(new Error('The E2E model server was reset.'));
            }
            requestWaiters = [];
        },
        async waitForRequestCount(count, timeoutMs = REQUEST_TIMEOUT_MS) {
            if (requests.length >= count) {
                return;
            }
            await new Promise((resolve, reject) => {
                const waiter = {
                    count,
                    resolve: () => {
                        clearTimeout(timer);
                        resolve();
                    },
                    reject,
                };
                const timer = setTimeout(() => {
                    requestWaiters = requestWaiters.filter((entry) => entry !== waiter);
                    reject(
                        new Error(
                            `Timed out waiting for model request ${count}. Received ${requests.length}: ${JSON.stringify(
                                requests.map((entry) => entry.userTexts)
                            )}`
                        )
                    );
                }, timeoutMs);
                requestWaiters.push(waiter);
            });
        },
        async close() {
            for (const waiter of requestWaiters) {
                waiter.reject(new Error('The E2E model server was closed.'));
            }
            requestWaiters = [];
            await emulator.close();
        },
    };
}
