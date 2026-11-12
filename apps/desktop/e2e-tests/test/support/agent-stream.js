/**
 * A controllable OpenAI-compatible model used by queue/steer E2E specs.
 *
 * The queue only exists while a real task is running, so a fake DOM snapshot
 * cannot cover it. This server lets a spec hold a model step open, submit
 * messages through the real editor, then release a tool boundary or finish the
 * turn. Each response plan receives the request that triggered it, which makes
 * both the visible ordering and the actual model delivery order observable.
 */
import http from 'node:http';

const REQUEST_TIMEOUT_MS = 15000;
const MODEL_ID = 'touchai-e2e-model';

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

function readRequestBody(request) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        request.on('data', (chunk) => chunks.push(chunk));
        request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        request.on('error', reject);
    });
}

function createCompletionStream(response, responseIndex) {
    let started = false;
    let ended = false;
    const responseId = `chatcmpl-touchai-e2e-${responseIndex}`;
    const createdAt = Math.floor(Date.now() / 1000);
    const canWrite = () => !ended && !response.destroyed && !response.writableEnded;

    response.on('close', () => {
        ended = true;
    });

    function writeChunk(choices) {
        if (!canWrite()) {
            return;
        }
        response.write(
            `data: ${JSON.stringify({
                id: responseId,
                object: 'chat.completion.chunk',
                created: createdAt,
                model: MODEL_ID,
                choices,
            })}\n\n`
        );
    }

    function ensureStarted() {
        if (started || !canWrite()) {
            return;
        }
        started = true;
        writeChunk([{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]);
    }

    return {
        get ended() {
            return ended || response.destroyed || response.writableEnded;
        },
        text(content) {
            if (!content) {
                return;
            }
            ensureStarted();
            writeChunk([{ index: 0, delta: { content }, finish_reason: null }]);
        },
        toolCall({ id = 'call_touchai_e2e', name, arguments: args }) {
            ensureStarted();
            writeChunk([
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
        finish(reason = 'stop') {
            if (ended || response.destroyed || response.writableEnded) {
                return;
            }
            ensureStarted();
            writeChunk([{ index: 0, delta: {}, finish_reason: reason }]);
            if (canWrite()) {
                response.write('data: [DONE]\n\n');
                response.end();
            }
            ended = true;
        },
    };
}

export async function createAgentStreamServer() {
    const plans = [];
    const requests = [];
    let protocolError = null;
    let requestWaiters = [];
    let server;

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

    async function handleRequest(request, response) {
        const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

        if (url.pathname.endsWith('/models')) {
            response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            response.end(
                JSON.stringify({
                    object: 'list',
                    data: [
                        {
                            id: MODEL_ID,
                            object: 'model',
                            created: Math.floor(Date.now() / 1000),
                            owned_by: 'touchai-e2e',
                        },
                    ],
                })
            );
            return;
        }

        if (!url.pathname.endsWith('/chat/completions')) {
            response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
            response.end(
                JSON.stringify({ error: { message: `Unexpected path: ${url.pathname}` } })
            );
            return;
        }

        let requestBody;
        try {
            requestBody = JSON.parse(await readRequestBody(request));
        } catch (error) {
            protocolError = `Could not parse model request: ${String(error)}`;
            response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
            response.end(JSON.stringify({ error: { message: protocolError } }));
            return;
        }

        const recordedRequest = recordRequest(requestBody, url.pathname);
        const plan = plans.shift();

        if (!plan) {
            protocolError = `No response plan for model request ${recordedRequest.index}.`;
            response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
            response.end(JSON.stringify({ error: { message: protocolError } }));
            return;
        }

        response.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
        });
        response.flushHeaders();

        const stream = createCompletionStream(response, recordedRequest.index + 1);
        try {
            await plan({ request: recordedRequest, stream });
            if (!stream.ended) {
                stream.finish('stop');
            }
        } catch (error) {
            protocolError = `Response plan ${recordedRequest.index} failed: ${String(error)}`;
            stream.finish('stop');
            response.destroy();
        }
    }

    server = http.createServer((request, response) => {
        void handleRequest(request, response);
    });

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            resolve();
        });
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
        throw new Error('The E2E model server did not report a TCP port.');
    }

    return {
        endpoint: `http://127.0.0.1:${address.port}/v1`,
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
            server.closeAllConnections?.();
            await new Promise((resolve) => server.close(resolve));
        },
    };
}
