import { AppEvent } from '@services/EventService';
import { emit } from '@tauri-apps/api/event';
import { getTauriInvokeCalls, mockTauriCommand } from '@tests/utils/tauri';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const existsMock = vi.hoisted(() => vi.fn(async () => true));
const joinMock = vi.hoisted(() => vi.fn(async (...segments: string[]) => segments.join('/')));

vi.mock('@tauri-apps/plugin-fs', () => ({
    exists: existsMock,
}));

vi.mock('@tauri-apps/api/path', () => ({
    join: joinMock,
}));

const FONT_STYLE_SELECTOR = 'style[data-touchai-font-face="source-han-serif-sc"]';
const FONT_TEST_TIMEOUT_MS = 15_000;

function fontStyles(): HTMLStyleElement[] {
    return [...document.head.querySelectorAll<HTMLStyleElement>(FONT_STYLE_SELECTOR)];
}

function fontStyleText(): string {
    return fontStyles()[0]?.textContent ?? '';
}

function getPayloadEvent(payload: unknown): unknown {
    if (!payload || typeof payload !== 'object' || payload instanceof ArrayBuffer) {
        return undefined;
    }

    return (payload as { event?: unknown }).event;
}

async function waitForFontReadyListener(): Promise<void> {
    await vi.waitFor(() => {
        expect(
            getTauriInvokeCalls('plugin:event|listen').some(
                (call) => getPayloadEvent(call.payload) === AppEvent.FONT_READY
            )
        ).toBe(true);
    });
}

function fontReadyListenCalls() {
    return getTauriInvokeCalls('plugin:event|listen').filter(
        (call) => getPayloadEvent(call.payload) === AppEvent.FONT_READY
    );
}

function mockFontLoadingApi(checkResult = true) {
    const load = vi.fn().mockResolvedValue([]);
    const check = vi.fn().mockReturnValue(checkResult);

    Object.defineProperty(document, 'fonts', {
        configurable: true,
        value: { load, check },
    });

    return { load, check };
}

describe('font loader', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.doUnmock('@tauri-apps/api/core');
        document.head.innerHTML = '';
        existsMock.mockReset();
        existsMock.mockResolvedValue(true);
        joinMock.mockClear();
        mockTauriCommand('get_app_directory_path', 'D:\\TouchAI\\assets\\font');
    });

    it(
        'loads the cached serif font during initialization without waiting for font-ready',
        async () => {
            const { initializeFontLoader } = await import('@/utils/font');

            initializeFontLoader();

            await vi.waitFor(() => expect(fontStyles()).toHaveLength(1));
            const styleText = fontStyleText();
            expect(styleText).toContain("font-family: 'TouchAI Source Han Serif SC'");
            expect(styleText).toContain("format('woff2')");
            expect(styleText).toContain('font-weight: 250 900');
            expect(styleText).toContain('font-display: swap');

            const commandOrder = getTauriInvokeCalls().map((call) => call.cmd);
            expect(commandOrder.indexOf('plugin:event|listen')).toBeLessThan(
                commandOrder.indexOf('get_app_directory_path')
            );
        },
        FONT_TEST_TIMEOUT_MS
    );

    it(
        'resolves the cached font path with Tauri path join before checking existence',
        async () => {
            mockTauriCommand('get_app_directory_path', '/var/lib/touchai/assets/font');
            const { initializeFontLoader } = await import('@/utils/font');

            initializeFontLoader();

            await vi.waitFor(() => {
                expect(joinMock).toHaveBeenCalledWith(
                    '/var/lib/touchai/assets/font',
                    'SourceHanSerifSC-VF.ttf.woff2'
                );
                expect(existsMock).toHaveBeenCalledWith(
                    '/var/lib/touchai/assets/font/SourceHanSerifSC-VF.ttf.woff2'
                );
            });
        },
        FONT_TEST_TIMEOUT_MS
    );

    it(
        'does not inject a missing startup font asset before font-ready arrives',
        async () => {
            existsMock.mockResolvedValue(false);
            const { initializeFontLoader } = await import('@/utils/font');

            initializeFontLoader();
            await waitForFontReadyListener();

            await vi.waitFor(() => expect(existsMock).toHaveBeenCalled());
            expect(fontStyles()).toHaveLength(0);

            await emit(AppEvent.FONT_READY, {});

            await vi.waitFor(() => {
                expect(fontStyles()).toHaveLength(1);
                expect(fontStyleText()).toContain('touchaiFontReload=1');
            });
        },
        FONT_TEST_TIMEOUT_MS
    );

    it(
        'keeps one font-face style when font-ready is delivered more than once',
        async () => {
            const { initializeFontLoader } = await import('@/utils/font');

            initializeFontLoader();
            await waitForFontReadyListener();

            await emit(AppEvent.FONT_READY, {});
            await emit(AppEvent.FONT_READY, {});

            await vi.waitFor(() => {
                expect(fontStyles()).toHaveLength(1);
                expect(fontStyleText()).toContain('touchaiFontReload=2');
            });
        },
        FONT_TEST_TIMEOUT_MS
    );

    it(
        'does not register duplicate font-ready listeners when initialized more than once',
        async () => {
            const { initializeFontLoader } = await import('@/utils/font');

            initializeFontLoader();
            initializeFontLoader();
            initializeFontLoader();
            await waitForFontReadyListener();

            await vi.waitFor(() => expect(fontReadyListenCalls()).toHaveLength(1));
            await emit(AppEvent.FONT_READY, {});

            await vi.waitFor(() => {
                expect(fontStyles()).toHaveLength(1);
                expect(fontStyleText()).toContain('touchaiFontReload=1');
            });
        },
        FONT_TEST_TIMEOUT_MS
    );

    it(
        'can reload the startup font-face rule after the injected style is removed',
        async () => {
            const { initializeFontLoader } = await import('@/utils/font');

            initializeFontLoader();
            await vi.waitFor(() => expect(fontStyles()).toHaveLength(1));

            fontStyles()[0]?.remove();
            initializeFontLoader();

            await vi.waitFor(() => {
                expect(fontStyles()).toHaveLength(1);
                expect(fontStyleText()).not.toContain('touchaiFontReload=');
            });
        },
        FONT_TEST_TIMEOUT_MS
    );

    it(
        'refreshes an early font-face rule after the font file is downloaded',
        async () => {
            const { initializeFontLoader } = await import('@/utils/font');

            initializeFontLoader();
            await waitForFontReadyListener();
            await vi.waitFor(() => expect(fontStyles()).toHaveLength(1));

            const earlyStyle = fontStyles()[0];

            await emit(AppEvent.FONT_READY, {});

            await vi.waitFor(() => {
                const styles = fontStyles();
                expect(styles).toHaveLength(1);
                expect(styles[0]).not.toBe(earlyStyle);
                expect(fontStyleText()).toContain('touchaiFontReload=1');
            });
        },
        FONT_TEST_TIMEOUT_MS
    );

    it(
        'does not let a slower startup load replace a refreshed font-face rule',
        async () => {
            let directoryCallCount = 0;
            let resolveStartupLoad: ((fontDir: string) => void) | undefined;

            mockTauriCommand('get_app_directory_path', () => {
                directoryCallCount += 1;

                if (directoryCallCount === 1) {
                    return new Promise<string>((resolve) => {
                        resolveStartupLoad = resolve;
                    });
                }

                return 'D:\\TouchAI\\assets\\font';
            });

            const { initializeFontLoader } = await import('@/utils/font');

            initializeFontLoader();
            await waitForFontReadyListener();
            await vi.waitFor(() => expect(resolveStartupLoad).toBeTypeOf('function'));

            await emit(AppEvent.FONT_READY, {});
            await vi.waitFor(() => {
                const styles = fontStyles();
                expect(styles).toHaveLength(1);
                expect(fontStyleText()).toContain('touchaiFontReload=1');
            });

            resolveStartupLoad?.('D:\\TouchAI\\assets\\font');
            await vi.waitFor(() => {
                const styles = fontStyles();
                expect(styles).toHaveLength(1);
                expect(fontStyleText()).toContain('touchaiFontReload=1');
            });
        },
        FONT_TEST_TIMEOUT_MS
    );

    it(
        'recovers from a startup path lookup failure when font-ready arrives later',
        async () => {
            const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
            let directoryCallCount = 0;

            mockTauriCommand('get_app_directory_path', () => {
                directoryCallCount += 1;
                if (directoryCallCount === 1) {
                    throw new Error('font directory is not ready');
                }

                return 'D:\\TouchAI\\assets\\font';
            });

            const { initializeFontLoader } = await import('@/utils/font');

            initializeFontLoader();
            await waitForFontReadyListener();
            await vi.waitFor(() => expect(consoleError).toHaveBeenCalled());
            expect(fontStyles()).toHaveLength(0);

            await emit(AppEvent.FONT_READY, {});

            await vi.waitFor(() => {
                expect(fontStyles()).toHaveLength(1);
                expect(fontStyleText()).toContain('touchaiFontReload=1');
            });

            consoleError.mockRestore();
        },
        FONT_TEST_TIMEOUT_MS
    );

    it(
        'appends a reload token with ampersand when the asset URL already has a query string',
        async () => {
            vi.doMock('@tauri-apps/api/core', async (importOriginal) => {
                const actual = await importOriginal<typeof import('@tauri-apps/api/core')>();
                return {
                    ...actual,
                    convertFileSrc: () => 'http://asset.localhost/font.woff2?cache=base',
                };
            });

            const { initializeFontLoader } = await import('@/utils/font');

            initializeFontLoader();
            await waitForFontReadyListener();

            await emit(AppEvent.FONT_READY, {});

            await vi.waitFor(() => {
                expect(fontStyles()).toHaveLength(1);
                expect(fontStyleText()).toContain('&touchaiFontReload=1');
            });
        },
        FONT_TEST_TIMEOUT_MS
    );

    it(
        'verifies the injected font with browser font APIs before reporting readiness',
        async () => {
            const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => {});
            const fontApi = mockFontLoadingApi();
            const fetch = vi.fn().mockResolvedValue({
                ok: true,
                status: 200,
                statusText: 'OK',
                headers: new Headers({ 'content-type': 'font/woff2' }),
            });
            vi.stubGlobal('fetch', fetch);

            const { initializeFontLoader } = await import('@/utils/font');

            initializeFontLoader();

            await vi.waitFor(() => {
                expect(fontApi.load).toHaveBeenCalledWith("16px 'TouchAI Source Han Serif SC'");
                expect(fontApi.check).toHaveBeenCalledWith("16px 'TouchAI Source Han Serif SC'");
                expect(fetch).toHaveBeenCalledWith(expect.stringContaining('SourceHanSerifSC-VF'));
                expect(consoleInfo).toHaveBeenCalledWith(
                    'Source Han Serif font ready:',
                    expect.objectContaining({
                        fontLoaded: true,
                        fetchOk: true,
                        fetchStatus: 200,
                        contentType: 'font/woff2',
                    })
                );
            });

            consoleInfo.mockRestore();
            vi.unstubAllGlobals();
        },
        FONT_TEST_TIMEOUT_MS
    );

    it(
        'retries a transient missing font check before warning',
        async () => {
            const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => {});
            const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            const fontApi = mockFontLoadingApi();
            fontApi.check.mockReturnValueOnce(false).mockReturnValue(true);
            vi.stubGlobal(
                'fetch',
                vi.fn().mockResolvedValue({
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    headers: new Headers({ 'content-type': 'font/woff2' }),
                })
            );

            const { initializeFontLoader } = await import('@/utils/font');

            initializeFontLoader();

            await vi.waitFor(() => {
                expect(fontApi.check).toHaveBeenCalledTimes(2);
                expect(consoleInfo).toHaveBeenCalledWith(
                    'Source Han Serif font ready:',
                    expect.objectContaining({ fontLoaded: true })
                );
            });
            expect(consoleWarn).not.toHaveBeenCalledWith(
                'Source Han Serif font diagnostics:',
                expect.objectContaining({ fontLoaded: false })
            );

            consoleInfo.mockRestore();
            consoleWarn.mockRestore();
            vi.unstubAllGlobals();
        },
        FONT_TEST_TIMEOUT_MS
    );
});
