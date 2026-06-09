import { openSettingsWindow } from '../helpers/openSettingsWindow.js';

describe('TouchAI settings memory acceptance', () => {
    it('persists a completed memory when the user switches sections immediately', async () => {
        const { mainWindowHandle } = await openSettingsWindow();
        const settingsView = await $("[data-testid='settings-view']");
        const memoryNav = await $("[data-testid='settings-nav-memory']");
        const generalNav = await $("[data-testid='settings-nav-general']");

        await settingsView.waitForDisplayed();
        await memoryNav.waitForDisplayed();
        await memoryNav.click();

        const addButton = await $("[data-testid='settings-memory-add-button']");
        await addButton.waitForDisplayed();
        await addButton.click();

        const titleInput = await $("[data-testid='settings-memory-title-input']");
        const applicabilityInput = await $("[data-testid='settings-memory-applicability-input']");
        const contentInput = await $("[data-testid='settings-memory-content-input']");

        await titleInput.waitForDisplayed();
        await titleInput.setValue('Desktop workflow');
        await applicabilityInput.setValue('When TouchAI settings or tray flows matter');
        await contentInput.setValue(
            'TouchAI is a desktop agent. Verify settings and tray behavior before answering.'
        );

        await generalNav.click();

        const generalSection = await $("[data-testid='settings-general-section']");
        await generalSection.waitForDisplayed();

        await memoryNav.click();
        const persistedTitleInput = await $("[data-testid='settings-memory-title-input']");
        const persistedApplicabilityInput = await $(
            "[data-testid='settings-memory-applicability-input']"
        );
        const persistedContentInput = await $("[data-testid='settings-memory-content-input']");
        await persistedTitleInput.waitForDisplayed();

        await browser.waitUntil(async () => {
            return (await persistedTitleInput.getValue()) === 'Desktop workflow';
        });
        await browser.waitUntil(async () => {
            return (
                (await persistedApplicabilityInput.getValue()) ===
                'When TouchAI settings or tray flows matter'
            );
        });
        await browser.waitUntil(async () => {
            return (
                (await persistedContentInput.getValue()) ===
                'TouchAI is a desktop agent. Verify settings and tray behavior before answering.'
            );
        });

        const memoryItems = await $$("[data-testid^='settings-memory-item-']");
        if (memoryItems.length !== 1) {
            throw new Error(
                `Expected exactly one persisted memory item, received ${memoryItems.length}.`
            );
        }

        await browser.closeWindow();
        await browser.switchToWindow(mainWindowHandle);
    });
});
