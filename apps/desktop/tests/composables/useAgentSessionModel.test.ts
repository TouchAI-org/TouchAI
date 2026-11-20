import { createAgentWindowFixture, network, streamingResponse } from '@tests/utils/agentWindow';
import { mountComposable } from '@tests/utils/composables';
import { describe, expect, it } from 'vitest';

import { agentApiKey } from '@/app/api/agent';
import { useAgent } from '@/composables/agent/useAgent';

describe('given a persisted conversation is reopened through the main session API', () => {
    it('user switches back to a running conversation and its queue survives an older history read', async () => {
        const historyRead = Promise.withResolvers<void>();
        let waiting = false;
        const fixture = createAgentWindowFixture('main', undefined, {
            beforeQuery: (request) => {
                if (
                    request.method === 'get' &&
                    request.sql.includes('from "sessions"') &&
                    Number(request.params.at(-1)) === 7
                ) {
                    waiting = true;
                    return historyRead.promise;
                }
            },
        });
        fixture.database
            .exec(`INSERT INTO sessions (id, session_id, title, model, provider_id) VALUES
            (7, 'earlier', 'Earlier conversation', 'fixture-model', 1),
            (8, 'newer', 'Newer conversation', 'fixture-model', 1);`);
        const mounted = await mountComposable(
            () => useAgent(),
            (app) => app.provide(agentApiKey, fixture.window.api)
        );
        const channel = streamingResponse();
        network.replies.push(channel.response);
        try {
            await mounted.result.openSession(8);
            const sending = mounted.result.sendRequest('Keep the newer conversation');
            await expect.poll(() => network.requests.length).toBe(1);
            const queued = mounted.result.enqueueUserMessage(
                { prompt: 'Newer queued prompt' },
                'queue'
            )!;
            const earlierOpen = mounted.result.openSession(7);
            await expect.poll(() => waiting).toBe(true);
            await mounted.result.openSession(8);
            historyRead.resolve();
            await expect(earlierOpen).resolves.toMatchObject({ sessionId: 7 });
            expect(mounted.result.currentSessionId.value).toBe(8);
            expect(mounted.result.pendingUserMessages.value).toMatchObject([
                { id: queued.id, prompt: 'Newer queued prompt' },
            ]);
            expect(mounted.result.sessionHistory.value[0]?.content).toBe(
                'Keep the newer conversation'
            );
            mounted.result.cancel();
            await sending;
        } finally {
            historyRead.resolve();
            channel.finish();
            mounted.unmount();
            await fixture.window.dispose();
        }
    });

    it.each(['clear', 'unmount'] as const)(
        'user leaves through %s and a late history read cannot restore the old conversation',
        async (action) => {
            const historyRead = Promise.withResolvers<void>();
            let waiting = false;
            const fixture = createAgentWindowFixture('main', undefined, {
                beforeQuery: (request) => {
                    if (
                        request.method === 'get' &&
                        request.sql.includes('from "sessions"') &&
                        Number(request.params.at(-1)) === 7
                    ) {
                        waiting = true;
                        return historyRead.promise;
                    }
                },
            });
            fixture.database.exec(`INSERT INTO sessions (id, session_id, title, model, provider_id)
                VALUES (7, 'late-session', 'Late conversation', 'fixture-model', 1);`);
            const mounted = await mountComposable(
                () => useAgent(),
                (app) => app.provide(agentApiKey, fixture.window.api)
            );
            try {
                const opening = mounted.result.openSession(7);
                await expect.poll(() => waiting).toBe(true);
                if (action === 'clear') mounted.result.clearSession();
                else mounted.unmount();
                historyRead.resolve();
                await expect(opening).resolves.toMatchObject({ sessionId: 7 });
                expect(mounted.result.currentSessionId.value).toBeNull();
                expect(mounted.result.pendingUserMessages.value).toEqual([]);
                expect(mounted.result.sessionHistory.value).toEqual([]);
            } finally {
                historyRead.resolve();
                mounted.unmount();
                await fixture.window.dispose();
            }
        }
    );

    it.each([
        { label: 'existing model row', model: 'fixture-model', provider: 1 },
        { label: 'deleted model row', model: 'deleted-model', provider: 1 },
        { label: 'no recorded model', model: null, provider: null },
        { label: 'only a recorded provider', model: null, provider: 1 },
    ])(
        'user retains the recorded selection when reopening a conversation with $label',
        async ({ model, provider }) => {
            const fixture = createAgentWindowFixture('main', undefined, {
                aroundInvoke: async (call, next) => {
                    const result = await next();
                    const request = (call.payload as { request?: { sql?: string } } | undefined)
                        ?.request;
                    // Historical native readers may omit identity; shipped SQLite requires a string.
                    if (
                        model === null &&
                        call.cmd === 'database_query' &&
                        request?.sql?.includes('from "sessions"')
                    ) {
                        const reply = result as { rows: Record<string, unknown>[] };
                        return {
                            ...reply,
                            rows: reply.rows.map((row) => ({ ...row, model: null })),
                        };
                    }
                    return result;
                },
            });
            fixture.database
                .prepare(
                    `INSERT INTO sessions (id, session_id, title, model, provider_id)
            VALUES (7, 'reopened-session', 'Deploy plan', ?, ?)`
                )
                .run(model ?? '', provider);
            const mounted = await mountComposable(
                () => useAgent(),
                (app) => app.provide(agentApiKey, fixture.window.api)
            );
            try {
                expect(await mounted.result.openSession(7)).toEqual({
                    sessionId: 7,
                    title: 'Deploy plan',
                    modelId: model,
                    providerId: provider,
                });
                expect(mounted.result.currentSessionId.value).toBe(7);
                expect(mounted.result.isLoading.value).toBe(false);
            } finally {
                mounted.unmount();
                await fixture.window.dispose();
            }
        }
    );
});
