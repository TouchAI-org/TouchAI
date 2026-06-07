export async function waitForE2eBridge() {
    await browser.waitUntil(async () => browser.execute(() => Boolean(window.__TOUCHAI_E2E__)), {
        timeoutMsg: 'TouchAI E2E bridge was not installed in the main window.',
    });
}

async function readWindowSnapshot() {
    const url = await browser.getUrl().catch((error) => `unavailable: ${String(error)}`);
    const dom = await browser
        .execute(() => ({
            bodyText: document.body?.innerText?.replace(/\s+/g, ' ').trim().slice(0, 500) ?? '',
            hash: window.location.hash,
            href: window.location.href,
            readyState: document.readyState,
            testIds: Array.from(document.querySelectorAll('[data-testid]'))
                .map((element) => element.getAttribute('data-testid'))
                .filter(Boolean)
                .slice(0, 80),
        }))
        .catch((error) => ({
            bodyText: '',
            hash: '',
            href: '',
            readyState: `unavailable: ${String(error)}`,
            testIds: [],
        }));

    return { url, ...dom };
}

async function hasElementByTestId(testId) {
    return browser.execute(
        (id) => Boolean(document.querySelector(`[data-testid='${id}']`)),
        testId
    );
}

async function readLocationHash() {
    return browser.execute(() => window.location.hash).catch(() => '');
}

async function switchToMainWindowWithE2eBridge() {
    const originalHandle = await browser.getWindowHandle().catch(() => null);
    const handles = await browser.getWindowHandles();

    for (const handle of handles) {
        await browser.switchToWindow(handle);
        const hasBridge = await browser
            .execute(() => Boolean(window.__TOUCHAI_E2E__))
            .catch(() => false);
        if (hasBridge) {
            return handle;
        }
    }

    if (originalHandle) {
        await browser.switchToWindow(originalHandle).catch(() => undefined);
    }

    throw new Error('Unable to locate main window with TouchAI E2E bridge.');
}

async function describeOpenWindows() {
    const activeHandle = await browser.getWindowHandle().catch(() => null);
    const handles = await browser.getWindowHandles();
    const snapshots = [];

    for (const handle of handles) {
        await browser.switchToWindow(handle);
        snapshots.push({
            handle,
            ...(await readWindowSnapshot()),
        });
    }

    if (activeHandle) {
        await browser.switchToWindow(activeHandle).catch(() => undefined);
    }

    return snapshots;
}

export async function openSettingsWindowFromMain() {
    const existingHandles = new Set(await browser.getWindowHandles());
    const mainWindowHandle = await switchToMainWindowWithE2eBridge();

    await waitForE2eBridge();

    const result = await browser.executeAsync((done) => {
        window.__TOUCHAI_E2E__
            .openSettingsWindow()
            .then(() => done({ ok: true }))
            .catch((error) => done({ ok: false, error: String(error) }));
    });

    if (!result?.ok) {
        throw new Error(`Failed to open settings window: ${result?.error ?? 'unknown error'}`);
    }

    let settingsHandle = null;
    try {
        await browser.waitUntil(
            async () => {
                const handles = await browser.getWindowHandles();
                const candidateHandles = [
                    ...handles.filter((handle) => !existingHandles.has(handle)),
                    ...handles.filter((handle) => existingHandles.has(handle)),
                ];

                for (const handle of candidateHandles) {
                    if (handle === mainWindowHandle) {
                        continue;
                    }

                    await browser.switchToWindow(handle);
                    const currentHash = await readLocationHash();
                    if (currentHash !== '#/settings') {
                        continue;
                    }

                    const settingsViewReady = await hasElementByTestId('settings-view');
                    if (settingsViewReady) {
                        settingsHandle = handle;
                        return true;
                    }
                }

                await browser.switchToWindow(mainWindowHandle);
                return false;
            },
            {
                timeout: 30000,
                timeoutMsg: `Unable to locate settings window with mounted settings view. Known handles before open: ${[
                    ...existingHandles,
                ].join(', ')}`,
            }
        );
    } catch (error) {
        const windows = await describeOpenWindows();
        await browser.switchToWindow(mainWindowHandle).catch(() => undefined);
        throw new Error(
            `Unable to locate settings window with mounted settings view. ${String(
                error
            )}\nOpen windows: ${JSON.stringify(windows, null, 2)}`,
            { cause: error }
        );
    }

    if (!settingsHandle) {
        throw new Error('Unable to locate settings window handle.');
    }

    await browser.switchToWindow(settingsHandle);
    return { mainWindowHandle, settingsHandle };
}

export async function closeSettingsWindowAndReturn(mainWindowHandle) {
    if (mainWindowHandle) {
        await browser.closeWindow();
        await browser.switchToWindow(mainWindowHandle);
        return;
    }

    const handles = await browser.getWindowHandles();
    for (const handle of handles) {
        await browser.switchToWindow(handle);
        const hasBridge = await browser
            .execute(() => Boolean(window.__TOUCHAI_E2E__))
            .catch(() => false);
        if (hasBridge) {
            return;
        }
    }
}

export async function withSettingsWindow(run) {
    const { mainWindowHandle, settingsHandle } = await openSettingsWindowFromMain();

    try {
        return await run({ mainWindowHandle, settingsHandle });
    } finally {
        await closeSettingsWindowAndReturn(mainWindowHandle);
    }
}

export async function expectDisplayedByTestId(testId, options = {}) {
    const timeout = options.timeout ?? 30000;
    const element = await $(`[data-testid='${testId}']`);
    try {
        await element.waitForExist({ timeout });
        await element.waitForDisplayed({ timeout });
    } catch (error) {
        const windows = await describeOpenWindows();
        throw new Error(
            `Expected [data-testid='${testId}'] to be displayed. ${String(
                error
            )}\nOpen windows: ${JSON.stringify(windows, null, 2)}`,
            { cause: error }
        );
    }
    return element;
}
