import {
    createAgentWindowFixture,
    network,
    response,
    streamingResponse,
} from '@tests/utils/agentWindow';
import { mountComposable } from '@tests/utils/composables';
import { describe, expect, it, vi } from 'vitest';

import { agentApiKey } from '@/app/api/agent';
import { useAgent } from '@/composables/agent/useAgent';

const notifications = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/plugin-notification', () => ({
    sendNotification: notifications,
    isPermissionGranted: async () => true,
    requestPermission: async () => 'granted',
}));

describe('given a conversation uses the real main execution host', () => {
    it('user sees a running request failure in the conversation without a duplicate desktop notification', async () => {
        const fixture = createAgentWindowFixture();
        fixture.database.exec('UPDATE models SET context_limit = 128');
        const mounted = await mountComposable(
            () => useAgent(),
            (app) => app.provide(agentApiKey, fixture.window.api)
        );
        try {
            await mounted.result.sendRequest('too large for the fixture context');
            expect(mounted.result.error.value?.message).toBeTruthy();
            expect(mounted.result.isLoading.value).toBe(false);
            expect(notifications).not.toHaveBeenCalled();
            expect(network.requests).toEqual([]);
        } finally {
            mounted.unmount();
            await fixture.window.dispose();
        }
    });

    it('user is notified when a closed main host cannot start a request', async () => {
        const fixture = createAgentWindowFixture();
        await fixture.window.dispose();
        const mounted = await mountComposable(
            () => useAgent(),
            (app) => app.provide(agentApiKey, fixture.window.api)
        );
        try {
            await mounted.result.sendRequest('hello');
            expect(mounted.result.error.value?.message).toContain('AGENT_DISPOSED');
            expect(notifications).toHaveBeenCalledWith(
                expect.objectContaining({ body: expect.stringContaining('AGENT_DISPOSED') })
            );
            expect(network.requests).toEqual([]);
        } finally {
            mounted.unmount();
        }
    });

    it.each(['clearSession', 'cancel'] as const)(
        'user leaves no running task when choosing %s during history startup',
        async (dropRequest) => {
            let paused = false;
            let waiting = false;
            let release!: () => void;
            const barrier = new Promise<void>((resolve) => {
                release = resolve;
            });
            const fixture = createAgentWindowFixture('main', undefined, {
                beforeQuery: ({ sql }) => {
                    if (paused && sql.includes('from "sessions"')) {
                        waiting = true;
                        return barrier;
                    }
                },
            });
            fixture.database.exec(`INSERT INTO sessions (id, session_id, title, model, provider_id)
            VALUES (7, 'startup-session', 'Previous request', 'fixture-model', 1);`);
            const mounted = await mountComposable(
                () => useAgent(),
                (app) => app.provide(agentApiKey, fixture.window.api)
            );
            try {
                await mounted.result.openSession(7);
                paused = true;
                const sending = mounted.result.sendRequest('cancel while reading history');
                await expect.poll(() => waiting).toBe(true);
                mounted.result[dropRequest]();
                expect(mounted.result.isLoading.value).toBe(false);
                paused = false;
                release();
                await sending;
                expect(fixture.window.api.listActiveTasks()).toEqual([]);
                expect(network.requests).toEqual([]);
                expect(
                    fixture.database.prepare('SELECT count(*) AS count FROM session_turns').get()
                ).toEqual({ count: 0 });
            } finally {
                paused = false;
                release();
                mounted.unmount();
                await fixture.window.dispose();
            }
        }
    );

    it('user reopens an active conversation with its upgraded model still selected', async () => {
        const fixture = createAgentWindowFixture();
        await fixture.window.ready;
        await fixture.window.capabilities.waitForAgent();
        fixture.database
            .exec(`INSERT INTO models (id, provider_id, name, model_id, tool_call, context_limit, output_limit)
            VALUES (2, 1, 'Upgraded fixture', 'upgraded-fixture', 1, 262144, 1024);
            UPDATE built_in_tools SET config_json = '{"chain":[{"providerId":1,"modelId":"fixture-model"},{"providerId":1,"modelId":"upgraded-fixture"}]}'
            WHERE tool_id = 'upgrade_model';`);
        const channel = streamingResponse();
        network.replies.push(
            response('', false, { name: 'builtin__upgrade_model', arguments: '{}' }),
            channel.response
        );
        const selected: unknown[] = [];
        const mounted = await mountComposable(
            () => useAgent({ onModelSelected: (target) => selected.push(target) }),
            (app) => app.provide(agentApiKey, fixture.window.api)
        );
        try {
            const started = await fixture.window.api.startTask({ prompt: 'upgrade this request' });
            await expect
                .poll(() => fixture.window.api.getTaskSnapshot(started.taskId)?.pendingToolApproval)
                .toBeTruthy();
            const decision = fixture.window.api.getTaskSnapshot(
                started.taskId
            )!.pendingToolApproval!;
            fixture.window.api.approveTaskToolCall(
                started.taskId,
                decision.callId,
                decision.decisionId
            );
            await expect
                .poll(() => fixture.window.api.getTaskSnapshot(started.taskId)?.modelSwitchCount)
                .toBe(1);
            const sessionId = fixture.window.api.getTaskSnapshot(started.taskId)!.sessionId!;
            expect(await mounted.result.openSession(sessionId)).toMatchObject({
                modelId: 'upgraded-fixture',
                providerId: 1,
            });
            expect(selected).toContainEqual({ modelId: 'upgraded-fixture', providerId: 1 });
            channel.delta({ content: 'upgraded answer' });
            channel.finish();
            await started.completion;
        } finally {
            channel.finish();
            mounted.unmount();
            await fixture.window.dispose();
        }
    });

    it('user cannot answer a decision when no task is attached to the conversation', async () => {
        const fixture = createAgentWindowFixture();
        const mounted = await mountComposable(
            () => useAgent(),
            (app) => app.provide(agentApiKey, fixture.window.api)
        );
        try {
            expect(mounted.result.approvePendingToolApproval('call-1')).toBe(false);
            expect(mounted.result.rejectPendingToolApproval('call-1')).toBe(false);
            expect(mounted.result.settleUserQuestion('call-1', null)).toBe(false);
            expect(fixture.window.api.listActiveTasks()).toEqual([]);
        } finally {
            mounted.unmount();
            await fixture.window.dispose();
        }
    });
});
