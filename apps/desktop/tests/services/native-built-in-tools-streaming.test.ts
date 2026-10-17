import type {
    BuiltInBashExecutionRequest,
    BuiltInBashExecutionResponse,
} from '@services/NativeService';
import { builtInTools } from '@services/NativeService';
import { closeTauriChannel, emitTauriChannelMessage, mockTauriCommand } from '@tests/utils/tauri';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface BuiltInBashOutputEvent {
    executionId: string;
    stream: 'stdout' | 'stderr';
    chunk: string;
    stdout: string;
    stderr: string;
    combinedOutput: string;
}

const executeBashWithStreaming = builtInTools.executeBash as unknown as (
    request: BuiltInBashExecutionRequest,
    options: {
        onOutputDelta: (event: BuiltInBashOutputEvent) => void;
    }
) => Promise<BuiltInBashExecutionResponse>;

afterEach(() => {
    vi.useRealTimers();
});

function resolveSerializedStreamChannel(payload: unknown): string {
    if (payload && typeof payload === 'object' && 'events' in payload) {
        return payload.events as string;
    }

    throw new Error('Expected built_in_tools_start_bash to receive an events channel');
}

describe('NativeService built-in bash streaming', () => {
    it('streams incremental stdout and stderr updates before the final response resolves', async () => {
        const request: BuiltInBashExecutionRequest = {
            executionId: 'exec-stream-1',
            command: 'Write-Output "alpha"; Write-Error "beta"',
            timeoutMs: 10_000,
        };
        const finalResponse: BuiltInBashExecutionResponse = {
            command: request.command,
            shell: 'powershell',
            workingDirectory: 'D:/Project/TouchAI',
            exitCode: 0,
            success: true,
            timedOut: false,
            cancelled: false,
            durationMs: 1200,
            stdout: 'alpha',
            stderr: 'beta',
            combinedOutput: 'STDOUT:\nalpha\n\nSTDERR:\nbeta',
        };

        mockTauriCommand('built_in_tools_start_bash', async (payload: unknown) => {
            const stream = resolveSerializedStreamChannel(payload);
            emitTauriChannelMessage(stream, {
                kind: 'chunk',
                executionId: request.executionId,
                stream: 'stdout',
                chunk: 'alpha',
            });
            emitTauriChannelMessage(
                stream,
                {
                    kind: 'chunk',
                    executionId: request.executionId,
                    stream: 'stderr',
                    chunk: 'beta',
                },
                1
            );
            emitTauriChannelMessage(
                stream,
                {
                    kind: 'completed',
                    executionId: request.executionId,
                    response: finalResponse,
                },
                2
            );
            closeTauriChannel(stream, 3);

            return true;
        });

        const deltas: BuiltInBashOutputEvent[] = [];
        const response = await executeBashWithStreaming(request, {
            onOutputDelta: (event) => deltas.push(event),
        });

        expect(response).toEqual(finalResponse);
        expect(deltas).toEqual([
            {
                executionId: request.executionId,
                stream: 'stdout',
                chunk: 'alpha',
                stdout: 'alpha',
                stderr: '',
                combinedOutput: 'alpha',
            },
            {
                executionId: request.executionId,
                stream: 'stderr',
                chunk: 'beta',
                stdout: 'alpha',
                stderr: 'beta',
                combinedOutput: 'STDOUT:\nalpha\n\nSTDERR:\nbeta',
            },
        ]);
    });

    it('stops delivering stream chunks after the bash request settles', async () => {
        const request: BuiltInBashExecutionRequest = {
            executionId: 'exec-stream-2',
            command: 'Write-Output "once"',
            timeoutMs: 10_000,
        };
        const finalResponse: BuiltInBashExecutionResponse = {
            command: request.command,
            shell: 'powershell',
            workingDirectory: 'D:/Project/TouchAI',
            exitCode: 0,
            success: true,
            timedOut: false,
            cancelled: false,
            durationMs: 900,
            stdout: 'once',
            stderr: '',
            combinedOutput: 'once',
        };

        let streamChannel = '';
        mockTauriCommand('built_in_tools_start_bash', async (payload: unknown) => {
            streamChannel = resolveSerializedStreamChannel(payload);
            emitTauriChannelMessage(streamChannel, {
                kind: 'chunk',
                executionId: request.executionId,
                stream: 'stdout',
                chunk: 'once',
            });
            emitTauriChannelMessage(
                streamChannel,
                {
                    kind: 'completed',
                    executionId: request.executionId,
                    response: finalResponse,
                },
                1
            );
            closeTauriChannel(streamChannel, 2);
            return true;
        });

        const deltas: BuiltInBashOutputEvent[] = [];
        await executeBashWithStreaming(request, {
            onOutputDelta: (event) => deltas.push(event),
        });

        expect(() =>
            emitTauriChannelMessage(streamChannel, {
                kind: 'chunk',
                executionId: request.executionId,
                stream: 'stdout',
                chunk: 'late',
            })
        ).not.toThrow();

        expect(deltas).toEqual([
            {
                executionId: 'exec-stream-2',
                stream: 'stdout',
                chunk: 'once',
                stdout: 'once',
                stderr: '',
                combinedOutput: 'once',
            },
        ]);
    });

    it('does not attach a stream channel when no output callback is provided', async () => {
        const request: BuiltInBashExecutionRequest = {
            executionId: 'exec-stream-3',
            command: 'Write-Output "done"',
            timeoutMs: 10_000,
        };
        const finalResponse: BuiltInBashExecutionResponse = {
            command: request.command,
            shell: 'powershell',
            workingDirectory: 'D:/Project/TouchAI',
            exitCode: 0,
            success: true,
            timedOut: false,
            cancelled: false,
            durationMs: 300,
            stdout: 'done',
            stderr: '',
            combinedOutput: 'done',
        };

        mockTauriCommand('built_in_tools_execute_bash', async (payload: unknown) => {
            expect(payload).toEqual({
                request,
            });
            return finalResponse;
        });

        await expect(builtInTools.executeBash(request)).resolves.toEqual(finalResponse);
    });

    it('ignores chunks from other executions and formats stderr-only output', async () => {
        const request: BuiltInBashExecutionRequest = {
            executionId: 'exec-stream-4',
            command: 'Write-Error "boom"',
            timeoutMs: 10_000,
        };
        const finalResponse: BuiltInBashExecutionResponse = {
            command: request.command,
            shell: 'powershell',
            workingDirectory: 'D:/Project/TouchAI',
            exitCode: 1,
            success: false,
            timedOut: false,
            cancelled: false,
            durationMs: 700,
            stdout: '',
            stderr: 'boom',
            combinedOutput: 'STDERR:\nboom',
        };

        mockTauriCommand('built_in_tools_start_bash', async (payload: unknown) => {
            const stream = resolveSerializedStreamChannel(payload);
            emitTauriChannelMessage(stream, {
                kind: 'chunk',
                executionId: 'other-exec',
                stream: 'stdout',
                chunk: 'ignore-me',
            });
            emitTauriChannelMessage(
                stream,
                {
                    kind: 'chunk',
                    executionId: request.executionId,
                    stream: 'stderr',
                    chunk: 'boom',
                },
                1
            );
            emitTauriChannelMessage(
                stream,
                {
                    kind: 'completed',
                    executionId: request.executionId,
                    response: finalResponse,
                },
                2
            );
            closeTauriChannel(stream, 3);

            return true;
        });

        const deltas: BuiltInBashOutputEvent[] = [];
        const response = await executeBashWithStreaming(request, {
            onOutputDelta: (event) => deltas.push(event),
        });

        expect(response).toEqual(finalResponse);
        expect(deltas).toEqual([
            {
                executionId: request.executionId,
                stream: 'stderr',
                chunk: 'boom',
                stdout: '',
                stderr: 'boom',
                combinedOutput: 'STDERR:\nboom',
            },
        ]);
    });

    it('rejects when the backend reports a failed streaming execution', async () => {
        const request: BuiltInBashExecutionRequest = {
            executionId: 'exec-stream-5',
            command: 'Write-Error "boom"',
            timeoutMs: 10_000,
        };

        mockTauriCommand('built_in_tools_start_bash', async (payload: unknown) => {
            const stream = resolveSerializedStreamChannel(payload);
            emitTauriChannelMessage(stream, {
                kind: 'failed',
                executionId: request.executionId,
                error: 'PowerShell failed',
            });
            closeTauriChannel(stream, 1);

            return true;
        });

        const deltas: BuiltInBashOutputEvent[] = [];

        await expect(
            executeBashWithStreaming(request, {
                onOutputDelta: (event) => deltas.push(event),
            })
        ).rejects.toThrow('PowerShell failed');
        expect(deltas).toEqual([]);
    });

    it('preserves empty combined output when the backend emits an empty chunk', async () => {
        const request: BuiltInBashExecutionRequest = {
            executionId: 'exec-stream-6',
            command: 'Write-Output ""',
            timeoutMs: 10_000,
        };
        const finalResponse: BuiltInBashExecutionResponse = {
            command: request.command,
            shell: 'powershell',
            workingDirectory: 'D:/Project/TouchAI',
            exitCode: 0,
            success: true,
            timedOut: false,
            cancelled: false,
            durationMs: 200,
            stdout: '',
            stderr: '',
            combinedOutput: '',
        };

        mockTauriCommand('built_in_tools_start_bash', async (payload: unknown) => {
            const stream = resolveSerializedStreamChannel(payload);
            emitTauriChannelMessage(stream, {
                kind: 'chunk',
                executionId: request.executionId,
                stream: 'stdout',
                chunk: '',
            });
            emitTauriChannelMessage(
                stream,
                {
                    kind: 'completed',
                    executionId: request.executionId,
                    response: finalResponse,
                },
                1
            );

            return true;
        });

        const deltas: BuiltInBashOutputEvent[] = [];
        const response = await executeBashWithStreaming(request, {
            onOutputDelta: (event) => deltas.push(event),
        });

        expect(response).toEqual(finalResponse);
        expect(deltas).toEqual([
            {
                executionId: request.executionId,
                stream: 'stdout',
                chunk: '',
                stdout: '',
                stderr: '',
                combinedOutput: '',
            },
        ]);
    });

    it('surfaces immediate start failures from the backend', async () => {
        const request: BuiltInBashExecutionRequest = {
            executionId: 'exec-stream-7',
            command: 'Write-Output "noop"',
            timeoutMs: 10_000,
        };

        mockTauriCommand('built_in_tools_start_bash', async () => {
            throw new Error('channel registration failed');
        });

        await expect(
            executeBashWithStreaming(request, {
                onOutputDelta: () => undefined,
            })
        ).rejects.toThrow('channel registration failed');
    });

    it('rejects when no terminal event arrives before the watchdog deadline', async () => {
        vi.useFakeTimers();
        const request: BuiltInBashExecutionRequest = {
            executionId: 'exec-stream-8',
            command: 'Write-Output "late"',
            timeoutMs: 25,
        };

        mockTauriCommand('built_in_tools_start_bash', async () => true);

        const responsePromise = executeBashWithStreaming(request, {
            onOutputDelta: () => undefined,
        });
        const rejectionExpectation = expect(responsePromise).rejects.toThrow(
            'Bash execution ended without a terminal event'
        );

        await vi.advanceTimersByTimeAsync(30_026);

        await rejectionExpectation;
    });

    it('accepts a terminal event that arrives after the shell timeout but within cleanup grace', async () => {
        vi.useFakeTimers();
        const request: BuiltInBashExecutionRequest = {
            executionId: 'exec-stream-9',
            command: 'Write-Output "late-terminal"',
            timeoutMs: 25,
        };
        const finalResponse: BuiltInBashExecutionResponse = {
            command: request.command,
            shell: 'powershell',
            workingDirectory: 'D:/Project/TouchAI',
            exitCode: null,
            success: false,
            timedOut: true,
            cancelled: false,
            durationMs: 2_100,
            stdout: 'late-terminal',
            stderr: '',
            combinedOutput: 'late-terminal',
        };

        mockTauriCommand('built_in_tools_start_bash', async (payload: unknown) => {
            const stream = resolveSerializedStreamChannel(payload);
            setTimeout(() => {
                emitTauriChannelMessage(stream, {
                    kind: 'completed',
                    executionId: request.executionId,
                    response: finalResponse,
                });
            }, 2_000);

            return true;
        });

        const responsePromise = executeBashWithStreaming(request, {
            onOutputDelta: () => undefined,
        });

        await vi.advanceTimersByTimeAsync(2_001);

        await expect(responsePromise).resolves.toEqual(finalResponse);
    }, 30_000);

    it('forwards bash cancellation to the native command bridge', async () => {
        mockTauriCommand('built_in_tools_cancel_bash', async (payload: unknown) => {
            expect(payload).toEqual({
                executionId: 'exec-stream-cancel',
            });
            return true;
        });

        await expect(builtInTools.cancelBash('exec-stream-cancel')).resolves.toBe(true);
    });
});
