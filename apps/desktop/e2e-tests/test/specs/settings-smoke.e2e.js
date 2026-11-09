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
    SETTINGS_WINDOW_DEFAULT_SIZE,
    switchToWindowContaining,
    switchToWindowWithE2eBridge,
    toggleSwitch,
    useInterfaceLanguage,
    useProductFont,
    visualMismatchTolerance,
    waitForE2eBridge,
    waitForTestIdDisplayed,
} from '../support/desktop.js';

describe('user works in the settings window', () => {
    let mainWindowHandle;

    before(async () => {
        await waitForE2eBridge();
        // The settings window loads its language from the persisted setting, so it
        // has to be pinned before the window opens. The font follows the same rule:
        // it is registered before the window exists so the first paint is already
        // correct.
        await useInterfaceLanguage();
        await useProductFont();
        mainWindowHandle = await browser.getWindowHandle();

        await callE2eBridge('openSettingsWindow');
        await switchToWindowContaining('/settings');
        await waitForTestIdDisplayed('settings-view');

        // The settings window is a separate document with its own font loader, so the
        // assertion above only proves the main window is painting the product face. It
        // has to run again here, before any baseline is captured, or the settings
        // screenshots could record fallback glyphs while this spec stayed green.
        await useProductFont();
    });

    after(async () => {
        await browser.closeWindow();
        await switchToWindowWithE2eBridge(mainWindowHandle);
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

        it('user sees the settings window as a rounded floating surface with a shadow', async () => {
            const styles = await browser.execute(() => {
                const shell = document.querySelector('[data-testid="settings-window-shell"]');
                const frame = document.querySelector('[data-testid="settings-view"]');
                const shellStyle = getComputedStyle(shell);
                const strokeStyle = getComputedStyle(shell, '::after');
                return {
                    radius: shellStyle.borderRadius,
                    shadow: shellStyle.boxShadow,
                    stroke: strokeStyle.boxShadow,
                    strokePointerEvents: strokeStyle.pointerEvents,
                    padding: getComputedStyle(frame).paddingTop,
                };
            });

            assertVisible(
                styles.radius !== '0px',
                `The settings window lost its rounded shell: ${styles.radius}.`
            );
            assertVisible(
                styles.shadow !== 'none' && !styles.shadow.includes('rgba(0, 0, 0, 0) 0px 0px'),
                `The settings window lost its drop shadow: ${styles.shadow}.`
            );
            assertVisible(
                !styles.shadow.includes('inset') &&
                    styles.stroke.includes('inset') &&
                    styles.stroke.includes('0px 0px 0px 1px') &&
                    styles.stroke.includes('0.4'),
                `The settings window lost its visible surface stroke: ${styles.stroke}.`
            );
            assertVisible(
                styles.strokePointerEvents === 'none',
                'The surface stroke must not intercept settings window controls.'
            );
            assertVisible(
                styles.padding === '24px',
                `The settings window has no room for its shadow: ${styles.padding}.`
            );
        });

        it('user sees the content border when the title bar paints an opaque background', async () => {
            const screenshot = await browser.takeScreenshot();
            const [stroke, content] = await browser.execute(async (imageData) => {
                const shell = document.querySelector('[data-testid="settings-window-shell"]');
                const bounds = shell.getBoundingClientRect();
                const image = new Image();
                image.src = `data:image/png;base64,${imageData}`;
                await image.decode();
                const canvas = document.createElement('canvas');
                canvas.width = image.width;
                canvas.height = image.height;
                const context = canvas.getContext('2d');
                context.drawImage(image, 0, 0);
                const scale = image.width / window.innerWidth;
                const left = Math.floor((bounds.left + bounds.width / 2) * scale);
                return [bounds.top, bounds.top + 2].map((top) =>
                    Array.from(context.getImageData(left, Math.floor(top * scale), 1, 1).data)
                );
            }, screenshot);

            for (const channel of [0, 1, 2]) {
                const expected = Math.round(content[channel] * 0.6 + 117 * 0.4);
                assertVisible(
                    Math.abs(stroke[channel] - expected) <= 2,
                    `The content background hid the surface border: ${stroke} vs ${content}.`
                );
            }
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
        // The window is set to the product's own default size, so the baselines show
        // the layout a user gets on first open rather than an arbitrary viewport.
        // A GitHub-hosted runner only has a 1024x768 desktop, but Windows does not
        // clamp a window to the desktop, and WebDriver captures the window itself
        // rather than the screen.
        it('user sees every settings section keep its layout after choosing it in the sidebar', async () => {
            await browser.setWindowSize(...SETTINGS_WINDOW_DEFAULT_SIZE);
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

            // Several settings can match; this asserts the list is not empty.
            const firstResult = await results.$('[role="option"]', { strict: false });
            await firstResult.waitForDisplayed();
            assertVisible(
                await firstResult.isDisplayed(),
                'Settings search showed an empty result list.'
            );
        });
        it('user finds a setting by its English name while the interface is in Chinese', async () => {
            // The spec pins the interface to English in `before` so the visual baselines
            // are stable, which means this case would otherwise search an English
            // interface and prove nothing: an English query finding an English row is not
            // the cross-language behaviour its name promises.
            //
            // The bridge lives in the main window, not in the settings document, so the
            // language cannot be set from here. The driver goes back to the window that
            // owns it, sets the language, and returns. No reload is needed on the way
            // back: `locale` is a module-level reactive value that both windows share, and
            // `SettingsView` renders its rows through `t()` against it, so the switch
            // re-renders the settings view in place.
            await switchToWindowWithE2eBridge(mainWindowHandle);
            await useInterfaceLanguage('zh-CN');
            await switchToWindowContaining('/settings');

            try {
                const searchInput = await waitForTestIdDisplayed('settings-search-input');
                await searchInput.click();
                await searchInput.clearValue();

                // The rows are now rendered in Chinese, so an English query only matches
                // if search reads the untranslated names too.
                await searchInput.addValue('start minimized');

                const results = await waitForTestIdDisplayed('settings-search-results');
                const matched = await results.$('[role="option"]', { strict: false });
                await matched.waitForDisplayed();
                assertVisible(
                    await matched.isDisplayed(),
                    'Settings search found nothing for an English name on a Chinese interface.'
                );
            } finally {
                // Restore English for the cases that follow and for the baselines they
                // capture, again through the window that owns the bridge.
                await switchToWindowWithE2eBridge(mainWindowHandle);
                await useInterfaceLanguage();
                await switchToWindowContaining('/settings');
            }
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
