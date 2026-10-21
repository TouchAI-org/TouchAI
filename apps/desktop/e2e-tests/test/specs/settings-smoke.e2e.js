describe('TouchAI settings smoke', () => {
    it('opens the settings window and persists the start-minimized toggle', async () => {
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

        const settingsView = await $("[data-testid='settings-view']");
        const generalSection = await $("[data-testid='settings-general-section']");
        const startMinimizedToggle = await $("[data-testid='settings-start-minimized-toggle']");

        await settingsView.waitForDisplayed();
        await generalSection.waitForDisplayed();

        // ui/Switch 用 role="switch" + aria-checked（正确的开关语义），
        // 不再是原先手写 <button> 的 aria-pressed。
        const initialPressed = await startMinimizedToggle.getAttribute('aria-checked');

        await startMinimizedToggle.click();
        await browser.waitUntil(async () => {
            return (await startMinimizedToggle.getAttribute('aria-checked')) !== initialPressed;
        });

        await startMinimizedToggle.click();
        await browser.waitUntil(async () => {
            return (await startMinimizedToggle.getAttribute('aria-checked')) === initialPressed;
        });

        await browser.closeWindow();
        await browser.switchToWindow(mainWindowHandle);
    });
});
