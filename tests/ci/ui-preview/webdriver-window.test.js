import { afterEach, describe, expect, it, vi } from 'vitest';

import { waitForBridge } from '../../../.github/ui-preview/lib/runtime.mjs';
import { createSession, Session } from '../../../.github/ui-preview/lib/webdriver.mjs';

const MAIN_URL = 'tauri://localhost/index.html#/';
const TRAY_URL = 'tauri://localhost/index.html#/tray-menu';

function controlledDriver({ mainReadyAfter = 2, bridgeAppears = true } = {}) {
    return {
        sessionId: 'fake-session',
        currentWindow: null,
        polls: 0,
        routes: new Map([
            ['tray-menu', TRAY_URL],
            ['main', 'tauri://localhost/index.html'],
        ]),
        bridges: new Map([
            ['tray-menu', false],
            ['main', false],
        ]),
        async windowHandles() {
            return ['tray-menu', 'main'];
        },
        async switchTo(handle) {
            if (!this.routes.has(handle)) {
                throw new Error(`unknown window ${handle}`);
            }
            this.currentWindow = handle;
        },
        async currentUrl() {
            return this.routes.get(this.currentWindow);
        },
        async execute(script) {
            if (!script.includes('__TOUCHAI_E2E__')) {
                throw new Error(`unexpected script: ${script}`);
            }

            this.polls += 1;
            if (this.polls > mainReadyAfter) {
                this.routes.set('main', MAIN_URL);
                this.bridges.set('main', bridgeAppears);
            }

            return Boolean(this.bridges.get(this.currentWindow));
        },
        async quit() {},
    };
}

function useDriver(driver) {
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
            ok: true,
            json: async () => ({ value: { sessionId: 'fake-session' } }),
        }))
    );
    vi.spyOn(Session.prototype, 'windowHandles').mockImplementation(() =>
        driver.windowHandles.call(driver)
    );
    vi.spyOn(Session.prototype, 'switchTo').mockImplementation(function (handle) {
        this.currentWindow = handle;
        return driver.switchTo.call(driver, handle);
    });
    vi.spyOn(Session.prototype, 'currentUrl').mockImplementation(() =>
        driver.currentUrl.call(driver)
    );
    vi.spyOn(Session.prototype, 'execute').mockImplementation((script) =>
        driver.execute.call(driver, script)
    );
}

describe('user starts the preview before the main route is ready', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('user gets the main window after its route becomes ready while the tray is already open', async () => {
        const driver = controlledDriver();
        useDriver(driver);

        const created = await createSession({ port: 4445, driver: 'embedded' });

        await expect(waitForBridge(created, 2000)).resolves.toBe(true);
        expect(created.currentWindow).toBe('main');
        expect(driver.bridges.get('tray-menu')).toBe(false);
    });

    it('user gets the selected window and routes when the main bridge never appears', async () => {
        const driver = controlledDriver({ mainReadyAfter: 0, bridgeAppears: false });
        useDriver(driver);
        const created = await createSession({ port: 4445, driver: 'embedded' });

        await expect(waitForBridge(created, 50)).rejects.toThrow(
            /window main; handles: main; routes: main=tauri:\/\/localhost\/index\.html/
        );
    });
});
