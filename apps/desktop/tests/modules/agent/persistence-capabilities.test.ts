import {
    closeTestDatabases,
    openMigratedDatabase,
    routeQueriesTo,
} from '@tests/database/sqliteHarness';
import { deferred } from '@tests/utils/productAnalytics';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAgentMessageAdapter } from '@/adapters/agent/messages';
import { createPendingMessageDelivery } from '@/app/workflows/agent/pending';
import type { PersistenceCheckpoint } from '@/modules/agent';
import { PersistenceProjector } from '@/modules/agent';
import type { PendingUserMessage } from '@/modules/agent/contracts';
import type { PersistenceProjectorHost } from '@/modules/agent/contracts/persistence';

afterEach(closeTestDatabases);

function fixture(
    overrides: Partial<PersistenceProjectorHost> = {},
    queries: Parameters<typeof routeQueriesTo>[1] = {}
) {
    const database = openMigratedDatabase();
    routeQueriesTo(database, queries);
    database.exec(`INSERT INTO providers (id, name, driver, api_endpoint, logo)
        VALUES (1, 'Fixture', 'openai', 'https://fixture.invalid', 'openai');
        INSERT INTO models (id, provider_id, name, model_id) VALUES (1, 1, 'Fixture', 'fixture-model');
        INSERT INTO sessions (id, session_id, title, model, provider_id)
        VALUES (1, 'fixture-session', 'Fixture', 'fixture-model', 1);`);
    const promptJson = '{"id":"fixture-prompt","fragments":[],"systemPrompt":"saved instruction"}';
    const manifestJson = '{"version":1,"requests":[]}';
    const host: PersistenceProjectorHost = {
        prepareAttachments: async () => {},
        persistAttachment: async (attachment, store) =>
            (await store.findByHash('fixture-hash')) ??
            store.create({
                hash: 'fixture-hash',
                type: attachment.type,
                original_name: attachment.name,
                origin_path: attachment.originPath,
                mime_type: attachment.mimeType ?? null,
                size: attachment.size ?? null,
            }),
        emptyManifest: () => manifestJson,
        appendManifest: (_current, request) => `{"version":1,"requests":[${request}]}`,
        promptBreakdown: async () => null,
        resolveUsage: async () => ({
            usage: {
                inputTokens: 10,
                outputTokens: 2,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                reasoningTokens: 0,
            },
            costMicros: 12,
            unpricedCalls: 0,
            parts: [{ data: '{"turnId":1,"costMicros":12}', durationMs: 100, ttftMs: 20 }],
        }),
        diagnostics: { error: () => {}, warn: () => {} },
        ...overrides,
    };
    const projector = new PersistenceProjector({
        sessionId: 1,
        model: { id: 1, provider_id: 1, model_id: 'fixture-model' },
        taskId: 'fixture-task',
        prompt: 'authorized request',
        executionMode: 'foreground',
        maxRetries: 5,
        buildSessionTitle: (prompt) => prompt,
        promptSnapshotJson: promptJson,
        host,
        attachments: [
            {
                id: 'fixture',
                type: 'file',
                name: 'fixture.txt',
                path: '/fixture/unread',
                originPath: '/fixture/unread',
                mimeType: 'text/plain',
                size: 1,
            },
        ],
    });
    const checkpoint: PersistenceCheckpoint = {
        activeModel: { id: 1 },
        messages: [{ role: 'user' }],
        response: '',
        reasoning: '',
        outputParts: [],
        iteration: 0,
        modelSwitchCount: 0,
        executedBuiltInToolIds: [],
        modelLanguageContext: { locale: 'en-US', label: 'English' },
    };
    return { database, projector, checkpoint, promptJson, manifestJson };
}

describe('given agent persistence receives narrow attachment and consumption capabilities', () => {
    it('user retains the supplied snapshot and delivery bytes while staged resources join the start transaction', async () => {
        const { database, projector, checkpoint, promptJson, manifestJson } = fixture();
        await projector.recordTurnStart(checkpoint);
        expect(database.prepare('SELECT prompt_snapshot_json FROM session_turns').get()).toEqual({
            prompt_snapshot_json: promptJson,
        });
        expect(
            database.prepare('SELECT delivery_manifest_json FROM session_turn_attempts').get()
        ).toEqual({ delivery_manifest_json: manifestJson });
        expect(database.prepare('SELECT hash, origin_path FROM attachments').get()).toEqual({
            hash: 'fixture-hash',
            origin_path: '/fixture/unread',
        });
        expect(
            database
                .prepare("SELECT count(*) AS count FROM message_parts WHERE type = 'attachment'")
                .get()
        ).toEqual({ count: 1 });
        expect(checkpoint.messages[0]?.contextSource?.id).toBeGreaterThan(0);
    });

    it('user retains no staged attachment or history when the same start transaction fails', async () => {
        const { database, projector, checkpoint } = fixture();
        database.exec(`CREATE TEMP TRIGGER reject_start BEFORE INSERT ON session_turn_attempts
            BEGIN SELECT RAISE(ABORT, 'fixture start failure'); END;`);
        await expect(projector.recordTurnStart(checkpoint)).rejects.toThrow();
        expect(database.prepare('SELECT count(*) AS count FROM attachments').get()).toEqual({
            count: 0,
        });
        expect(database.prepare('SELECT count(*) AS count FROM messages').get()).toEqual({
            count: 0,
        });
        expect(projector.getTurn()).toBeNull();
        database.exec('DROP TRIGGER reject_start');
        await projector.recordTurnStart(checkpoint);
        expect(database.prepare('SELECT count(*) AS count FROM attachments').get()).toEqual({
            count: 1,
        });
    });

    it('user keeps consumption parts and aggregates inside a rejected terminal transaction', async () => {
        const { database, projector, checkpoint } = fixture();
        await projector.recordTurnStart(checkpoint);
        const calls = [
            {
                iteration: 0,
                modelId: 1,
                modelName: 'fixture-model',
                providerId: 1,
                providerName: 'Fixture',
                usage: {
                    inputTokens: 10,
                    outputTokens: 2,
                    cacheReadTokens: 0,
                    cacheWriteTokens: 0,
                    reasoningTokens: 0,
                },
                timing: { durationMs: 100 },
                toolCallsInStep: 0,
                toolArgumentErrors: 0,
            },
        ];
        database.exec(`CREATE TEMP TRIGGER reject_finish BEFORE UPDATE ON session_turns
            WHEN NEW.status = 'completed' BEGIN SELECT RAISE(ABORT, 'fixture finish failure'); END;`);
        await expect(
            projector.markCompleted({
                outputParts: [{ type: 'text', content: 'answer' }],
                durationMs: 1,
                calls,
            })
        ).rejects.toThrow();
        expect(
            database
                .prepare("SELECT count(*) AS count FROM message_parts WHERE type = 'llm_call'")
                .get()
        ).toEqual({ count: 0 });
        expect(
            database.prepare('SELECT total_cost_micros FROM session_turn_attempts').get()
        ).toEqual({ total_cost_micros: 0 });
        database.exec('DROP TRIGGER reject_finish');
        await projector.markCompleted({
            outputParts: [{ type: 'text', content: 'answer' }],
            durationMs: 1,
            calls,
        });
        expect(
            database.prepare("SELECT data FROM message_parts WHERE type = 'llm_call'").get()
        ).toEqual({ data: '{"turnId":1,"costMicros":12}' });
        expect(
            database.prepare('SELECT total_cost_micros FROM session_turn_attempts').get()
        ).toEqual({ total_cost_micros: 12 });
    });
});

describe('user changes pending delivery before its transaction starts', () => {
    it.each([
        ['clear', 'attachment preparation'],
        ['cancel', 'attachment preparation'],
        ['clear', 'transaction admission'],
        ['cancel', 'transaction admission'],
    ] as const)(
        'user requests %s during %s then no pending input enters history or Core',
        async (action, stage) => {
            const entered = deferred<void>();
            const release = deferred<void>();
            let started = false;
            const { database, projector, checkpoint } = fixture(
                {
                    async prepareAttachments() {
                        if (!started || stage !== 'attachment preparation') return;
                        entered.resolve();
                        await release.promise;
                    },
                },
                {
                    async aroundInvoke(call, next) {
                        if (
                            started &&
                            stage === 'transaction admission' &&
                            call.cmd === 'database_tx_begin'
                        ) {
                            entered.resolve();
                            await release.promise;
                        }
                        return next();
                    },
                }
            );
            await projector.recordTurnStart(checkpoint);
            started = true;
            const pending: PendingUserMessage = {
                id: 'prepared-pending',
                prompt: 'Still preparing',
                delivery: 'priority',
                createdAt: 1,
                attachments: [
                    {
                        id: 'new-file',
                        type: 'file',
                        name: 'new.pdf',
                        path: '/new.pdf',
                        originPath: '/new.pdf',
                        mimeType: 'application/pdf',
                    },
                ],
            };
            database
                .prepare(
                    `INSERT INTO session_pending_messages
                (id, session_id, prompt, payload_version, payload_json, position)
                VALUES (?, 1, ?, 1, '{"attachments":[]}', 0)`
                )
                .run(pending.id, pending.prompt);
            let current = true;
            const delivered = vi.fn();
            const rejected = vi.fn();
            const delivery = createPendingMessageDelivery({
                projector,
                adapter: createAgentMessageAdapter(),
                capabilities: { supportsFiles: true, supportsImages: true },
                diagnostics: { error: vi.fn() },
                queue: {
                    claimPriority: () => [pending],
                    releasePriority: vi.fn(),
                    isClaimCurrent: () => current,
                    hasImmediate: () => true,
                    flush: async () => {},
                    delivered,
                    rejected,
                },
            });
            const controller = new AbortController();
            const result = delivery.deliver({
                taskId: 'fixture-task',
                attemptToken: 'attempt',
                attemptGeneration: 1,
                iteration: 0,
                signal: controller.signal,
            });
            await entered.promise;
            const outcome = result.catch((error: unknown) => error);
            if (action === 'cancel') controller.abort();
            else {
                current = false;
                database
                    .prepare('DELETE FROM session_pending_messages WHERE id = ?')
                    .run(pending.id);
            }
            release.resolve();
            if (action === 'cancel') expect(await outcome).toMatchObject({ name: 'AbortError' });
            else expect(await outcome).toEqual({ messages: [] });
            expect(delivered).not.toHaveBeenCalled();
            expect(rejected).not.toHaveBeenCalled();
            expect(
                database
                    .prepare('SELECT id FROM message_parts WHERE content = ?')
                    .all(pending.prompt)
            ).toEqual([]);
            expect(database.prepare('SELECT id FROM session_pending_messages').all()).toEqual(
                action === 'cancel' ? [{ id: pending.id }] : []
            );
        }
    );
});
