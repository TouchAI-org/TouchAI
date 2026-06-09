import { openSettingsWindow } from '../helpers/openSettingsWindow.js';

describe('TouchAI settings smoke', () => {
    it('opens the settings window and persists the start-minimized toggle', async () => {
        const { mainWindowHandle } = await openSettingsWindow();

        const settingsView = await $("[data-testid='settings-view']");
        const generalSection = await $("[data-testid='settings-general-section']");
        const startMinimizedToggle = await $("[data-testid='settings-start-minimized-toggle']");

        await settingsView.waitForDisplayed();
        await generalSection.waitForDisplayed();

        const initialPressed = await startMinimizedToggle.getAttribute('aria-pressed');

        await startMinimizedToggle.click();
        await browser.waitUntil(async () => {
            return (await startMinimizedToggle.getAttribute('aria-pressed')) !== initialPressed;
        });

        await startMinimizedToggle.click();
        await browser.waitUntil(async () => {
            return (await startMinimizedToggle.getAttribute('aria-pressed')) === initialPressed;
        });

        await browser.closeWindow();
        await browser.switchToWindow(mainWindowHandle);
    });
});
