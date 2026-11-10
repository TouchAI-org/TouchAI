import { createServer, type Server } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { runInNewContext } from 'node:vm';

import { afterEach, describe, expect, it } from 'vitest';

interface MotionEnvironment {
    systemReducedMotion: boolean;
    applicationReducedMotion: boolean;
    visibility: string;
}

interface NativeDriver {
    options: { protocol: string; hostname: string; port: number; path: string };
    sessionId: string;
    execute: (script: () => Promise<MotionEnvironment>) => Promise<MotionEnvironment>;
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const { enableNativeNormalMotion } = (await import(
    pathToFileURL(join(root, 'apps/desktop/e2e-tests/performance/native-motion.mjs')).href
)) as { enableNativeNormalMotion: (driver: NativeDriver) => Promise<MotionEnvironment> };
const servers: Server[] = [];
const mediaCommand = {
    cmd: 'Emulation.setEmulatedMedia',
    params: { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] },
};

async function nativeDriver(
    options: {
        driverPath?: string;
        ignoreOverride?: boolean;
        pressure?: boolean;
        visibility?: string;
    } = {}
) {
    const initialEnvironment = {
        systemReducedMotion: true,
        applicationReducedMotion: true,
        visibility: options.visibility ?? 'visible',
    };
    const windows = { search: { ...initialEnvironment }, settings: { ...initialEnvironment } };
    let currentWindow: keyof typeof windows = 'search';
    const response: { status: number; value: { error?: string; message?: string } } = {
        status: 200,
        value: {},
    };
    const requests: { method: string | undefined; url: string | undefined; body: unknown }[] = [];
    const driverPath = options.driverPath ?? '/';
    const route = `${driverPath.replace(/\/$/, '')}/session/native-session/ms/cdp/execute`;
    const server = createServer(async (request, reply) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString());
        requests.push({ method: request.method, url: request.url, body });
        if (
            request.method !== 'POST' ||
            request.url !== route ||
            !isDeepStrictEqual(body, mediaCommand)
        ) {
            reply.writeHead(400, { 'Content-Type': 'application/json' });
            reply.end(
                JSON.stringify({
                    value: { error: 'invalid argument', message: 'Unexpected driver request' },
                })
            );
            return;
        }
        if (response.status === 200 && !response.value.error && !options.ignoreOverride) {
            windows[currentWindow].systemReducedMotion = false;
        }
        reply.writeHead(response.status, { 'Content-Type': 'application/json' });
        reply.end(JSON.stringify({ value: response.value }));
    });
    servers.push(server);
    await new Promise<void>((accept, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', accept);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test driver address');
    const driver = {
        sessionId: 'native-session',
        options: { protocol: 'http', hostname: '127.0.0.1', port: address.port, path: driverPath },
        async switchToWindow(name: keyof typeof windows) {
            currentWindow = name;
        },
        async execute(script: () => Promise<MotionEnvironment>) {
            const window = windows[currentWindow];
            return runInNewContext(`(${script.toString()})()`, {
                document: {
                    get visibilityState() {
                        return window.visibility;
                    },
                    documentElement: {
                        hasAttribute: (name: string) =>
                            name === 'data-reduced-motion' && window.applicationReducedMotion,
                    },
                },
                matchMedia: (query: string) => ({
                    matches:
                        query === '(prefers-reduced-motion: reduce)' && window.systemReducedMotion,
                }),
                requestAnimationFrame: (callback: () => void) =>
                    setTimeout(() => {
                        window.applicationReducedMotion =
                            window.systemReducedMotion || options.pressure === true;
                        callback();
                    }, 0),
                cancelAnimationFrame: clearTimeout,
                setTimeout,
                clearTimeout,
            }) as Promise<MotionEnvironment>;
        },
    };
    return { driver, windows, requests, response };
}

afterEach(async () => {
    for (const server of servers.splice(0)) {
        server.closeAllConnections();
        await new Promise<void>((accept, reject) => {
            server.close((error) => (error ? reject(error) : accept()));
        });
    }
});

describe('user measures native animations when the host prefers reduced motion', () => {
    it.each(['/', '/wd/hub', '/wd/hub/'])(
        'user connects through driver route %s and receives verified normal-motion conditions',
        async (driverPath) => {
            const fixture = await nativeDriver({ driverPath });
            await expect(enableNativeNormalMotion(fixture.driver)).resolves.toEqual({
                systemReducedMotion: false,
                applicationReducedMotion: false,
                visibility: 'visible',
            });
            expect(fixture.requests).toHaveLength(1);
        }
    );

    it('user switches benchmark windows and applies normal motion only to the selected window', async () => {
        const fixture = await nativeDriver();
        await enableNativeNormalMotion(fixture.driver);
        expect(fixture.windows.settings.systemReducedMotion).toBe(true);
        await fixture.driver.switchToWindow('settings');
        await expect(enableNativeNormalMotion(fixture.driver)).resolves.toMatchObject({
            systemReducedMotion: false,
            applicationReducedMotion: false,
        });
        expect(fixture.requests).toHaveLength(2);
    });

    it.each([500, 200])(
        'user receives a driver error with HTTP status %s and can try again after driver recovery',
        async (status) => {
            const fixture = await nativeDriver();
            fixture.response.status = status;
            fixture.response.value = {
                error: 'unknown error',
                message: 'Media emulation unavailable',
            };
            await expect(enableNativeNormalMotion(fixture.driver)).rejects.toThrow(
                'Media emulation unavailable'
            );
            expect(fixture.requests).toHaveLength(1);
            expect(fixture.windows.search.systemReducedMotion).toBe(true);
            fixture.response.status = 200;
            fixture.response.value = {};
            await expect(enableNativeNormalMotion(fixture.driver)).resolves.toMatchObject({
                systemReducedMotion: false,
                applicationReducedMotion: false,
            });
        }
    );

    it('user receives a successful but ineffective override and cannot measure reduced motion', async () => {
        const fixture = await nativeDriver({ ignoreOverride: true });
        await expect(enableNativeNormalMotion(fixture.driver)).rejects.toThrow(
            '"systemReducedMotion":true'
        );
        expect(fixture.windows.search.applicationReducedMotion).toBe(true);
    });

    it('user has automatic application pressure and cannot bypass it by changing system motion', async () => {
        const fixture = await nativeDriver({ pressure: true });
        await expect(enableNativeNormalMotion(fixture.driver)).rejects.toThrow(
            '"applicationReducedMotion":true'
        );
        expect(fixture.windows.search.systemReducedMotion).toBe(false);
        expect(fixture.windows.search.applicationReducedMotion).toBe(true);
    });

    it('user initializes a hidden benchmark window and cannot admit its measurements', async () => {
        const fixture = await nativeDriver({ visibility: 'hidden' });
        await expect(enableNativeNormalMotion(fixture.driver)).rejects.toThrow(
            '"visibility":"hidden"'
        );
        expect(fixture.windows.search.visibility).toBe('hidden');
    });
});
