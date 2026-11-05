import { AppEvent } from '@services/EventService';
import { emit } from '@tauri-apps/api/event';
import { getTauriInvokeCalls, interceptTauriInvoke, mockTauriCommand } from '@tests/utils/tauri';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const existsMock = vi.hoisted(() => vi.fn(async () => true));
const readFileMock = vi.hoisted(() => vi.fn(async () => new Uint8Array([0x77, 0x4f, 0x46, 0x32])));
vi.mock('@tauri-apps/plugin-fs', () => ({
    exists: existsMock,
    readFile: readFileMock,
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
    const add = vi.fn();
    const deleteFace = vi.fn();

    Object.defineProperty(document, 'fonts', {
        configurable: true,
        value: { load, check, add, delete: deleteFace },
    });

    return { load, check, add, delete: deleteFace };
}

function stubFontFaceLoader() {
    const createdFaces: Array<{
        family: string;
        source: FontFaceSource;
        descriptors: FontFaceDescriptors;
    }> = [];
    const load = vi.fn().mockResolvedValue(undefined);

    class FontFaceStub {
        readonly load = load;

        constructor(family: string, source: FontFaceSource, descriptors: FontFaceDescriptors = {}) {
            createdFaces.push({ family, source, descriptors });
        }
    }

    vi.stubGlobal('FontFace', FontFaceStub);

    return { createdFaces, load };
}

describe('user reads text in the bundled serif font', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.doUnmock('@tauri-apps/api/core');
        document.head.innerHTML = '';
        existsMock.mockReset();
        existsMock.mockResolvedValue(true);
        readFileMock.mockReset();
        readFileMock.mockResolvedValue(new Uint8Array([0x77, 0x4f, 0x46, 0x32]));
        mockTauriCommand('get_app_directory_path', 'D:\\TouchAI\\assets\\font');
        mockTauriCommand('plugin:path|join', (payload?: unknown) => {
            const paths = (payload as { paths?: string[] } | undefined)?.paths ?? [];
            return paths.join('\\');
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it(
        'user loads the cached serif font during initialization without waiting for font-ready',
        async () => {
            const { initializeFontLoader } = await import('@/utils/font');

            initializeFontLoader();

            await vi.waitFor(() => expect(fontStyles()).toHaveLength(1));
            const styleText = fontStyleText();
            expect(styleText).toContain("font-family: 'TouchAI Source Han Serif SC'");
            expect(styleText).toContain("format('woff2-variations')");
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
        'user still gets the cached font when the font-ready listener cannot be registered',
        async () => {
            interceptTauriInvoke((call, next) => {
                if (call.cmd === 'plugin:event|listen') {
                    throw new Error('listener unavailable');
                }

                return next();
            });
            const { initializeFontLoader } = await import('@/utils/font');

            initializeFontLoader();

            await vi.waitFor(() => expect(fontStyles()).toHaveLength(1));
        },
        FONT_TEST_TIMEOUT_MS
    );

    it(
        'user does not inject a missing startup font asset before font-ready arrives',
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
        'user keeps one font-face style when font-ready is delivered more than once',
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
        'user does not register duplicate font-ready listeners when initialized more than once',
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
        'user can reload the startup font-face rule after the injected style is removed',
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
        'user still gets the serif font when the style is removed while it is being verified',
        async () => {
            const appendChild = document.head.appendChild.bind(document.head);
            let removedOnce = false;
            const appendSpy = vi
                .spyOn(document.head, 'appendChild')
                .mockImplementation((node: Node) => {
                    const appended = appendChild(node);

                    if (
                        !removedOnce &&
                        node instanceof HTMLStyleElement &&
                        node.matches(FONT_STYLE_SELECTOR)
                    ) {
                        removedOnce = true;
                        node.remove();
                    }

                    return appended;
                });

            const { initializeFontLoader } = await import('@/utils/font');

            initializeFontLoader();

            await vi.waitFor(() => {
                expect(appendSpy).toHaveBeenCalledTimes(2);
                expect(fontStyles()).toHaveLength(1);
            });
        },
        FONT_TEST_TIMEOUT_MS
    );

    it(
        'user refreshes an early font-face rule after the font file is downloaded',
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
        'user does not let a slower startup load replace a refreshed font-face rule',
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
        'user recovers from a startup path lookup failure when font-ready arrives later',
        async () => {
            // resetModules gives the font module a fresh ObservabilityService,
            // so the spy has to come from the same instance.
            const { log: fontLog } = await import('@services/ObservabilityService');
            const consoleError = vi.spyOn(fontLog, 'error').mockImplementation(() => {});
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
        'user appends a reload token with ampersand when the asset URL already has a query string',
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
        'user gets a font the browser can actually render, not just a declared one',
        async () => {
            const fontApi = mockFontLoadingApi();
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
                expect(fontApi.load).toHaveBeenCalledWith("16px 'TouchAI Source Han Serif SC'");
                expect(fontApi.check).toHaveBeenCalledWith("16px 'TouchAI Source Han Serif SC'");
                expect(fontStyles()).toHaveLength(1);
                expect(readFileMock).not.toHaveBeenCalled();
            });

            vi.unstubAllGlobals();
        },
        FONT_TEST_TIMEOUT_MS
    );

    it(
        'user still gets the font when the first availability check is a false negative',
        async () => {
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
                expect(fontStyles()).toHaveLength(1);
            });

            vi.unstubAllGlobals();
        },
        FONT_TEST_TIMEOUT_MS
    );

    it(
        'user still gets the bundled serif face when the asset protocol cannot load it',
        async () => {
            const fontApi = mockFontLoadingApi(false);
            const fontBytes = new Uint8Array([0x77, 0x4f, 0x46, 0x32]);
            readFileMock.mockResolvedValue(fontBytes);
            vi.stubGlobal(
                'fetch',
                vi.fn().mockRejectedValue(new Error(' A network error occurred.'))
            );
            const { createdFaces, load } = stubFontFaceLoader();

            const { initializeFontLoader } = await import('@/utils/font');

            initializeFontLoader();

            await vi.waitFor(() => {
                expect(readFileMock).toHaveBeenCalledWith(
                    expect.stringContaining('SourceHanSerifSC-VF.ttf.woff2')
                );
                expect(load).toHaveBeenCalledTimes(1);
                expect(fontApi.add).toHaveBeenCalledTimes(1);
            });

            expect(createdFaces).toEqual([
                {
                    family: 'TouchAI Source Han Serif SC',
                    source: fontBytes,
                    descriptors: {
                        weight: '250 900',
                        style: 'normal',
                        display: 'swap',
                    },
                },
            ]);
        },
        FONT_TEST_TIMEOUT_MS
    );

    it(
        'user switches back to the asset face after a font-ready refresh',
        async () => {
            const fontApi = mockFontLoadingApi(false);
            vi.stubGlobal(
                'fetch',
                vi.fn().mockRejectedValue(new Error(' A network error occurred.'))
            );
            stubFontFaceLoader();

            const { initializeFontLoader } = await import('@/utils/font');

            initializeFontLoader();
            await waitForFontReadyListener();
            await vi.waitFor(() => expect(fontApi.add).toHaveBeenCalledTimes(1));
            const fallbackFace = fontApi.add.mock.calls[0]?.[0];

            fontApi.check.mockReturnValue(true);
            await emit(AppEvent.FONT_READY, {});

            await vi.waitFor(() => {
                expect(fontStyles()).toHaveLength(1);
                expect(fontStyleText()).toContain('touchaiFontReload=1');
                expect(fontApi.delete).toHaveBeenCalledWith(fallbackFace);
            });
        },
        FONT_TEST_TIMEOUT_MS
    );

    it(
        'user does not let a slower failed startup font replace a refreshed face',
        async () => {
            const fontApi = mockFontLoadingApi(true);
            let rejectStartupLoad: ((error: Error) => void) | undefined;
            const firstLoad = new Promise<never[]>((_, reject) => {
                rejectStartupLoad = reject;
            });
            fontApi.load.mockReturnValueOnce(firstLoad);
            vi.stubGlobal(
                'fetch',
                vi.fn().mockResolvedValue({
                    ok: true,
                    status: 200,
                    statusText: 'OK',
                    headers: new Headers({ 'content-type': 'font/woff2' }),
                })
            );
            stubFontFaceLoader();
            const { log: fontLog } = await import('@services/ObservabilityService');
            const warn = vi.spyOn(fontLog, 'warn').mockImplementation(() => {});

            const { initializeFontLoader } = await import('@/utils/font');

            initializeFontLoader();
            await waitForFontReadyListener();
            await vi.waitFor(() => expect(fontApi.load).toHaveBeenCalledTimes(1));

            await emit(AppEvent.FONT_READY, {});
            await vi.waitFor(() => {
                expect(fontStyles()).toHaveLength(1);
                expect(fontStyleText()).toContain('touchaiFontReload=1');
            });

            rejectStartupLoad?.(new Error(' A network error occurred.'));
            await vi.waitFor(() => {
                expect(warn).toHaveBeenCalledWith(
                    'Source Han Serif font diagnostics:',
                    expect.objectContaining({ error: ' A network error occurred.' })
                );
            });
            expect(readFileMock).not.toHaveBeenCalled();
        },
        FONT_TEST_TIMEOUT_MS
    );
});
