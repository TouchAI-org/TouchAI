import { createAgentWindowFixture } from '@tests/utils/agentWindow';
import { mountComposable } from '@tests/utils/composables';
import { describe, expect, it } from 'vitest';

import { agentApiKey } from '@/app/api/agent';
import { useAgent } from '@/composables/agent/useAgent';

describe('given a persisted conversation is reopened through the main session API', () => {
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
