import type {
    AgentCheckpoint,
    AgentHost,
    AgentPersistence,
    AgentPreparedTurn,
    AgentScope,
    AgentTerminal,
    AgentToolOutcome,
} from '@touchai/agent-core/contracts';
import type { AiRequestOptions, AiStreamChunk } from '@touchai/models/contracts';

export function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((accept, fail) => {
        resolve = accept;
        reject = fail;
    });
    return { promise, resolve, reject };
}

export function memoryPersistence() {
    const checkpoints: AgentCheckpoint[] = [];
    const results: AgentToolOutcome[] = [];
    const terminals: AgentTerminal[] = [];
    const attempts: string[] = [];
    const progress: { attempt: string; parts: string[] }[] = [];
    let sequence = 0;
    const persistence: AgentPersistence = {
        start: async (_checkpoint, scope) => ({
            conversationKey: `conversation-${scope.taskId}`,
            turnKey: `turn-${scope.taskId}`,
        }),
        progress: async (parts, target) => {
            progress.push({
                attempt: target.attemptToken,
                parts: parts.map((part) => part.content),
            });
        },
        toolCalls: async () => `message-${++sequence}`,
        toolResult: async (result) => {
            results.push(structuredClone(result));
        },
        toolRoundSource: async () => undefined,
        checkpoint: async (checkpoint) => {
            checkpoints.push(structuredClone(checkpoint));
        },
        retry: async (_failure, scope) => {
            attempts.push(scope.attemptToken);
        },
        finish: async (terminal) => {
            terminals.push(structuredClone(terminal));
        },
        validateSummary: async () => undefined,
        saveSummary: async () => `summary-${++sequence}`,
    };
    return { persistence, checkpoints, results, terminals, attempts, progress };
}

export function fixtureHost(options: {
    stream(request: AiRequestOptions, scope: AgentScope): AsyncIterable<AiStreamChunk>;
    execute?: AgentPreparedTurn['tools']['execute'];
    persistence?: AgentPersistence;
    prepare?: (modelKey: string) => Partial<AgentPreparedTurn>;
}) {
    const requests: AiRequestOptions[] = [];
    const leases: string[] = [];
    const store = memoryPersistence();
    const host: AgentHost = {
        prepareTurn: async (input) => {
            const key = input.modelKey ?? 'model-one';
            const prepared = options.prepare?.(key);
            return {
                model: {
                    key,
                    model: key,
                    connectionKey: `connection-${key}`,
                    contextLimit: null,
                    outputLimit: null,
                    supportsReasoning: false,
                    supportsTools: true,
                },
                messages: [
                    { role: 'system', content: 'fixture system' },
                    { role: 'user', content: input.prompt },
                ],
                tools: {
                    declarations: [
                        {
                            name: 'builtin__read',
                            description: key,
                            input_schema: { type: 'object', properties: {} },
                        },
                    ],
                    execute:
                        options.execute ??
                        (async () => ({
                            result: 'read result',
                            isError: false,
                            sideEffect: 'completed',
                        })),
                },
                stream: async function* (request, scope) {
                    requests.push(
                        structuredClone({
                            ...request,
                            signal: undefined,
                            onTransportResolved: undefined,
                        })
                    );
                    yield* options.stream(request, scope);
                },
                release: async () => {
                    leases.push(key);
                },
                ...prepared,
            };
        },
        persistence: () => options.persistence ?? store.persistence,
    };
    return { host, store, requests, leases };
}

export function* text(content: string) {
    yield { content, done: false };
    yield { content: '', done: true, finishReason: 'stop' };
}

export function* tools(names: string[] = ['builtin__read']) {
    yield { content: 'working', done: false };
    yield {
        content: '',
        done: true,
        finishReason: 'tool_calls',
        toolCalls: names.map((name, index) => ({ id: `call-${index}`, name, arguments: '{}' })),
    };
}
