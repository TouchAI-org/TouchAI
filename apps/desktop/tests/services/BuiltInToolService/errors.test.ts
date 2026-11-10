import { describe, expect, it, vi } from 'vitest';

const { logErrorMock, logWarnMock } = vi.hoisted(() => ({
    logErrorMock: vi.fn(),
    logWarnMock: vi.fn(),
}));

vi.mock('@services/ObservabilityService', () => ({
    log: {
        error: logErrorMock,
        warn: logWarnMock,
    },
}));

import {
    formatHttpStatus,
    isToolTimeoutError,
    resolveToolFailure,
    ToolUserFacingError,
} from '@/services/BuiltInToolService/errors';

describe('user sees a built-in tool failure without internal diagnostics', () => {
    it('user sees the tool-owned message when the tool marks the failure as safe', () => {
        const failure = resolveToolFailure(
            new ToolUserFacingError('The selected folder is outside the allowed scope.'),
            {
                toolId: 'read',
                fallbackMessage: 'Tool execution failed',
            }
        );

        expect(failure).toEqual({
            message: 'The selected folder is outside the allowed scope.',
            status: 'error',
        });
        expect(logErrorMock).not.toHaveBeenCalled();
        expect(logWarnMock).not.toHaveBeenCalled();
    });

    it('user sees stable fallback text when a host error carries private details', () => {
        const failures = [
            new Error('database is locked at /home/user/.config/touchai.db'),
            'transport token=secret',
            { message: 'provider returned a private payload' },
        ];

        for (const error of failures) {
            const failure = resolveToolFailure(error, {
                toolId: 'browser',
                fallbackMessage: 'Tool execution failed',
            });

            expect(failure).toEqual({
                message: 'Tool execution failed',
                status: 'error',
            });
            expect(failure.message).not.toContain('touchai.db');
            expect(failure.message).not.toContain('token=secret');
            expect(failure.message).not.toContain('private payload');
        }
        expect(logErrorMock).toHaveBeenCalledTimes(failures.length);
    });

    it('user sees the timeout message when the deadline expires', () => {
        const error = new DOMException('native deadline details', 'TimeoutError');

        expect(isToolTimeoutError(error)).toBe(true);
        expect(
            resolveToolFailure(error, {
                toolId: 'web_fetch',
                fallbackMessage: 'Tool execution failed',
                timeoutMessage: 'The tool timed out. Try again.',
            })
        ).toEqual({
            message: 'The tool timed out. Try again.',
            status: 'timeout',
        });
        expect(logWarnMock).toHaveBeenCalledWith('[BuiltInTool:web_fetch] Tool timed out', error);
    });

    it('user sees a timeout without an error status when a non-timeout error is passed', () => {
        expect(isToolTimeoutError(new DOMException('cancelled', 'AbortError'))).toBe(false);
        expect(isToolTimeoutError(new Error('TimeoutError'))).toBe(false);
    });
});

describe('user sees a safe HTTP status line', () => {
    it('user sees control characters and redundant whitespace removed', () => {
        expect(formatHttpStatus(418, '\u0000 Teapot\n\n  brewing\tcoffee  ')).toBe(
            'HTTP 418 Teapot brewing coffee'
        );
    });

    it('user sees status text bounded so an upstream response cannot flood the result', () => {
        const statusLine = formatHttpStatus(500, 'x'.repeat(200));

        expect(statusLine).toBe(`HTTP 500 ${'x'.repeat(80)}`);
    });

    it('user sees only the status code when the upstream has no status text', () => {
        expect(formatHttpStatus(204, '   ')).toBe('HTTP 204');
    });
});
