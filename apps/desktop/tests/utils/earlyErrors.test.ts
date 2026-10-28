import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Errors raised before the structured logger is installed are buffered here. If this
 * module drops them, the first seconds of a failed startup are the only seconds nobody
 * can diagnose, so every branch below is about what the user's crash report contains.
 */
async function loadEarlyErrors() {
    return import('@/utils/early-errors');
}

function dispatchError(init: {
    error?: unknown;
    message?: string;
    filename?: string;
    lineno?: number;
    colno?: number;
}) {
    window.dispatchEvent(
        new ErrorEvent('error', {
            error: init.error,
            message: init.message ?? '',
            filename: init.filename ?? '',
            lineno: init.lineno ?? 0,
            colno: init.colno ?? 0,
        })
    );
}

function dispatchRejection(reason: unknown) {
    const event = new Event('unhandledrejection');
    Object.defineProperty(event, 'reason', { value: reason });
    window.dispatchEvent(event);
}

describe('user gets startup errors captured before the logger exists', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it('user gets an early window error replayed once the logger is installed', async () => {
        const { attachEarlyErrorSink } = await loadEarlyErrors();
        const error = new Error('boot failed');

        dispatchError({ error, message: 'boot failed', filename: 'app.js', lineno: 12, colno: 3 });

        const sink = vi.fn();
        attachEarlyErrorSink(sink);

        expect(sink).toHaveBeenCalledTimes(1);
        expect(sink).toHaveBeenCalledWith({
            level: 'error',
            event: 'app.early-error',
            attrs: {
                'error.source': 'app.js',
                'error.line': 12,
                'error.column': 3,
            },
            msg: expect.stringContaining('boot failed'),
        });
    });

    it('user gets an early rejection replayed with its reason', async () => {
        const { attachEarlyErrorSink } = await loadEarlyErrors();

        dispatchRejection({ code: 'E_BOOT' });

        const sink = vi.fn();
        attachEarlyErrorSink(sink);

        expect(sink).toHaveBeenCalledWith({
            level: 'error',
            event: 'app.unhandled-rejection',
            attrs: {},
            msg: '{"code":"E_BOOT"}',
        });
    });

    it('user gets the message when the browser reports no source location', async () => {
        const { attachEarlyErrorSink } = await loadEarlyErrors();

        dispatchError({ message: 'script error' });

        const sink = vi.fn();
        attachEarlyErrorSink(sink);

        expect(sink).toHaveBeenCalledWith(
            expect.objectContaining({
                attrs: {
                    'error.source': 'unknown',
                    'error.line': 0,
                    'error.column': 0,
                },
                msg: 'script error',
            })
        );
    });

    it('user gets later errors delivered straight to the installed logger', async () => {
        const { attachEarlyErrorSink } = await loadEarlyErrors();
        const sink = vi.fn();
        attachEarlyErrorSink(sink);

        dispatchError({ error: new Error('after bootstrap'), message: 'after bootstrap' });
        dispatchRejection('plain reason');

        expect(sink).toHaveBeenCalledTimes(2);
        expect(sink.mock.calls[1]?.[0]).toMatchObject({
            event: 'app.unhandled-rejection',
            msg: 'plain reason',
        });
    });

    it('user gets a reason that cannot be serialised described as text', async () => {
        const { attachEarlyErrorSink } = await loadEarlyErrors();
        const circular: Record<string, unknown> = {};
        circular.self = circular;

        dispatchRejection(circular);

        const sink = vi.fn();
        attachEarlyErrorSink(sink);

        expect(sink.mock.calls[0]?.[0]).toMatchObject({ msg: '[object Object]' });
    });

    it('user gets an error without a stack described by its message', async () => {
        const { attachEarlyErrorSink } = await loadEarlyErrors();
        const error = new Error('stack unavailable');
        error.stack = undefined;

        dispatchRejection(error);

        const sink = vi.fn();
        attachEarlyErrorSink(sink);

        expect(sink.mock.calls[0]?.[0]).toMatchObject({ msg: 'Error: stack unavailable' });
    });
});
