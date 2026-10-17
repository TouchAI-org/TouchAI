import type { BuiltInBashExecutionResponse } from '@services/NativeService';
import { closeTauriChannel, emitTauriChannelMessage, mockTauriCommand } from '@tests/utils/tauri';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionTaskProjection } from '@/services/AgentService/task/projection/projection';
import type { SessionTaskSnapshot } from '@/services/AgentService/task/types';
import { DEFAULT_BASH_TOOL_CONFIG } from '@/services/BuiltInToolService/tools/bash/constants';
import { executeBashTool } from '@/services/BuiltInToolService/tools/bash/index';
import { selectToolCalls } from '@/utils/session';

afterEach(() => {
    vi.useRealTimers();
});

function resolveSerializedStreamChannel(payload: unknown): string {
    if (payload && typeof payload === 'object' && 'events' in payload) {
        return payload.events as string;
    }

    throw new Error('Expected built_in_tools_start_bash to receive an events channel');
}

function createTaskSnapshot(): SessionTaskSnapshot {
    const now = Date.now();
    return {
        taskId: 'task-1',
        sessionId: null,
        turnId: null,
        status: 'running',
        executionMode: 'foreground',
        prompt: 'run bash',
        sessionHistory: [],
        pendingToolApproval: null,
        pendingApprovals: [],
        pendingUserQuestion: null,
        error: null,
        currentModel: null,
        promptSnapshot: null,
        lastCheckpoint: null,
        startedAt: now,
        updatedAt: now,
        modelSwitchCount: 0,
    };
}

function createBashResponse(
    overrides: Partial<BuiltInBashExecutionResponse> = {}
): BuiltInBashExecutionResponse {
    return {
        command: 'Write-Output "alpha"',
        shell: 'powershell',
        workingDirectory: 'D:/Project/TouchAI',
        exitCode: 0,
        success: true,
        timedOut: false,
        cancelled: false,
        durationMs: 120,
        stdout: 'alpha',
        stderr: '',
        combinedOutput: 'alpha',
        ...overrides,
    };
}

describe('executeBashTool streaming result deltas', () => {
    it('emits a result delta while the bash command is still running', async () => {
        const response = createBashResponse();
        mockTauriCommand('built_in_tools_start_bash', async (payload: unknown) => {
            const stream = resolveSerializedStreamChannel(payload);
            emitTauriChannelMessage(stream, {
                kind: 'chunk',
                executionId: 'call-1',
                stream: 'stdout',
                chunk: 'alpha',
            });
            emitTauriChannelMessage(
                stream,
                {
                    kind: 'completed',
                    executionId: 'call-1',
                    response,
                },
                1
            );
            closeTauriChannel(stream, 2);

            return true;
        });

        const emitToolEvent = vi.fn();
        const result = await executeBashTool(
            {
                command: 'Write-Output "alpha"',
                workingDirectory: 'D:/Project/TouchAI',
            },
            DEFAULT_BASH_TOOL_CONFIG,
            {
                callId: 'call-1',
                iteration: 0,
                currentModel: undefined,
                signal: undefined,
                emitToolEvent,
                hasExecutedBuiltInTool: vi.fn(),
            }
        );

        expect(emitToolEvent).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'result_delta',
                callId: 'call-1',
                result: expect.stringContaining('alpha'),
            })
        );
        expect(result).toMatchObject({
            status: 'success',
            isError: false,
        });
        expect(result.result).toContain('alpha');
    });

    it('propagates streaming bash output into the task projection before call completion', async () => {
        const response = createBashResponse({
            command: 'Write-Output "alpha"; Write-Output "beta"',
            durationMs: 240,
            stdout: 'alpha\nbeta',
            combinedOutput: 'alpha\nbeta',
        });
        mockTauriCommand('built_in_tools_start_bash', async (payload: unknown) => {
            const stream = resolveSerializedStreamChannel(payload);
            emitTauriChannelMessage(stream, {
                kind: 'chunk',
                executionId: 'call-1',
                stream: 'stdout',
                chunk: 'alpha\n',
            });
            emitTauriChannelMessage(
                stream,
                {
                    kind: 'chunk',
                    executionId: 'call-1',
                    stream: 'stdout',
                    chunk: 'beta',
                },
                1
            );
            emitTauriChannelMessage(
                stream,
                {
                    kind: 'completed',
                    executionId: 'call-1',
                    response,
                },
                2
            );
            closeTauriChannel(stream, 3);

            return true;
        });

        const snapshot = createTaskSnapshot();
        const projection = new SessionTaskProjection(snapshot, vi.fn());
        projection.bootstrap([], 'run bash', undefined);
        projection.handleChunk({
            content: '',
            done: false,
            toolEvent: {
                type: 'call_start',
                callId: 'call-1',
                toolName: 'Bash',
                namespacedName: 'builtin__bash',
                source: 'builtin',
                sourceLabel: '内置工具',
                arguments: {
                    command: 'Write-Output "alpha"; Write-Output "beta"',
                },
                builtinConversationSemantic: {
                    action: 'run',
                    target: 'Write-Output "alpha"; Write-Output "beta"',
                },
            },
        });

        const result = await executeBashTool(
            {
                command: 'Write-Output "alpha"; Write-Output "beta"',
                workingDirectory: 'D:/Project/TouchAI',
            },
            DEFAULT_BASH_TOOL_CONFIG,
            {
                callId: 'call-1',
                iteration: 0,
                currentModel: undefined,
                signal: undefined,
                emitToolEvent: (toolEvent) =>
                    projection.handleChunk({
                        content: '',
                        done: false,
                        toolEvent,
                    }),
                hasExecutedBuiltInTool: vi.fn(),
            }
        );

        const assistantMessage = snapshot.sessionHistory.find(
            (message) => message.role === 'assistant'
        );

        expect(result.result).toContain('alpha');
        expect(result.result).toContain('beta');
        const toolCalls = assistantMessage ? selectToolCalls(assistantMessage) : [];
        expect(toolCalls[0]).toMatchObject({
            id: 'call-1',
            status: 'executing',
        });
        expect(toolCalls[0]?.result).toContain('alpha');
        expect(toolCalls[0]?.result).toContain('beta');
    });

    it('coalesces rapid stream deltas into a leading and trailing emission', async () => {
        vi.useFakeTimers();

        let stdout = '';
        const response = createBashResponse({
            command: '1..40 | ForEach-Object { "line $_" }',
        });
        mockTauriCommand('built_in_tools_start_bash', async (payload: unknown) => {
            const stream = resolveSerializedStreamChannel(payload);
            let messageIndex = 0;
            for (let index = 0; index < 40; index += 1) {
                stdout += `line ${index}\n`;
                emitTauriChannelMessage(
                    stream,
                    {
                        kind: 'chunk',
                        executionId: 'call-coalesce',
                        stream: 'stdout',
                        chunk: `line ${index}\n`,
                    },
                    messageIndex
                );
                messageIndex += 1;
            }

            // 让合并窗口的尾随补发在命令结束前落地。
            await vi.advanceTimersByTimeAsync(100);

            emitTauriChannelMessage(
                stream,
                {
                    kind: 'completed',
                    executionId: 'call-coalesce',
                    response: { ...response, stdout, combinedOutput: stdout },
                },
                messageIndex
            );
            closeTauriChannel(stream, messageIndex + 1);

            return true;
        });

        const emitToolEvent = vi.fn();
        await executeBashTool(
            {
                command: '1..40 | ForEach-Object { "line $_" }',
                workingDirectory: 'D:/Project/TouchAI',
            },
            DEFAULT_BASH_TOOL_CONFIG,
            {
                callId: 'call-coalesce',
                iteration: 0,
                currentModel: undefined,
                signal: undefined,
                emitToolEvent,
                hasExecutedBuiltInTool: vi.fn(),
            }
        );

        const deltaResults = emitToolEvent.mock.calls
            .filter(([event]) => event.type === 'result_delta')
            .map(([event]) => event.result as string);

        // 40 个 chunk 只允许触发两次 UI 更新：首个 chunk 立即展示，窗口结束后补发最新快照。
        expect(deltaResults).toHaveLength(2);
        expect(deltaResults[0]).toContain('line 0');
        expect(deltaResults[0]).not.toContain('line 39');
        expect(deltaResults[1]).toContain('line 39');
    });

    it('flushes the buffered delta before the tool call resolves', async () => {
        const response = createBashResponse({
            command: 'Write-Output "alpha"; Write-Output "beta"',
            durationMs: 240,
            stdout: 'alpha\nbeta',
            combinedOutput: 'alpha\nbeta',
        });
        mockTauriCommand('built_in_tools_start_bash', async (payload: unknown) => {
            const stream = resolveSerializedStreamChannel(payload);
            emitTauriChannelMessage(stream, {
                kind: 'chunk',
                executionId: 'call-flush',
                stream: 'stdout',
                chunk: 'alpha\n',
            });
            emitTauriChannelMessage(
                stream,
                {
                    kind: 'chunk',
                    executionId: 'call-flush',
                    stream: 'stdout',
                    chunk: 'beta',
                },
                1
            );
            emitTauriChannelMessage(
                stream,
                {
                    kind: 'completed',
                    executionId: 'call-flush',
                    response,
                },
                2
            );
            closeTauriChannel(stream, 3);

            return true;
        });

        let isSettled = false;
        const deltaResults: string[] = [];
        const emitToolEvent = vi.fn((event: { type: string; result?: string }) => {
            if (event.type === 'result_delta') {
                expect(isSettled).toBe(false);
                deltaResults.push(event.result ?? '');
            }
        });

        const result = await executeBashTool(
            {
                command: 'Write-Output "alpha"; Write-Output "beta"',
                workingDirectory: 'D:/Project/TouchAI',
            },
            DEFAULT_BASH_TOOL_CONFIG,
            {
                callId: 'call-flush',
                iteration: 0,
                currentModel: undefined,
                signal: undefined,
                emitToolEvent,
                hasExecutedBuiltInTool: vi.fn(),
            }
        );
        isSettled = true;

        // 窗口内的最后一个快照必须在工具返回前补发，否则调用方收尾时会丢掉尾部输出。
        expect(deltaResults).toHaveLength(2);
        expect(deltaResults[1]).toContain('alpha');
        expect(deltaResults[1]).toContain('beta');
        expect(result.result).toContain('alpha');
        expect(result.result).toContain('beta');
    });

    it('drops buffered output when the native bash call fails', async () => {
        vi.useFakeTimers();

        mockTauriCommand('built_in_tools_start_bash', async (payload: unknown) => {
            const stream = resolveSerializedStreamChannel(payload);
            emitTauriChannelMessage(stream, {
                kind: 'chunk',
                executionId: 'call-fail',
                stream: 'stdout',
                chunk: 'alpha\n',
            });
            emitTauriChannelMessage(
                stream,
                {
                    kind: 'chunk',
                    executionId: 'call-fail',
                    stream: 'stdout',
                    chunk: 'beta',
                },
                1
            );
            closeTauriChannel(stream, 2);

            throw new Error('native bridge failed');
        });

        const emitToolEvent = vi.fn();
        await expect(
            executeBashTool(
                {
                    command: 'Write-Output "alpha"; Write-Output "beta"',
                    workingDirectory: 'D:/Project/TouchAI',
                },
                DEFAULT_BASH_TOOL_CONFIG,
                {
                    callId: 'call-fail',
                    iteration: 0,
                    currentModel: undefined,
                    signal: undefined,
                    emitToolEvent,
                    hasExecutedBuiltInTool: vi.fn(),
                }
            )
        ).rejects.toThrow('native bridge failed');

        await vi.advanceTimersByTimeAsync(500);

        // 失败时只保留首个已展示的 chunk，不再补发半成品输出，也不残留定时器。
        expect(emitToolEvent).toHaveBeenCalledTimes(1);
        expect(emitToolEvent).toHaveBeenCalledWith(
            expect.objectContaining({
                type: 'result_delta',
                result: expect.stringContaining('alpha'),
            })
        );
    });

    it('returns a timeout error when the native bash response times out', async () => {
        const response = createBashResponse({
            exitCode: null,
            success: false,
            timedOut: true,
            durationMs: 15_500,
        });
        mockTauriCommand('built_in_tools_start_bash', async (payload: unknown) => {
            const stream = resolveSerializedStreamChannel(payload);
            emitTauriChannelMessage(
                stream,
                {
                    kind: 'completed',
                    executionId: 'call-timeout',
                    response,
                },
                0
            );
            closeTauriChannel(stream, 1);

            return true;
        });

        const result = await executeBashTool(
            {
                command: 'Write-Output "alpha"',
                workingDirectory: 'D:/Project/TouchAI',
            },
            DEFAULT_BASH_TOOL_CONFIG,
            {
                callId: 'call-timeout',
                iteration: 0,
                currentModel: undefined,
                signal: undefined,
                emitToolEvent: vi.fn(),
                hasExecutedBuiltInTool: vi.fn(),
            }
        );

        expect(result).toMatchObject({
            isError: true,
            errorMessage: '命令执行超时',
        });
    });

    it('returns a formatted execution error when the native bash response fails', async () => {
        const response = createBashResponse({
            command: 'Write-Error "boom"',
            exitCode: 1,
            success: false,
            durationMs: 500,
            stdout: '',
            stderr: 'boom',
            combinedOutput: 'STDERR:\nboom',
        });
        mockTauriCommand('built_in_tools_start_bash', async (payload: unknown) => {
            const stream = resolveSerializedStreamChannel(payload);
            emitTauriChannelMessage(
                stream,
                {
                    kind: 'completed',
                    executionId: 'call-error',
                    response,
                },
                0
            );
            closeTauriChannel(stream, 1);

            return true;
        });

        const result = await executeBashTool(
            {
                command: 'Write-Error "boom"',
                workingDirectory: 'D:/Project/TouchAI',
            },
            DEFAULT_BASH_TOOL_CONFIG,
            {
                callId: 'call-error',
                iteration: 0,
                currentModel: undefined,
                signal: undefined,
                emitToolEvent: vi.fn(),
                hasExecutedBuiltInTool: vi.fn(),
            }
        );

        expect(result).toMatchObject({
            status: 'error',
            isError: true,
            errorMessage: 'STDERR:\nboom',
        });
        expect(result.result).toContain('Duration: 500ms');
    });
});
