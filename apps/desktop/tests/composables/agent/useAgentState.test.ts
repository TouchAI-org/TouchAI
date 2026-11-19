import {
    createAgentWindowFixture,
    network,
    response,
    toolResponse,
} from '@tests/utils/agentWindow';
import { mountComposable } from '@tests/utils/composables';
import { emitTauriChannelMessage, mockTauriCommand } from '@tests/utils/tauri';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { agentApiKey } from '@/app/api/agent';
import { selectToolCalls } from '@/app/api/agent/history';
import { useAgentState } from '@/composables/agent/useAgentState';

const shellChannel = z.object({
    request: z.object({
        executionId: z.string(),
        command: z.string(),
        workingDirectory: z.string(),
    }),
    events: z.unknown(),
});

describe('given a main-owned task streams native shell output', () => {
    it('user sees running output in the conversation and unmounting leaves the task able to commit', async () => {
        const fixture = createAgentWindowFixture();
        let channel: z.infer<typeof shellChannel> | undefined;
        let index = 0;
        mockTauriCommand('built_in_tools_start_bash', (payload) => {
            channel = shellChannel.parse(payload);
            return true;
        });
        network.replies.push(
            toolResponse([
                {
                    id: 'live-shell',
                    name: 'builtin__bash',
                    arguments: JSON.stringify({
                        command: 'Write-Output alpha',
                        reason: 'Show the command output',
                        workingDirectory: 'C:/fixture',
                    }),
                },
            ]),
            response('shell finished')
        );
        const mounted = await mountComposable(
            () => useAgentState(),
            (app) => app.provide(agentApiKey, fixture.window.api)
        );
        try {
            const started = await fixture.window.api.startTask({
                prompt: 'run the safe shell command',
            });
            mounted.result.attachTaskView(started.taskId);
            await expect.poll(() => channel).toBeTruthy();
            const stream = channel!;
            for (const chunk of ['alpha\n', 'beta']) {
                emitTauriChannelMessage(
                    stream.events,
                    {
                        kind: 'chunk',
                        executionId: stream.request.executionId,
                        stream: 'stdout',
                        chunk,
                    },
                    index++
                );
                await expect
                    .poll(
                        () =>
                            mounted.result.sessionHistory.value
                                .flatMap(selectToolCalls)
                                .find((tool) => tool.id === 'live-shell')?.result
                    )
                    .toContain(chunk.trim());
                expect(mounted.result.isLoading.value).toBe(true);
            }
            mounted.unmount();
            emitTauriChannelMessage(
                stream.events,
                {
                    kind: 'completed',
                    executionId: stream.request.executionId,
                    response: {
                        ...stream.request,
                        shell: 'powershell',
                        exitCode: 0,
                        success: true,
                        timedOut: false,
                        cancelled: false,
                        durationMs: 100,
                        stdout: 'alpha\nbeta',
                        stderr: '',
                        combinedOutput: 'alpha\nbeta',
                    },
                },
                index++
            );
            expect((await started.completion).response).toBe('shell finished');
            expect(fixture.window.api.getTaskSnapshot(started.taskId)?.status).toBe('completed');
            const sessionId = fixture.window.api.getTaskSnapshot(started.taskId)!.sessionId!;
            const loaded = await fixture.window.api.loadSession(sessionId);
            expect(
                loaded.history.flatMap(selectToolCalls).find((tool) => tool.id === 'live-shell')
                    ?.result
            ).toContain('beta');
        } finally {
            mounted.unmount();
            await fixture.window.dispose();
        }
    });
});
