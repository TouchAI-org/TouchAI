/**
 * User flows in the settings window: opening it, changing a persisted
 * preference, moving between sections, and finding a setting by search.
 */
import {
    assertVisible,
    callE2eBridge,
    getAriaChecked,
    switchToWindowContaining,
    toggleSwitch,
    waitForE2eBridge,
    waitForTestIdDisplayed,
} from '../support/desktop.js';

async function openSettingsWindow() {
    await waitForE2eBridge();
    const mainWindowHandle = await browser.getWindowHandle();

    await callE2eBridge('openSettingsWindow');
    await switchToWindowContaining('/settings');
    await waitForTestIdDisplayed('settings-view');

    return mainWindowHandle;
}

async function closeSettingsAndReturn(mainWindowHandle) {
    await browser.closeWindow();
    await browser.switchToWindow(mainWindowHandle);
}

describe('user opens the settings window', () => {
    it('user sees the general settings section on first open', async () => {
        const mainWindowHandle = await openSettingsWindow();

        const settingsView = await waitForTestIdDisplayed('settings-view');
        const generalSection = await waitForTestIdDisplayed('settings-general-section');

        assertVisible(await settingsView.isDisplayed(), 'The settings window was not visible.');
        assertVisible(await generalSection.isDisplayed(), 'The general section was not visible.');

        await closeSettingsAndReturn(mainWindowHandle);
    });
});

describe('user changes a persisted preference', () => {
    it('user sees the start-minimized switch flip when clicked', async () => {
        const mainWindowHandle = await openSettingsWindow();
        const toggle = await waitForTestIdDisplayed('settings-start-minimized-toggle');

        const before = await toggleSwitch(toggle);
        const after = await getAriaChecked(toggle);

        if (after === before) {
            throw new Error(
                `The start-minimized switch stayed at aria-checked="${before}" after a click.`
            );
        }

        // Restore the preference so the remaining specs start from a known state.
        await toggleSwitch(toggle);

        if ((await getAriaChecked(toggle)) !== before) {
            throw new Error('The start-minimized switch did not return to its original state.');
        }

        await closeSettingsAndReturn(mainWindowHandle);
    });

    it('user sees the saved switch position after reopening settings', async () => {
        const mainWindowHandle = await openSettingsWindow();
        const toggle = await waitForTestIdDisplayed('settings-start-minimized-toggle');

        const original = await getAriaChecked(toggle);
        await toggleSwitch(toggle);
        const changed = await getAriaChecked(toggle);

        await closeSettingsAndReturn(mainWindowHandle);

        const reopenedMainHandle = await openSettingsWindow();
        const reopenedToggle = await waitForTestIdDisplayed('settings-start-minimized-toggle');
        const persisted = await getAriaChecked(reopenedToggle);

        if (persisted !== changed) {
            throw new Error(
                `The start-minimized preference was not persisted: expected aria-checked="${changed}", got "${persisted}".`
            );
        }

        await toggleSwitch(reopenedToggle);

        if ((await getAriaChecked(reopenedToggle)) !== original) {
            throw new Error('The start-minimized switch did not return to its original state.');
        }

        await closeSettingsAndReturn(reopenedMainHandle);
    });
});

describe('user moves around the settings window', () => {
    it('user sees the shortcuts section when choosing it in the sidebar', async () => {
        const mainWindowHandle = await openSettingsWindow();

        const shortcutsNav = await waitForTestIdDisplayed('settings-nav-shortcuts');
        await shortcutsNav.click();

        const shortcutsSection = await waitForTestIdDisplayed('settings-shortcuts-section');
        assertVisible(
            await shortcutsSection.isDisplayed(),
            'The shortcuts section was not visible after navigating to it.'
        );

        await closeSettingsAndReturn(mainWindowHandle);
    });

    it('user finds a setting by typing into settings search', async () => {
        const mainWindowHandle = await openSettingsWindow();

        const searchInput = await waitForTestIdDisplayed('settings-search-input');
        await searchInput.click();
        await searchInput.addValue('minimiz');

        const results = await waitForTestIdDisplayed('settings-search-results');
        assertVisible(await results.isDisplayed(), 'Settings search showed no result list.');

        const firstResult = await results.$('[role="option"]');
        await firstResult.waitForDisplayed();
        assertVisible(
            await firstResult.isDisplayed(),
            'Settings search showed an empty result list.'
        );

        await closeSettingsAndReturn(mainWindowHandle);
    });
});
