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
    useInterfaceLanguage,
    visualMismatchTolerance,
    waitForE2eBridge,
    waitForTestIdDisplayed,
} from '../support/desktop.js';

describe('user works in the settings window', () => {
    let mainWindowHandle;

    before(async () => {
        await waitForE2eBridge();
        // The settings window loads its language from the persisted setting, so it
        // has to be pinned before the window opens.
        await useInterfaceLanguage();
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

        // Visual regression runs before the search test, because that one types a
        // query and the sidebar hides the section list while a query is active.
        //
        // The window size is pinned rather than inherited from the app default: a
        // GitHub-hosted runner only has a 1024x768 desktop, so the default 1120px
        // window would be clamped there and the layout would reflow.
        it('user sees every settings section keep its layout after choosing it in the sidebar', async () => {
            await browser.setWindowSize(1000, 700);
            await browser.pause(500);

            const tolerance = await visualMismatchTolerance();

            const contentShell = await waitForTestIdDisplayed('settings-content-shell');
            const sections = [
                { id: 'general', testId: 'settings-general-section' },
                { id: 'ai-services', testId: 'settings-ai-services-panel' },
                { id: 'built-in-tools', testId: 'settings-built-in-tools-panel' },
                { id: 'search', testId: 'settings-search-section' },
            ];

            for (const section of sections) {
                const navItem = await waitForTestIdDisplayed(`settings-nav-${section.id}`);
                await navItem.click();

                await waitForTestIdDisplayed(section.testId);
                await contentShell.waitForDisplayed();

                // Let the section transition and its local data settle, then reset
                // the scroll position so the screenshot always starts at the top.
                await browser.pause(700);
                await browser.execute(() => {
                    const scrollContainer = document.querySelector(
                        "[data-testid='settings-content-shell'] .settings-scrollbar"
                    );
                    if (scrollContainer) {
                        scrollContainer.scrollTop = 0;
                    }
                });
                await browser.pause(150);

                // Baselines are stored at CSS size, so the 100% runner compares at
                // the strict budget. A scaled machine resamples and gets the wider
                // one; see `visualMismatchTolerance`.
                await expect(contentShell).toMatchElementSnapshot(
                    `settings-${section.id}`,
                    tolerance
                );
            }
        });

        it('user finds a setting by typing into settings search', async () => {
            const searchInput = await waitForTestIdDisplayed('settings-search-input');
            await searchInput.click();
            // The suite pins the interface language, so this matches the start-minimized
            // row deterministically instead of depending on the machine locale.
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
        it('user finds a setting by its English name while the interface is in Chinese', async () => {
            const searchInput = await waitForTestIdDisplayed('settings-search-input');
            await searchInput.click();
            await searchInput.clearValue();

            // The interface language is the app default, so this is the cross-language case:
            // an English query must still find the row that is displayed in Chinese.
            await searchInput.addValue('start minimized');

            const results = await waitForTestIdDisplayed('settings-search-results');
            const matched = await results.$('[role="option"]');
            await matched.waitForDisplayed();
            assertVisible(
                await matched.isDisplayed(),
                'Settings search found nothing for an English name on a Chinese interface.'
            );
        });

        it('user gets no options for a word that appears in no translation', async () => {
            const searchInput = await waitForTestIdDisplayed('settings-search-input');
            await searchInput.click();
            // Typing appends to whatever is there, so this query is deliberately a superset
            // that no setting can match.
            await searchInput.addValue(' zzzz-not-a-setting');

            const results = await waitForTestIdDisplayed('settings-search-results');
            await browser.waitUntil(
                async () => (await results.$$('[role="option"]')).length === 0,
                { timeoutMsg: 'Settings search still listed options for a word nothing matches.' }
            );
        });
    });
});
