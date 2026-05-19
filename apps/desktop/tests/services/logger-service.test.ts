import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nativeLogMock = vi.hoisted(() => ({
    log: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@services/NativeService', () => ({
    native: {
        log: nativeLogMock,
    },
}));

vi.mock('@tauri-apps/api/window', () => ({
    getCurrentWindow: () => ({ label: 'main' }),
}));

describe('LoggerService', () => {
    const originalConsole = {
        trace: console.trace,
        debug: console.debug,
        info: console.info,
        warn: console.warn,
        error: console.error,
        log: console.log,
    };

    beforeEach(() => {
        console.trace = originalConsole.trace;
        console.debug = originalConsole.debug;
        console.info = originalConsole.info;
        console.warn = originalConsole.warn;
        console.error = originalConsole.error;
        console.log = originalConsole.log;
    });

    afterEach(() => {
        console.trace = originalConsole.trace;
        console.debug = originalConsole.debug;
        console.info = originalConsole.info;
        console.warn = originalConsole.warn;
        console.error = originalConsole.error;
        console.log = originalConsole.log;

        vi.resetModules();
        vi.clearAllMocks();
    });

    it('does not stringify objects, capture callsites, or forward native IPC for disabled info logs', async () => {
        const nativeInfo = vi.spyOn(console, 'info').mockImplementation(() => undefined);
        const expensive = {
            toJSON: vi.fn(() => {
                throw new Error('should not stringify disabled log');
            }),
        };
        const errorConstructorSpy = vi.spyOn(globalThis, 'Error');
        const { initializeLogger } = await import('@/services/LoggerService');

        initializeLogger();
        console.info('[SearchView] measured resize', expensive);
        await Promise.resolve();

        expect(nativeInfo).toHaveBeenCalledWith('[SearchView] measured resize', expensive);
        expect(nativeLogMock.log).not.toHaveBeenCalled();
        expect(expensive.toJSON).not.toHaveBeenCalled();
        expect(errorConstructorSpy).not.toHaveBeenCalled();
    });

    it('forwards enabled warning logs with category keyValues and callsite disabled by default', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const { initializeLogger } = await import('@/services/LoggerService');

        initializeLogger();
        console.warn('[McpManager] reconnect failed', { serverId: 7 });
        await Promise.resolve();

        expect(nativeLogMock.log).toHaveBeenCalledWith({
            level: 4,
            message: '[McpManager] reconnect failed {"serverId":7}',
            location: undefined,
            file: undefined,
            line: undefined,
            keyValues: {
                category: 'mcp',
            },
        });
    });

    it('allows category loggers to pass bounded structured fields without string prefixes', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const { createLogger, initializeLogger } = await import('@/services/LoggerService');

        initializeLogger();
        createLogger('resize').warn('resize commit failed', new Error('native failed'), {
            targetHeight: 420,
        });
        await Promise.resolve();

        expect(nativeLogMock.log).toHaveBeenCalledWith({
            level: 4,
            message: 'resize commit failed Error: native failed',
            location: undefined,
            file: undefined,
            line: undefined,
            keyValues: {
                category: 'resize',
                targetHeight: '420',
            },
        });
    });
});
