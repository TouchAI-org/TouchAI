/**
 * User flows in the settings window: opening it, changing a persisted
 * preference, moving between sections, and finding a setting by search.
 *
 * The window is opened once for this spec and closed through its native title-bar
 * control. WebDriver closeWindow detaches only the WebView2 target and can strand
 * the native Settings owner, preventing later model and queue scenarios from
 * opening it again in the same driver session.
 */
import {
    assertVisible,
    callE2eBridge,
    closeSettingsWindow,
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
import { manageSkillAcrossWindows, selectSkillWithKeyboard } from '../support/skills.js';

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
        await closeSettingsWindow();
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
                    styles.stroke.includes('rgba(117, 117, 117, 0.3)'),
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

        it('user sees a subtle gray content border when the title bar paints an opaque background', async () => {
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
                if (Math.abs(image.height - Math.round(window.innerHeight * scale)) > 1) {
                    throw new Error(
                        'The screenshot dimensions do not match the settings viewport.'
                    );
                }
                const left = Math.floor((bounds.left + bounds.width / 2) * scale);
                return [bounds.top, bounds.top + 2].map((top) =>
                    Array.from(context.getImageData(left, Math.floor(top * scale), 1, 1).data)
                );
            }, screenshot);

            assertVisible(
                content[3] === 255 &&
                    content.slice(0, 3).some((value) => Math.abs(value - 117) > 2),
                `The screenshot must sample opaque content distinct from the border: ${content}.`
            );
            for (const channel of [0, 1, 2]) {
                const expected = Math.round(117 * 0.3 + content[channel] * 0.7);
                assertVisible(
                    Math.abs(stroke[channel] - expected) <= 2,
                    `The border did not blend once over the content: ${stroke} vs ${content}.`
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

    describe('given a skill is installed in the isolated user home', () => {
        for (const trigger of ['$', '/']) {
            it(`user inserts a skill with Tab after typing ${trigger} in the main window`, async () => {
                await selectSkillWithKeyboard(mainWindowHandle, trigger);
            });
        }

        it('user views, disables, restores and confirms deletion of the installed skill', async () => {
            await manageSkillAcrossWindows(mainWindowHandle);
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

        it('user changes privacy filtering modes, then sees relevant controls and keeps the disabled state after navigation', async () => {
            const privacyNav = await waitForTestIdDisplayed('settings-nav-privacy-filter');
            await privacyNav.click();
            await waitForTestIdDisplayed('settings-privacy-filter-section');

            const enabled = await waitForTestIdDisplayed('privacy-filter-enabled-toggle');
            const mode = await waitForTestIdDisplayed('privacy-filter-mode-select');
            assertVisible(
                (await getAriaChecked(enabled)) === 'false',
                'Privacy filtering should start disabled.'
            );
            assertVisible(
                !(await mode.isEnabled()),
                'The filtering mode is editable while filtering is off.'
            );
            assertVisible(
                !(await browser.$('[data-testid="privacy-filter-preview-run"]').isExisting()),
                'The removed preview is still present.'
            );

            await toggleSwitch(enabled);
            await mode.click();
            await (await waitForTestIdDisplayed('privacy-filter-mode-rules')).click();
            await browser.waitUntil(
                async () =>
                    !(await browser.$('[data-testid="privacy-filter-model-select"]').isExisting()),
                {
                    timeoutMsg: 'Rule-based filtering still shows model settings.',
                }
            );
            await toggleSwitch(enabled);

            await (await waitForTestIdDisplayed('settings-nav-general')).click();
            await waitForTestIdDisplayed('settings-general-section');
            await (await waitForTestIdDisplayed('settings-nav-privacy-filter')).click();
            await waitForTestIdDisplayed('settings-privacy-filter-section');
            const restoredEnabled = await waitForTestIdDisplayed('privacy-filter-enabled-toggle');
            const restoredMode = await waitForTestIdDisplayed('privacy-filter-mode-select');
            assertVisible(
                (await getAriaChecked(restoredEnabled)) === 'false',
                'The disabled state was not saved.'
            );
            assertVisible(
                (await restoredMode.getText()).includes('Algorithmic rules'),
                'The rule-based mode was not saved.'
            );

            await toggleSwitch(restoredEnabled);
            await restoredMode.click();
            await (await waitForTestIdDisplayed('privacy-filter-mode-model')).click();
            const model = await waitForTestIdDisplayed('privacy-filter-model-select');
            await model.click();
            const download = await browser.$(
                '[role="group"][aria-label="AstrLink Guard INT8"] [data-testid="privacy-filter-download-model"]'
            );
            await download.waitForDisplayed();
            assertVisible(
                await download.isEnabled(),
                'The model cannot be downloaded from its selector.'
            );
            const modelNames = await browser.execute(() =>
                Array.from(document.querySelectorAll('[role="listbox"] [role="option"]')).map(
                    (option) => option.textContent
                )
            );
            assertVisible(
                modelNames.length === 3 && modelNames[0].includes('AstrLink'),
                'AstrLink is not first in the model library.'
            );
            assertVisible(
                await (
                    await waitForTestIdDisplayed('privacy-filter-model-recommended')
                ).isDisplayed(),
                'The recommended model is not marked.'
            );
            await browser.keys('Escape');

            assertVisible(
                !(await browser.$('[data-testid="privacy-filter-download-source"]').isExisting()),
                'The removed download source setting is still present.'
            );

            await browser.execute(async () => {
                await window.__TAURI_INTERNALS__.invoke('privacy_filter_record_protection', {
                    record: {
                        mode: 'rules',
                        outcome: 'protected',
                        maskedCount: 2,
                        categories: [{ kind: 'email', count: 2 }],
                    },
                    details: {
                        values: [
                            {
                                kind: 'email',
                                original: 'robin@example.net',
                                placeholder: '{{EMAIL_0123456789abcdef}}',
                                count: 2,
                                matches: [{ id: 'email', count: 2 }],
                            },
                        ],
                        texts: [
                            'Contact {{EMAIL_0123456789abcdef}} and {{EMAIL_0123456789abcdef}}.',
                        ],
                        truncated: false,
                    },
                });
            });
            const record = await waitForTestIdDisplayed('privacy-protection-record');
            assertVisible(
                (await record.getText()).includes('Protected 2'),
                'The native protection record was not shown.'
            );
            await (await waitForTestIdDisplayed('privacy-protection-record-open')).click();
            const details = await waitForTestIdDisplayed('privacy-protection-details');
            const original = await waitForTestIdDisplayed('privacy-protection-value-original');
            const masked = await waitForTestIdDisplayed('privacy-protection-value-masked');
            const rule = await waitForTestIdDisplayed('privacy-protection-value-rule');
            assertVisible(
                (await original.getText()) === 'robin@example.net' &&
                    (await masked.getText()) === '{{EMAIL_0123456789abcdef}}' &&
                    (await rule.getText()).includes('Email address format'),
                'The inline replacement list does not match the native values and captured rule.'
            );
            assertVisible(
                (await details.isDisplayed()) && !(await browser.$('[role="dialog"]').isExisting()),
                'Expanding the record still opens a dialog instead of an inline list.'
            );
            await (await waitForTestIdDisplayed('privacy-protection-record-open')).click();
            await browser.waitUntil(
                async () =>
                    !(await browser.$('[data-testid="privacy-protection-details"]').isExisting()),
                { timeoutMsg: 'Closing the details left concrete content visible.' }
            );
            await (await waitForTestIdDisplayed('privacy-protection-records-clear')).click();
            const confirmation = await browser.$('[role="alertdialog"]');
            await confirmation.waitForDisplayed();
            const buttons = await confirmation.$$('button');
            let confirmed = false;
            for (const button of buttons) {
                if ((await button.getText()) === 'Clear records') {
                    await button.click();
                    confirmed = true;
                    break;
                }
            }
            assertVisible(confirmed, 'The clear-records confirmation action is missing.');
            await browser.waitUntil(
                async () =>
                    (await browser.$$('[data-testid="privacy-protection-record"]')).length === 0,
                { timeoutMsg: 'The protection record was not cleared.' }
            );
            await toggleSwitch(restoredEnabled);

            const editableControls = await browser.execute(() => {
                const page = document.querySelector(
                    '[data-testid="settings-privacy-filter-section"]'
                );
                return Array.from(page.querySelectorAll('button, input')).filter(
                    (control) =>
                        control.dataset.testid !== 'privacy-filter-enabled-toggle' &&
                        !control.matches(':disabled')
                ).length;
            });
            assertVisible(
                editableControls === 0,
                'Some privacy settings remain editable while filtering is off.'
            );
            await (await waitForTestIdDisplayed('settings-nav-general')).click();
            await waitForTestIdDisplayed('settings-general-section');
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
