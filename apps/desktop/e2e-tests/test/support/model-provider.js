import { createServer } from 'node:http';

/** A real HTTP boundary; only the remote model is scripted. */
export async function createModelProvider() {
    const handlers = new Map();
    const requests = [];
    const pending = new Set();
    const errors = [];
    const server = createServer(async (request, response) => {
        try {
            if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) {
                response.writeHead(404).end();
                return;
            }
            let input = '';
            for await (const chunk of request) {
                input += chunk;
                if (input.length > 2_000_000) throw new Error('Model fixture request too large');
            }
            const body = JSON.parse(input);
            const prompt = [...(body.messages ?? [])]
                .reverse()
                .find((message) => message.role === 'user')?.content;
            const entry = { body, authorization: request.headers.authorization, path: request.url };
            requests.push(entry);
            if (requests.length > 100) throw new Error('Unexpected model request loop');
            const handler = handlers.get(prompt);
            if (!handler) {
                throw new Error(
                    `No model response registered for prompt ${JSON.stringify(prompt)}`
                );
            }
            let begun = false;
            const delta = (value, reason = null) => {
                if (!begun) {
                    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
                    begun = true;
                }
                response.write(
                    `data: ${JSON.stringify({
                        id: 'touchai-e2e-response',
                        object: 'chat.completion.chunk',
                        created: 1,
                        model: body.model,
                        choices: [{ index: 0, delta: value, finish_reason: reason }],
                    })}\n\n`
                );
            };
            const end = (reason = 'stop') => {
                delta({}, reason);
                response.end('data: [DONE]\n\n');
                pending.delete(response);
            };
            pending.add(response);
            response.on('close', () => pending.delete(response));
            await handler({
                ...entry,
                respond: {
                    delta,
                    end,
                    text(text) {
                        delta({ role: 'assistant', content: text });
                        end();
                    },
                    tool({ name, args, id = 'e2e-tool-call' }) {
                        delta({
                            role: 'assistant',
                            tool_calls: [
                                {
                                    index: 0,
                                    id,
                                    type: 'function',
                                    function: { name, arguments: JSON.stringify(args) },
                                },
                            ],
                        });
                        end('tool_calls');
                    },
                    fail(status, message) {
                        response.writeHead(status, { 'Content-Type': 'application/json' });
                        response.end(JSON.stringify({ error: { message, type: 'fixture_error' } }));
                        pending.delete(response);
                    },
                },
            });
        } catch (error) {
            errors.push(error);
            if (!response.headersSent) response.writeHead(500);
            response.end('Unexpected fixture request');
        }
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    return {
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        requests,
        errors,
        when(prompt, handler) {
            handlers.set(prompt, handler);
        },
        respond(prompt, { tool, answer }) {
            handlers.set(prompt, ({ body, respond }) => {
                const lastUser = body.messages.findLastIndex((message) => message.role === 'user');
                const hasResult = body.messages
                    .slice(lastUser + 1)
                    .some((message) => message.role === 'tool');
                if (tool && !hasResult) respond.tool(tool);
                else respond.text(answer);
            });
        },
        async close() {
            for (const response of pending) response.destroy();
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
        },
    };
}
