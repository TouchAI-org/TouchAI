import {
    closeTestDatabases,
    openMigratedDatabase,
    routeQueriesTo,
} from '@tests/database/sqliteHarness';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ToolModelCapabilities, ToolModelReference, ToolTaskContext } from '@/modules/tools';
import {
    createBuiltinRegistrations,
    createSearchConversationTools,
    createTools,
} from '@/modules/tools';

afterEach(closeTestDatabases);

const currentModel: ToolModelReference = {
    key: 'task-model',
    id: 1,
    provider_id: 1,
    provider_name: 'Provider',
    model_id: 'model-a',
    name: 'Model A',
    supportsImages: false,
};

function fixture() {
    const database = openMigratedDatabase();
    routeQueriesTo(database);
    const listCandidates = vi.fn(async () => [
        {
            id: 1,
            session_id: 'session-1',
            title: 'Searchable session',
            model: 'model-a',
            created_at: '2026-01-01 00:00:00',
            last_message_at: '2026-01-02 00:00:00',
            message_count: 1,
            archived_at: null,
        },
    ]);
    const findMessages = vi.fn(async () => [
        {
            id: 1,
            session_id: 1,
            role: 'user' as const,
            content: 'Searchable content',
        },
    ]);
    const complete = vi.fn<ToolModelCapabilities['complete']>(
        async (_taskId, _model, input) =>
            await new Promise((resolve, reject) => {
                input.signal?.addEventListener(
                    'abort',
                    () => reject(new DOMException('cancelled', 'AbortError')),
                    { once: true }
                );
            })
    );
    const models: ToolModelCapabilities = {
        resolve: async () => null,
        isAvailable: async () => true,
        complete,
    };
    const catalog = createBuiltinRegistrations(
        createSearchConversationTools({
            messages: {
                t: (key) => key,
                tt: (text) => text,
            },
            models,
            history: {
                listCandidates,
                findMessages,
            },
        })
    );
    return { database, catalog, listCandidates, findMessages, complete };
}

function task(signal: AbortSignal): ToolTaskContext {
    return {
        taskId: 'task',
        attemptToken: 'attempt',
        attemptGeneration: 1,
        signal,
        stop: () => undefined,
        historyTarget: { sessionId: 1, messageId: 1 },
        currentModel,
        ask: async () => null,
        present: () => undefined,
    };
}

describe('given the shipped conversation search builtin registration', () => {
    it('user receives a default-enabled descriptor plus low-risk configuration row and explicit recall boundary', async () => {
        const { database, catalog } = fixture();

        await catalog.synchronize();

        const row = database
            .prepare(
                `SELECT display_name, enabled, risk_level, config_json
                 FROM built_in_tools
                 WHERE tool_id = 'search_conversation'`
            )
            .get() as {
            display_name: string;
            enabled: number;
            risk_level: string;
            config_json: string;
        };
        expect(row).toEqual({
            display_name: 'SearchConversation',
            enabled: 1,
            risk_level: 'low',
            config_json: '{"enabled":true}',
        });
        const tools = createTools({
            registrations: catalog.registrations,
            formatError: (code) => code,
        });
        try {
            const declaration = (
                await tools.snapshot({
                    preparation: { taskId: 'task', currentModel },
                })
            ).declarations.find((candidate) => candidate.name === 'builtin__search_conversation');
            expect(declaration?.description).toContain('different words');
            expect(declaration?.description).toContain('only those candidates');
        } finally {
            tools.dispose();
        }
    });

    it('user gets a request-cancelled outcome through the controlled tool pipeline', async () => {
        const { catalog, complete } = fixture();
        await catalog.synchronize();
        const tools = createTools({
            registrations: catalog.registrations,
            formatError: (code) => code,
        });
        try {
            const snapshot = await tools.snapshot({
                preparation: { taskId: 'task', currentModel },
            });
            const controller = new AbortController();
            const running = snapshot.execute(
                {
                    id: 'call',
                    name: 'builtin__search_conversation',
                    arguments: '{"query":"session"}',
                },
                {
                    iteration: 0,
                    signal: controller.signal,
                    task: task(controller.signal),
                }
            );
            await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
            controller.abort(new DOMException('cancelled', 'AbortError'));
            controller.abort(new DOMException('cancelled again', 'AbortError'));

            await expect(running).resolves.toMatchObject({
                result: 'request_cancelled',
                isError: true,
                failureCode: 'request_cancelled',
                sideEffect: 'unknown',
            });
        } finally {
            tools.dispose();
        }
    });

    it('user gets a readable disabled error without a database search or model request', async () => {
        const { database, catalog, listCandidates, findMessages, complete } = fixture();
        await catalog.synchronize();
        database.exec(
            `UPDATE built_in_tools
             SET config_json = '{"enabled":false}'
             WHERE tool_id = 'search_conversation'`
        );
        const tools = createTools({
            registrations: catalog.registrations,
            formatError: (code) => code,
        });
        try {
            const snapshot = await tools.snapshot({
                preparation: { taskId: 'task', currentModel },
            });
            const controller = new AbortController();
            const result = await snapshot.execute(
                {
                    id: 'call',
                    name: 'builtin__search_conversation',
                    arguments: '{"query":"session"}',
                },
                {
                    iteration: 0,
                    signal: controller.signal,
                    task: task(controller.signal),
                }
            );

            expect(result).toMatchObject({
                isError: true,
                status: 'error',
            });
            expect(result.result).toContain('searchConversation.disabled');
            expect(listCandidates).not.toHaveBeenCalled();
            expect(findMessages).not.toHaveBeenCalled();
            expect(complete).not.toHaveBeenCalled();
        } finally {
            tools.dispose();
        }
    });
});
