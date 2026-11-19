import { mockWindows } from '@tauri-apps/api/mocks';
import {
    createAgentWindowFixture,
    network,
    response,
    streamingResponse,
} from '@tests/utils/agentWindow';
import { getTauriInvokeCalls, mockTauriCommand } from '@tests/utils/tauri';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initializeAgentWindow } from '@/app/bootstrap/agent';

let fixture: ReturnType<typeof createAgentWindowFixture>;
let aggregate: PropertyDescriptor | undefined;
beforeEach(async () => {
    aggregate = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
    Object.defineProperty(AbortSignal, 'any', { configurable: true, value: undefined });
    fixture = createAgentWindowFixture();
    await fixture.window.ready;
    await fixture.window.capabilities.waitForAgent();
});
afterEach(async () => {
    await fixture.window.dispose();
    if (aggregate) Object.defineProperty(AbortSignal, 'any', aggregate);
    else Reflect.deleteProperty(AbortSignal, 'any');
});

describe('given the production browser has no built-in signal aggregation', () => {
    it('user answers a live question and receives a committed answer through the actual model and tools', async () => {
        network.replies.push(response('', true), response('a compatible answer'));
        const task = await fixture.window.api.startTask({
            prompt: 'answer in the supported browser',
        });
        await expect
            .poll(() => fixture.window.api.getTaskSnapshot(task.taskId)?.pendingUserQuestion)
            .toBeTruthy();
        const question = fixture.window.api.getTaskSnapshot(task.taskId)!.pendingUserQuestion!;
        expect(
            fixture.window.api.settleTaskUserQuestion(
                task.taskId,
                question.callId,
                [{ questionIndex: 0, selectedLabels: ['Left'], skipped: false }],
                question.decisionId
            )
        ).toBe(true);
        expect((await task.completion).response).toBe('a compatible answer');
        expect(fixture.database.prepare('SELECT status FROM session_turns').get()).toEqual({
            status: 'completed',
        });
    });

    it('user cancels a running provider wait and no late chunk or following request is admitted', async () => {
        const channel = streamingResponse();
        network.replies.push(channel.response);
        try {
            const task = await fixture.window.api.startTask({
                prompt: 'cancel the compatible stream',
            });
            await expect.poll(() => network.requests).toHaveLength(1);
            const cancelled = expect(task.completion).rejects.toMatchObject({
                code: 'REQUEST_CANCELLED',
            });
            expect(fixture.window.api.cancelTask(task.taskId)).toBe(true);
            await cancelled;
            channel.delta({ content: 'late untrusted output' });
            channel.finish();
            expect(fixture.window.api.getTaskSnapshot(task.taskId)?.status).toBe('cancelled');
            expect(JSON.stringify(fixture.window.api.getTaskSnapshot(task.taskId))).not.toContain(
                'late untrusted output'
            );
            expect(network.requests).toHaveLength(1);
        } finally {
            channel.fail(new Error('fixture stream closed'));
        }
    });

    it('user aborts the caller after admission and can run the next task without cancelling main', async () => {
        const caller = new AbortController();
        const channel = streamingResponse();
        network.replies.push(channel.response);
        try {
            const task = await fixture.window.api.startTask({
                prompt: 'cancel only this caller',
                signal: caller.signal,
            });
            await expect.poll(() => network.requests).toHaveLength(1);
            const cancelled = expect(task.completion).rejects.toMatchObject({
                code: 'REQUEST_CANCELLED',
            });
            caller.abort();
            await cancelled;
            expect(fixture.window.api.getTaskSnapshot(task.taskId)?.status).toBe('cancelled');
            network.replies.push(response('main is still ready'));
            expect(
                (
                    await (
                        await fixture.window.api.startTask({ prompt: 'another request' })
                    ).completion
                ).response
            ).toBe('main is still ready');
        } finally {
            channel.fail(new Error('fixture stream closed'));
        }
    });

    it('user connects a saved MCP server through the same main owner without a secondary registry', async () => {
        fixture.database.exec(`INSERT INTO mcp_servers (id, name, transport_type, url, enabled)
            VALUES (4, 'Documents', 'http', 'https://fixture.invalid/mcp', 1);`);
        mockTauriCommand('mcp_get_client_status', { server_id: 4, status: 'connected' });
        mockTauriCommand('mcp_list_tools', [
            { name: 'read_document', input_schema: { type: 'object', properties: {} } },
        ]);
        await fixture.window.mcp.connectServer(4);
        network.replies.push(response('catalog retained'));
        await (
            await fixture.window.api.startTask({ prompt: 'use the MCP catalog' })
        ).completion;
        expect(JSON.stringify(network.requests[0]?.tools)).toContain('mcp__4__read_document');
        expect(getTauriInvokeCalls('mcp_connect_server')).toHaveLength(1);
    });

    it('user refreshes discovery and metadata from settings through main and remains unable to execute there', async () => {
        mockWindows('settings');
        const client = initializeAgentWindow();
        try {
            network.replies.push(Response.json({ data: [{ id: 'remote-model' }] }));
            expect(await client.models.listModels(1)).toContainEqual(
                expect.objectContaining({ id: 'remote-model' })
            );
            network.replies.push(
                Response.json({
                    models: {
                        'fixture/model': {
                            id: 'fixture-model',
                            name: 'Fixture',
                            limit: { context: 32768, output: 1024 },
                            tool_call: true,
                        },
                    },
                    alias: { 'fixture-model': 'fixture/model' },
                })
            );
            expect(await client.metadata.refresh({ force: true })).toEqual({ status: 'updated' });
            expect(
                fixture.database.prepare('SELECT context_limit FROM models WHERE id = 1').get()
            ).toEqual({ context_limit: 32768 });
            await expect(
                client.api.startTask({ prompt: 'no secondary execution' })
            ).rejects.toMatchObject({ code: 'MAIN_EXECUTION_HOST_REQUIRED' });
            expect(network.requests).toEqual([]);
        } finally {
            await client.dispose();
        }
    });
});
