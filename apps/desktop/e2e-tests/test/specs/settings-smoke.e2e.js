/**
 * User flows in the settings window: opening it, changing a persisted
 * preference, moving between sections, and finding a setting by search.
 *
 * The window is opened once for the whole spec and closed at the end. Reopening
 * it inside one WebDriver session does not surface a new window handle: the app
 * reuses the existing `settings` window (see
 * apps/desktop/src-tauri/src/core/window/settings/mod.rs), and the driver keeps
 * addressing the handle it closed. Persistence is therefore proven by leaving
 * the section and coming back, which reads the value from the settings store
 * rather than from component-local state.
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

describe('user works in the settings window', () => {
    let mainWindowHandle;

    before(async () => {
        await waitForE2eBridge();
        mainWindowHandle = await browser.getWindowHandle();

        await callE2eBridge('openSettingsWindow');
        await switchToWindowContaining('/settings');
        await waitForTestIdDisplayed('settings-view');
    });

    after(async () => {
        await browser.closeWindow();
        await browser.switchToWindow(mainWindowHandle);
    });

    describe('user opens the settings window', () => {
        it('user sees the general settings section on first open', async () => {
            const settingsView = await waitForTestIdDisplayed('settings-view');
            const generalSection = await waitForTestIdDisplayed('settings-general-section');

            assertVisible(await settingsView.isDisplayed(), 'The settings window was not visible.');
            assertVisible(
                await generalSection.isDisplayed(),
                'The general section was not visible.'
            );
        });
    });

    describe('user changes a persisted preference', () => {
        it('user sees the start-minimized switch flip when clicked', async () => {
            const toggle = await waitForTestIdDisplayed('settings-start-minimized-toggle');
            const before = await toggleSwitch(toggle);

            if ((await getAriaChecked(toggle)) === before) {
                throw new Error(
                    `The start-minimized switch stayed at aria-checked="${before}" after a click.`
                );
            }

            // Restore the preference so the remaining tests start from a known state.
            await toggleSwitch(toggle);

            if ((await getAriaChecked(toggle)) !== before) {
                throw new Error('The start-minimized switch did not return to its original state.');
            }
        });

        it('user keeps the chosen switch position after leaving the section', async () => {
            const toggle = await waitForTestIdDisplayed('settings-start-minimized-toggle');
            const original = await getAriaChecked(toggle);

            await toggleSwitch(toggle);
            const changed = await getAriaChecked(toggle);

            const shortcutsNav = await waitForTestIdDisplayed('settings-nav-shortcuts');
            await shortcutsNav.click();
            await waitForTestIdDisplayed('settings-shortcuts-section');

            const generalNav = await waitForTestIdDisplayed('settings-nav-general');
            await generalNav.click();
            await waitForTestIdDisplayed('settings-general-section');

            const restoredToggle = await waitForTestIdDisplayed('settings-start-minimized-toggle');
            const persisted = await getAriaChecked(restoredToggle);

            if (persisted !== changed) {
                throw new Error(
                    `The start-minimized preference was not kept: expected aria-checked="${changed}", got "${persisted}".`
                );
            }

            await toggleSwitch(restoredToggle);

            if ((await getAriaChecked(restoredToggle)) !== original) {
                throw new Error('The start-minimized switch did not return to its original state.');
            }
        });
    });

    describe('user moves around the settings window', () => {
        it('user sees the shortcuts section when choosing it in the sidebar', async () => {
            const shortcutsNav = await waitForTestIdDisplayed('settings-nav-shortcuts');
            await shortcutsNav.click();

            const shortcutsSection = await waitForTestIdDisplayed('settings-shortcuts-section');
            assertVisible(
                await shortcutsSection.isDisplayed(),
                'The shortcuts section was not visible after navigating to it.'
            );
        });

        it('user finds a setting by typing into settings search', async () => {
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
        });
    });
});
