export async function openSettingsWindow() {
    const mainWindowHandle = await browser.getWindowHandle();
    let settingsHandle = null;

    await browser.waitUntil(async () => {
        return browser.execute(() => Boolean(window.__TOUCHAI_E2E__));
    });

    await browser
        .executeAsync((done) => {
            window.__TOUCHAI_E2E__
                .openSettingsWindow()
                .then(() => done({ ok: true }))
                .catch((error) => done({ ok: false, error: String(error) }));
        })
        .then((result) => {
            if (!result?.ok) {
                throw new Error(
                    `Failed to open settings window: ${result?.error ?? 'unknown error'}`
                );
            }
        });

    await browser.waitUntil(async () => {
        const handles = await browser.getWindowHandles();
        for (const handle of handles) {
            if (handle === mainWindowHandle) {
                continue;
            }

            await browser.switchToWindow(handle);
            const currentUrl = await browser.getUrl();
            if (currentUrl.includes('/settings')) {
                settingsHandle = handle;
                return true;
            }
        }

        await browser.switchToWindow(mainWindowHandle);
        return false;
    });

    if (!settingsHandle) {
        throw new Error('Unable to locate settings window handle.');
    }

    await browser.switchToWindow(settingsHandle);
    return { mainWindowHandle, settingsHandle };
}
