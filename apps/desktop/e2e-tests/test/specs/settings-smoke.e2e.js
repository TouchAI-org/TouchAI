import { expectDisplayedByTestId, withSettingsWindow } from '../support/windows.js';

describe('TouchAI settings smoke', () => {
    it('opens settings, persists launch preferences, and navigates critical sections', async () => {
        await withSettingsWindow(async () => {
            const settingsView = await expectDisplayedByTestId('settings-view');
            const generalSection = await expectDisplayedByTestId('settings-general-section');
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

            const sectionChecks = [
                ['ai-services', 'settings-ai-services-panel'],
                ['built-in-tools', 'settings-built-in-tools-panel'],
                ['mcp-tools', 'settings-mcp-tools-panel'],
                ['data-management', 'settings-data-history-list'],
                ['general', 'settings-general-section'],
            ];

            for (const [section, expectedTestId] of sectionChecks) {
                const navItem = await $(`[data-testid='settings-nav-${section}']`);
                await navItem.waitForDisplayed();
                await navItem.click();
                await expectDisplayedByTestId(expectedTestId);
            }
        });
    });
});
