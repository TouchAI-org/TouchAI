import { clearMocks, mockWindows } from '@tauri-apps/api/mocks';
import {
    closeTestDatabases,
    openMigratedDatabase,
    routeQueriesTo,
} from '@tests/database/sqliteHarness';
import { mockTauriCommand } from '@tests/utils/tauri';
import { afterEach, vi } from 'vitest';

import { initializeAgentWindow } from '@/app/bootstrap/agent';
import type { StartupCapabilities } from '@/app/bootstrap/capabilities';

const boundaryNetwork = vi.hoisted(() => ({
    replies: [] as Response[],
    requests: [] as Record<string, unknown>[],
    discovery: [] as { url: string; headers: Headers; signal: AbortSignal | null | undefined }[],
    respondToGeneration: undefined as
        | ((url: string, init: RequestInit) => Promise<Response>)
        | undefined,
    respondToDiscovery: undefined as
        | ((signal: AbortSignal | null | undefined) => Promise<Response>)
        | undefined,
}));
export const network = boundaryNetwork;
vi.mock('@tauri-apps/plugin-http', () => ({
    fetch: async (url: string, init: RequestInit) => {
        if (init.method === 'GET') {
            network.discovery.push({
                url,
                headers: new Headers(init.headers),
                signal: init.signal,
            });
            if (network.respondToDiscovery) return network.respondToDiscovery(init.signal);
        } else {
            network.requests.push(JSON.parse(String(init.body)));
            if (network.respondToGeneration) return network.respondToGeneration(url, init);
        }
        const reply = network.replies.shift();
        if (!reply) throw new Error('unexpected fixture network request');
        return reply;
    },
}));

afterEach(() => {
    closeTestDatabases();
    clearMocks();
    network.replies.length = 0;
    network.requests.length = 0;
    network.discovery.length = 0;
    window.location.hash = '';
    network.respondToDiscovery = undefined;
    network.respondToGeneration = undefined;
    vi.useRealTimers();
});

export function responseFromDeltas(
    deltas: Record<string, unknown>[],
    finishReason = 'stop',
    usage: Record<string, number> = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
): Response {
    const common = { id: 'production-fixture', model: 'fixture-model', created: 1 };
    return new Response(
        [
            ...deltas.map(
                (delta) =>
                    `data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta, finish_reason: null }] })}`
            ),
            `data: ${JSON.stringify({
                ...common,
                choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
                usage,
            })}`,
            'data: [DONE]',
        ].join('\n\n') + '\n\n',
        { headers: { 'content-type': 'text/event-stream' } }
    );
}

export function streamingResponse() {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let closed = false;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
        start(value) {
            controller = value;
        },
    });
    const send = (delta: Record<string, unknown>, finishReason: string | null) => {
        controller.enqueue(
            encoder.encode(
                `data: ${JSON.stringify({
                    id: 'streaming-fixture',
                    model: 'fixture-model',
                    created: 1,
                    choices: [{ index: 0, delta, finish_reason: finishReason }],
                    ...(finishReason === null
                        ? {}
                        : { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
                })}\n\n`
            )
        );
    };
    return {
        response: new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
        delta(value: Record<string, unknown>) {
            send(value, null);
        },
        finish(reason = 'stop') {
            if (closed) return;
            send({}, reason);
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            closed = true;
            controller.close();
        },
        fail(error: Error) {
            if (closed) return;
            closed = true;
            controller.error(error);
        },
    };
}

export function toolResponse(calls: { id: string; name: string; arguments: string }[]): Response {
    return responseFromDeltas(
        [
            {
                role: 'assistant',
                tool_calls: calls.map((call, index) => ({
                    index,
                    id: call.id,
                    type: 'function',
                    function: { name: call.name, arguments: call.arguments },
                })),
            },
        ],
        'tool_calls'
    );
}

export function response(
    content: string,
    question = false,
    tool?: { name: string; arguments: string }
): Response {
    const delta =
        question || tool
            ? {
                  role: 'assistant',
                  tool_calls: [
                      {
                          index: 0,
                          id: 'production-question',
                          type: 'function',
                          function: tool ?? {
                              name: 'builtin__ask_user_question',
                              arguments: JSON.stringify({
                                  questions: [
                                      {
                                          question: 'Choose a direction',
                                          header: 'Direction',
                                          options: [{ label: 'Left' }, { label: 'Right' }],
                                      },
                                  ],
                              }),
                          },
                      },
                  ],
              }
            : { role: 'assistant', content };
    return responseFromDeltas([delta], question || tool ? 'tool_calls' : 'stop');
}

export function createAgentWindowFixture(
    label = 'main',
    capabilities?: StartupCapabilities,
    queryOptions: Parameters<typeof routeQueriesTo>[1] = {}
) {
    mockWindows(label);
    const database = openMigratedDatabase();
    routeQueriesTo(database, queryOptions);
    mockTauriCommand('mcp_get_all_client_statuses', []);
    mockTauriCommand('computer_use_list_tools', []);
    mockTauriCommand('agent_skills_discover_system_files', []);
    mockTauriCommand('agent_skills_discover_user_files', []);
    database.exec(`INSERT INTO providers (id, name, driver, api_endpoint, api_key, logo)
        VALUES (1, 'Fixture', 'openai-compatible', 'https://fixture.invalid/v1', 'fixture-secret', 'openai');
        INSERT INTO models (id, provider_id, name, model_id, is_default, tool_call, context_limit, output_limit)
        VALUES (1, 1, 'Fixture', 'fixture-model', 1, 1, 262144, 1024);`);
    return { database, window: initializeAgentWindow({ capabilities }) };
}
