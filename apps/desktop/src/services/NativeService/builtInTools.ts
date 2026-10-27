import { Channel } from '@tauri-apps/api/core';

import { invoke } from './invoke';
import type {
    BuiltInBashEvent,
    BuiltInBashExecutionRequest,
    BuiltInBashExecutionResponse,
    BuiltInBashOutputDelta,
} from './types';

interface ExecuteBashOptions {
    onOutputDelta?: (event: BuiltInBashOutputDelta) => void;
}

const DEFAULT_BASH_TIMEOUT_MS = 15_000;
// Backend completion is emitted only after process termination and stdout/stderr draining finish,
// so the frontend watchdog must tolerate a meaningful cleanup window after the shell timeout.
const STREAM_TERMINATION_GRACE_MS = 30_000;

function combineBashOutput(stdout: string, stderr: string): string {
    if (stdout && stderr) {
        return `STDOUT:\n${stdout}\n\nSTDERR:\n${stderr}`;
    }

    if (stdout) {
        return stdout;
    }

    if (stderr) {
        return `STDERR:\n${stderr}`;
    }

    return '';
}

/**
 * 原生内置工具桥接层。
 */
export const builtInTools = {
    async executeBash(
        request: BuiltInBashExecutionRequest,
        options: ExecuteBashOptions = {}
    ): Promise<BuiltInBashExecutionResponse> {
        if (!options.onOutputDelta) {
            return invoke('built_in_tools_execute_bash', {
                request,
            });
        }

        let stdout = '';
        let stderr = '';
        let settled = false;
        let terminalEventTimeout: ReturnType<typeof setTimeout> | null = null;
        let resolveResponse: ((response: BuiltInBashExecutionResponse) => void) | null = null;
        let rejectResponse: ((error: unknown) => void) | null = null;
        const responsePromise = new Promise<BuiltInBashExecutionResponse>((resolve, reject) => {
            resolveResponse = resolve;
            rejectResponse = reject;
        });
        const clearTerminalEventTimeout = () => {
            if (terminalEventTimeout) {
                clearTimeout(terminalEventTimeout);
                terminalEventTimeout = null;
            }
        };
        const settleWithError = (error: unknown) => {
            if (settled) {
                return;
            }

            settled = true;
            clearTerminalEventTimeout();
            rejectResponse?.(error);
            resolveResponse = null;
            rejectResponse = null;
        };
        const events = new Channel<BuiltInBashEvent>((payload) => {
            if (!payload || settled || payload.executionId !== request.executionId) {
                return;
            }

            if (payload.kind === 'chunk') {
                if (payload.stream === 'stdout') {
                    stdout += payload.chunk;
                } else {
                    stderr += payload.chunk;
                }

                options.onOutputDelta?.({
                    executionId: payload.executionId,
                    stream: payload.stream,
                    chunk: payload.chunk,
                    stdout,
                    stderr,
                    combinedOutput: combineBashOutput(stdout, stderr),
                });
                return;
            }

            if (payload.kind === 'completed') {
                settled = true;
                clearTerminalEventTimeout();
                resolveResponse?.(payload.response);
                resolveResponse = null;
                rejectResponse = null;
                return;
            }

            settleWithError(new Error(payload.error));
        });
        terminalEventTimeout = setTimeout(
            () => {
                settleWithError(new Error('Bash execution ended without a terminal event'));
            },
            (request.timeoutMs ?? DEFAULT_BASH_TIMEOUT_MS) + STREAM_TERMINATION_GRACE_MS
        );

        try {
            await invoke('built_in_tools_start_bash', {
                request,
                events,
            });
        } catch (error) {
            settled = true;
            clearTerminalEventTimeout();
            resolveResponse = null;
            rejectResponse = null;
            throw error;
        }

        return responsePromise;
    },
    cancelBash(executionId: string): Promise<boolean> {
        return invoke('built_in_tools_cancel_bash', { executionId });
    },
} as const;
