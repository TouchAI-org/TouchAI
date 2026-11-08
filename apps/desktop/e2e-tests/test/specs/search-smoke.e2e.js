import { execFileSync } from 'node:child_process';

import { useSearchFixture, waitForE2eBridge } from '../support/desktop.js';
import { SEARCH_FIXTURE_RESULTS } from '../support/fixtures.js';
import { expectFocused, startFocusTrace, stopFocusTrace } from '../support/focus.js';

function sendTestGlobalShortcut(count = 1) {
    execFileSync(
        'powershell.exe',
        [
            '-NoProfile',
            '-NonInteractive',
            '-Sta',
            '-Command',
            `Add-Type -AssemblyName System.Windows.Forms; 1..${count} | ForEach-Object { [System.Windows.Forms.SendKeys]::SendWait('^%+{F12}') }`,
        ],
        { stdio: 'pipe', windowsHide: true }
    );
}

describe('TouchAI search smoke', () => {
    before(async () => {
        await waitForE2eBridge();
        await useSearchFixture('touchai', SEARCH_FIXTURE_RESULTS);
        await startFocusTrace();
    });

    after(stopFocusTrace);

    it('user keeps the reopened window visible when pinning and unpinning with Ctrl+P', async () => {
        await browser.waitUntil(async () => browser.execute(() => Boolean(window.__TOUCHAI_E2E__)));
        for (let cycle = 0; cycle < 2; cycle += 1) {
            await browser.execute(async () => {
                return window.__TAURI_INTERNALS__
                    .invoke('hide_search_window')
                    .then(() => window.__TAURI_INTERNALS__.invoke('show_search_window'))
                    .then(
                        () => null,
                        (error) => String(error)
                    );
            });
            await browser.waitUntil(() =>
                browser.execute(() =>
                    window.__TAURI_INTERNALS__.invoke('plugin:window|is_focused', { label: 'main' })
                )
            );
            for (let toggle = 0; toggle < 2; toggle += 1) {
                const previous = await browser.execute(() =>
                    window.__TAURI_INTERNALS__.invoke('plugin:window|is_always_on_top', {
                        label: 'main',
                    })
                );
                await browser.keys(['Control', 'p']);
                await browser.keys(['NULL']);
                await browser.waitUntil(
                    async () =>
                        (await browser.execute(() =>
                            window.__TAURI_INTERNALS__.invoke('plugin:window|is_always_on_top', {
                                label: 'main',
                            })
                        )) !== previous
                );
                const visible = await browser.execute(() =>
                    window.__TAURI_INTERNALS__.invoke('plugin:window|is_visible', { label: 'main' })
                );
                if (!visible) throw new Error('Ctrl+P hid the reopened search window');
            }
        }
    });

    it('shows the main window only after the initial renderer handshake commits', async () => {
        await browser.waitUntil(async () => {
            return browser.execute(() => Boolean(window.__TOUCHAI_E2E__));
        });
        const mainVisible = await browser.execute(() =>
            window.__TAURI_INTERNALS__.invoke('plugin:window|is_visible', { label: 'main' })
        );
        if (!mainVisible) {
            throw new Error(
                'Expected the native main window to be visible after __TOUCHAI_E2E__ became ready'
            );
        }
    });

    it('user sees the native gray ring on the search card', async () => {
        const styles = await browser.execute(() => {
            const card = document.querySelector('[data-testid="search-view-card"]');
            if (!(card instanceof HTMLElement)) {
                return null;
            }
            const style = getComputedStyle(card);
            return {
                radius: style.borderRadius,
                shadow: style.boxShadow,
            };
        });

        if (!styles) {
            throw new Error('The search card was not available for style inspection.');
        }
        if (
            !styles.shadow.includes('inset') ||
            !styles.shadow.includes('0px 0px 0px 1px') ||
            !styles.shadow.includes('0.4')
        ) {
            throw new Error(`The search card lost its native gray ring: ${styles.shadow}.`);
        }
        if (styles.radius === '0px') {
            throw new Error('The search card lost its rounded native surface.');
        }
    });

    it('opens the quick-search panel after typing into the search editor', async () => {
        const editor = await $("[data-testid='search-editor-host'] .ProseMirror");
        const quickSearchPanel = await $("[data-testid='quick-search-panel']");

        await editor.waitForDisplayed();
        await browser.waitUntil(async () => {
            return browser.execute(() => Boolean(window.__TOUCHAI_E2E__));
        });
        await browser.execute((text) => {
            window.__TOUCHAI_E2E__.setSearchQuery(text);
        }, 'touchai');

        await quickSearchPanel.waitForDisplayed();
        let editorText = '';
        await browser.waitUntil(
            async () => {
                editorText = await browser.execute(() => {
                    return (
                        document.querySelector("[data-testid='search-editor-host'] .ProseMirror")
                            ?.textContent ?? ''
                    );
                });
                return editorText.includes('touchai');
            },
            {
                timeout: 5000,
                timeoutMsg: `Expected editor text to contain "touchai", received "${editorText}"`,
            }
        );
    });

    it('keeps a real quick-search Enter reveal inside one native host transaction', async () => {
        const editor = await $("[data-testid='search-editor-host'] .ProseMirror");
        const quickSearchPanel = await $("[data-testid='quick-search-panel']");

        await editor.waitForDisplayed();
        await browser.waitUntil(
            async () => browser.execute(() => Boolean(window.__TOUCHAI_E2E__)),
            { timeoutMsg: 'Expected the E2E bridge before real quick-search typing' }
        );
        await browser.execute(() => {
            window.__TOUCHAI_E2E__.setSearchQuery('');
        });
        await quickSearchPanel.waitForDisplayed({ reverse: true });
        await editor.click();
        await browser.keys(['t', 'o', 'u', 'c', 'h', 'a', 'i']);
        await quickSearchPanel.waitForDisplayed();

        const readQuickSearchViewport = () =>
            browser.execute(() => {
                const panel = document.querySelector("[data-testid='quick-search-panel']");
                const rect = panel instanceof HTMLElement ? panel.getBoundingClientRect() : null;
                return {
                    innerHeight: window.innerHeight,
                    panelBottom: rect?.bottom ?? null,
                    panelHeight: rect?.height ?? null,
                };
            });

        // The host is a function of the measured content height: the results list
        // becomes visible in the same frame that starts the native grow, so the
        // reveal is only expected to fit once the host has settled.
        let quickSearchViewport = await readQuickSearchViewport();
        try {
            await browser.waitUntil(
                async () => {
                    quickSearchViewport = await readQuickSearchViewport();
                    return (
                        Number.isFinite(quickSearchViewport.panelBottom) &&
                        quickSearchViewport.panelBottom <= quickSearchViewport.innerHeight + 2
                    );
                },
                {
                    timeout: 4000,
                    interval: 50,
                    timeoutMsg: `Expected quick-search results to fit inside the native viewport before Enter: ${JSON.stringify(quickSearchViewport)}`,
                }
            );
        } catch (error) {
            throw new Error(
                `Expected quick-search results to fit inside the native viewport before Enter: ${JSON.stringify(quickSearchViewport)}`,
                { cause: error }
            );
        }

        await browser.execute(() => {
            const state = {
                done: false,
                samples: [],
                startedAt: performance.now(),
            };
            window.__TOUCHAI_QUICK_ENTER_SAMPLES__ = state;
            const sample = () => {
                const frame = document.querySelector("[data-testid='search-view-expand-frame']");
                const card = document.querySelector("[data-testid='search-view-card']");
                const quickSearch = document.querySelector("[data-testid='quick-search-panel']");
                const frameRect =
                    frame instanceof HTMLElement ? frame.getBoundingClientRect() : null;
                const cardRect = card instanceof HTMLElement ? card.getBoundingClientRect() : null;
                const quickRect =
                    quickSearch instanceof HTMLElement ? quickSearch.getBoundingClientRect() : null;
                state.samples.push({
                    t: Math.round(performance.now() - state.startedAt),
                    innerHeight: window.innerHeight,
                    frame: frameRect?.height ?? null,
                    card: cardRect?.height ?? null,
                    cardTop: cardRect?.top ?? null,
                    quickSearch: quickRect?.height ?? null,
                });
                if (performance.now() - state.startedAt >= 900) {
                    state.done = true;
                    return;
                }
                requestAnimationFrame(sample);
            };
            sample();
        });
        await browser.keys(['Enter']);
        await browser.waitUntil(
            async () =>
                browser.execute(() => window.__TOUCHAI_QUICK_ENTER_SAMPLES__?.done === true),
            {
                timeout: 3000,
                timeoutMsg: 'Timed out while sampling the real quick-search Enter reveal',
            }
        );

        const samples = await browser.execute(() => window.__TOUCHAI_QUICK_ENTER_SAMPLES__);
        const frames = (samples?.samples ?? []).filter(
            (sample) =>
                Number.isFinite(sample.card) &&
                Number.isFinite(sample.frame) &&
                Number.isFinite(sample.innerHeight)
        );
        const cardHeights = frames.map((sample) => sample.card);
        const initialHostHeight = frames[0]?.innerHeight ?? 0;
        const minimumHostHeight = Math.min(...frames.map((sample) => sample.innerHeight));
        const largestCardHostDelta = Math.max(
            ...frames.map((sample) => Math.abs(sample.card - sample.frame))
        );
        const largestCardOverflow = Math.max(...frames.map((sample) => sample.card - sample.frame));
        const settledCardHostDelta = Math.max(
            ...frames.slice(-10).map((sample) => Math.abs(sample.card - sample.frame))
        );
        const settledHeights = frames.slice(-10).map((sample) => sample.card);
        const settledSpread = Math.max(...settledHeights) - Math.min(...settledHeights);
        const maxCardHeight = Math.max(...cardHeights);

        const submittedLayout = await browser.execute(() => {
            const conversation = document.querySelector('[data-testid="conversation-panel-host"]');
            const card = document.querySelector("[data-testid='search-view-card']");
            const frame = document.querySelector("[data-testid='search-view-expand-frame']");
            const cardRect = card instanceof HTMLElement ? card.getBoundingClientRect() : null;
            const frameRect = frame instanceof HTMLElement ? frame.getBoundingClientRect() : null;
            return {
                conversation: conversation instanceof HTMLElement,
                quickSearch: document.querySelector("[data-testid='quick-search-panel']") !== null,
                card: cardRect?.height ?? null,
                frame: frameRect?.height ?? null,
                innerHeight: window.innerHeight,
            };
        });

        // Enter must hand the surface over in one native transaction: the host reaches the
        // final height immediately, the card only ever grows inside it, and the settled card
        // equals the host interior again.
        if (
            frames.length < 8 ||
            largestCardOverflow > 1 ||
            settledCardHostDelta > 1 ||
            minimumHostHeight < initialHostHeight - 20 ||
            settledSpread > 2 ||
            !submittedLayout.conversation ||
            submittedLayout.quickSearch ||
            !Number.isFinite(submittedLayout.frame) ||
            submittedLayout.frame >= submittedLayout.innerHeight
        ) {
            throw new Error(
                `Expected a single bounded native transaction on quick-search Enter: ${JSON.stringify(
                    {
                        initialHostHeight,
                        minimumHostHeight,
                        largestCardHostDelta,
                        largestCardOverflow,
                        settledCardHostDelta,
                        settledSpread,
                        maxCardHeight,
                        submittedLayout,
                        samples: frames.slice(0, 40),
                    }
                )}`
            );
        }

        await browser.execute(async () => {
            return window.__TOUCHAI_E2E__
                .clearSessionToIdle()
                .then(() => {
                    window.__TOUCHAI_E2E__.setSearchQuery('');
                    return null;
                })
                .catch((error) => String(error));
        });
    });

    it('keeps model and history overlays in the main WebView with shortcut mutual exclusion', async () => {
        await browser.execute(() => {
            window.__TOUCHAI_E2E__.setSearchQuery('');
        });
        const quickSearchPanel = await $("[data-testid='quick-search-panel']");
        await quickSearchPanel.waitForDisplayed({ reverse: true });

        await browser.keys(['Control', 'm']);
        await browser.keys(['NULL']);

        const overlayHost = await $('[data-search-overlay-host="true"]');
        const modelDropdown = await $('[data-model-dropdown-popover="true"]');
        await overlayHost.waitForDisplayed();
        await modelDropdown.waitForDisplayed();
        const modelFilter = await modelDropdown.$('input');
        await expectFocused(modelFilter, 'Expected model filter focus after opening the overlay');
        await modelFilter.setValue('no-match-model');
        const modelFilterValue = await modelFilter.getValue();
        if (modelFilterValue !== 'no-match-model') {
            throw new Error(`Expected model filter value, received "${modelFilterValue}"`);
        }

        await browser.keys(['Control', 'h']);
        await browser.keys(['NULL']);

        const sessionHistory = await $('[data-search-history-popover="true"]');
        await sessionHistory.waitForDisplayed();
        await modelDropdown.waitForExist({ reverse: true });
        const historyFilter = await sessionHistory.$('input');
        await expectFocused(
            historyFilter,
            'Expected history filter focus after opening the overlay'
        );
        await historyFilter.setValue('no-match-session');
        const historyFilterValue = await historyFilter.getValue();
        if (historyFilterValue !== 'no-match-session') {
            throw new Error(`Expected history filter value, received "${historyFilterValue}"`);
        }

        await browser.keys(['Escape']);
        await overlayHost.waitForExist({ reverse: true });
        const editor = await $("[data-testid='search-editor-host'] .ProseMirror");
        await browser.waitUntil(() => editor.isFocused(), {
            timeoutMsg: 'Expected search editor focus after dismissing the history overlay',
        });
    });

    it('keeps the history overlay inside the native host envelope', async () => {
        const editor = await $("[data-testid='search-editor-host'] .ProseMirror");
        await editor.waitForDisplayed();
        await browser.waitUntil(async () => {
            return browser.execute(() => Boolean(window.__TOUCHAI_E2E__));
        });

        const readOverlayGeometry = () =>
            browser.execute(() => {
                const popover = document.querySelector('[data-search-history-popover="true"]');
                const box = popover instanceof HTMLElement ? popover.getBoundingClientRect() : null;
                return {
                    innerHeight: window.innerHeight,
                    top: box?.top ?? null,
                    bottom: box?.bottom ?? null,
                };
            });

        await browser.keys(['Control', 'h']);
        await browser.keys(['NULL']);

        const history = await $('[data-search-history-popover="true"]');
        await history.waitForDisplayed();

        // Placement must fit the stable viewport on the first open.
        let geometry = await readOverlayGeometry();
        try {
            await browser.waitUntil(
                async () => {
                    geometry = await readOverlayGeometry();
                    return (
                        Number.isFinite(geometry.bottom) &&
                        Number.isFinite(geometry.innerHeight) &&
                        geometry.bottom <= geometry.innerHeight + 2
                    );
                },
                {
                    timeout: 4000,
                    interval: 50,
                    timeoutMsg: `Expected the history overlay to fit inside the native viewport: ${JSON.stringify(geometry)}`,
                }
            );
        } catch (error) {
            throw new Error(
                `Expected the history overlay to fit inside the native viewport: ${JSON.stringify(geometry)}`,
                { cause: error }
            );
        }

        // A bounded envelope settles. A host that keeps growing means the overlay
        // measurement is feeding its own growth back into the commit target.
        await browser.pause(600);
        const settledGeometry = await readOverlayGeometry();
        if (Math.abs(settledGeometry.innerHeight - geometry.innerHeight) > 2) {
            throw new Error(
                `Expected the native host to stop growing once the history overlay settled: ${JSON.stringify({ geometry, settledGeometry })}`
            );
        }

        await browser.keys(['Escape']);
        await history.waitForExist({ reverse: true });
    });

    it('keeps history interactive after a concrete session and native hide/show', async () => {
        const fixtureError = await browser.execute(async () => {
            try {
                await window.__TAURI_INTERNALS__.invoke('database_query', {
                    request: {
                        sql: `INSERT INTO sessions
                                (id, session_id, title, model, last_message_preview, last_message_at, message_count, created_at, updated_at)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        params: [
                            9001,
                            'e2e-history-toolbar-session',
                            'E2E history toolbar session',
                            'e2e-model',
                            'History toolbar fixture',
                            '2026-09-18 12:00:00',
                            1,
                            '2026-09-18 12:00:00',
                            '2026-09-18 12:00:00',
                        ],
                        method: 'run',
                    },
                });
                await window.__TAURI_INTERNALS__.invoke('database_query', {
                    request: {
                        sql: `INSERT INTO messages
                                (id, session_id, role, created_at, updated_at)
                                VALUES (?, ?, ?, ?, ?)`,
                        params: [9001, 9001, 'user', '2026-09-18 12:00:00', '2026-09-18 12:00:00'],
                        method: 'run',
                    },
                });
                await window.__TAURI_INTERNALS__.invoke('database_query', {
                    request: {
                        sql: 'INSERT INTO message_parts (message_id, type, content, sort_order) VALUES (?, ?, ?, ?)',
                        params: [9001, 'text', 'History toolbar fixture', 0],
                        method: 'run',
                    },
                });
                return null;
            } catch (error) {
                return String(error);
            }
        });
        if (fixtureError !== null) {
            throw new Error(`Failed to seed the history toolbar fixture: ${fixtureError}`);
        }

        const manualOverrideError = await browser.execute(async () => {
            try {
                const current = await window.__TAURI_INTERNALS__.invoke('get_search_window_state');
                await window.__TAURI_INTERNALS__.invoke('set_search_window_allow_height_override', {
                    allow: true,
                });
                await window.__TAURI_INTERNALS__.invoke('commit_search_panel_resize', {
                    resize: {
                        from: {
                            width: current.currentWidth,
                            height: current.currentHeight,
                        },
                        to: {
                            width: current.currentWidth,
                            height: current.currentHeight + 16,
                        },
                    },
                });
                return null;
            } catch (error) {
                return String(error);
            }
        });
        if (manualOverrideError !== null) {
            throw new Error(
                `Failed to prepare a manual height override before opening history: ${manualOverrideError}`
            );
        }

        await browser.keys(['Control', 'h']);
        await browser.keys(['NULL']);
        const fixtureHistory = await $('[data-search-history-popover="true"]');
        const fixtureSearchInput = await fixtureHistory.$('input');
        await expectFocused(
            fixtureSearchInput,
            'Expected history filter focus before searching history'
        );
        await fixtureSearchInput.setValue('E2E history toolbar session');
        const fixtureSession = await $('[data-search-history-popover="true"] .history-session-row');
        await fixtureSession.waitForDisplayed();
        await fixtureSession.click();
        await fixtureHistory.waitForExist({ reverse: true });
        await browser.waitUntil(
            async () => {
                const state = await browser.execute(() =>
                    window.__TAURI_INTERNALS__.invoke('get_search_window_state')
                );
                return state.heightMode === 'auto' && state.currentHeight > 100;
            },
            {
                timeout: 3000,
                timeoutMsg: 'Expected opening a concrete history session to expand the panel',
            }
        );

        const conversationLayout = await browser.execute(() => {
            const panel = document.querySelector('[data-testid="search-view"] > div > div');
            const container = document.querySelector('[data-testid="conversation-panel-host"]');
            if (!(panel instanceof HTMLElement) || !(container instanceof HTMLElement)) {
                return null;
            }
            const panelRect = panel.getBoundingClientRect();
            const containerRect = container.getBoundingClientRect();
            return {
                panelHeight: panelRect.height,
                containerHeight: containerRect.height,
                containerScrollHeight: container.scrollHeight,
            };
        });
        if (!conversationLayout || conversationLayout.panelHeight <= 100) {
            throw new Error(
                `Expected the concrete history session content to be laid out: ${JSON.stringify(conversationLayout)}`
            );
        }

        const editor = await $(`[data-testid='search-editor-host'] .ProseMirror`);
        const hideShowError = await browser.execute(async () => {
            try {
                await window.__TAURI_INTERNALS__.invoke('hide_search_window');
                await window.__TAURI_INTERNALS__.invoke('show_search_window');
                return null;
            } catch (error) {
                return String(error);
            }
        });
        if (hideShowError !== null) {
            throw new Error(`Native hide/show before toolbar history failed: ${hideShowError}`);
        }
        await browser.waitUntil(() => editor.isFocused(), {
            timeoutMsg: 'Expected the search editor to regain focus before toolbar history',
        });

        const trigger = await $('[data-history-trigger="true"] button');
        await trigger.waitForDisplayed();

        const outerHeight = () =>
            browser.execute(() =>
                window.__TAURI_INTERNALS__.invoke('plugin:window|outer_size', { label: 'main' })
            );

        const before = await outerHeight();
        await trigger.click();

        const history = await $('[data-search-history-popover="true"]');
        await history.waitForDisplayed();
        const historyFilter = await history.$('input');
        await expectFocused(historyFilter, 'Expected toolbar history focus after native hide/show');
        const after = await outerHeight();
        if (after.height < before.height - 20) {
            throw new Error(
                `Expected native hide/show to preserve the concrete session height: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`
            );
        }

        await browser.keys(['Escape']);
        await history.waitForExist({ reverse: true });
    });

    it('user opens the model picker, then two rapid shortcut presses leave it open', async () => {
        const modelDropdown = await $('[data-model-dropdown-popover="true"]');

        await browser.keys(['Control', 'm']);
        await browser.keys(['NULL']);
        await modelDropdown.waitForDisplayed();
        const filter = await modelDropdown.$('input');
        await expectFocused(filter, 'Expected one Ctrl+M press to open and focus the model picker');

        await browser.keys(['Control', 'm', 'm']);
        await browser.keys(['NULL']);
        await expectFocused(
            filter,
            'Expected two more Ctrl+M presses to leave the model picker interactive'
        );

        await browser.keys(['Control', 'm']);
        await browser.keys(['NULL']);
        await modelDropdown.waitForExist({
            reverse: true,
            timeoutMsg: 'Expected the next Ctrl+M press to close the model picker',
        });
    });

    it('restores the search editor focus after a native hide and show cycle', async () => {
        const editor = await $("[data-testid='search-editor-host'] .ProseMirror");
        await editor.waitForDisplayed();

        const hideShowError = await browser.execute(async () => {
            try {
                await window.__TAURI_INTERNALS__.invoke('hide_search_window');
                await new Promise((resolve) => window.setTimeout(resolve, 50));
                await window.__TAURI_INTERNALS__.invoke('show_search_window');
                return null;
            } catch (error) {
                return String(error);
            }
        });
        if (hideShowError !== null) {
            throw new Error(`Native hide/show cycle failed: ${hideShowError}`);
        }

        await editor.waitForDisplayed();
        await browser.waitUntil(() => editor.isFocused(), {
            timeoutMsg: 'Expected search editor focus after showing the native search surface',
        });
    });

    it('keeps history within the native host after the search surface is shown again', async () => {
        const editor = await $("[data-testid='search-editor-host'] .ProseMirror");
        const isVisible = () =>
            browser.execute(() =>
                window.__TAURI_INTERNALS__.invoke('plugin:window|is_visible', { label: 'main' })
            );

        await editor.waitForDisplayed();
        await editor.click();
        const hideError = await browser.execute(async () => {
            return window.__TAURI_INTERNALS__
                .invoke('hide_search_window')
                .then(() => null)
                .catch((error) => String(error));
        });
        if (hideError !== null) {
            throw new Error(`Native hide before history regression failed: ${hideError}`);
        }
        await browser.waitUntil(async () => !(await isVisible()), {
            timeoutMsg:
                'Expected the native hide to hide the search surface before reopening history',
        });

        const showError = await browser.execute(async () => {
            return window.__TAURI_INTERNALS__
                .invoke('show_search_window')
                .then(() => null)
                .catch((error) => String(error));
        });
        if (showError !== null) {
            throw new Error(`Native show before history regression failed: ${showError}`);
        }
        await browser.waitUntil(isVisible, {
            timeoutMsg:
                'Expected the native show to show the search surface before reopening history',
        });
        await browser.waitUntil(() => editor.isFocused(), {
            timeoutMsg: 'Expected the search editor to regain focus before reopening history',
        });

        await browser.keys(['Control', 'h']);
        await browser.keys(['NULL']);
        const history = await $('[data-search-history-popover="true"]');
        await history.waitForDisplayed();

        let layout = null;
        await browser.waitUntil(
            async () => {
                layout = await browser.execute(async () => {
                    const element = document.querySelector('[data-search-history-popover="true"]');
                    const rect =
                        element instanceof HTMLElement ? element.getBoundingClientRect() : null;
                    const viewportHeight = Math.max(
                        window.innerHeight,
                        document.documentElement.clientHeight
                    );
                    return {
                        historyBottom: rect?.bottom ?? null,
                        viewportHeight,
                    };
                });
                return (
                    layout?.historyBottom !== null &&
                    layout.historyBottom <= layout.viewportHeight + 1
                );
            },
            {
                timeout: 2000,
                timeoutMsg: `Expected history to fit within the native host after show: ${JSON.stringify(layout)}`,
            }
        );

        await browser.keys(['Escape']);
        await history.waitForExist({ reverse: true });
    });

    it('serializes rapid global-shortcut toggles and restores focused input', async () => {
        const registrationError = await browser.execute(async () => {
            return window.__TAURI_INTERNALS__
                .invoke('register_global_shortcut', { shortcut: 'Ctrl+Alt+Shift+F12' })
                .then(() => null)
                .catch((error) => String(error));
        });
        if (registrationError !== null) {
            throw new Error(`Failed to register the E2E global shortcut: ${registrationError}`);
        }

        await browser.execute(async () => {
            window.__TOUCHAI_E2E_SURFACE_EVENTS__ = [];
            return Promise.all([
                window.__TAURI__.event.listen('search-surface-hidden', (event) => {
                    window.__TOUCHAI_E2E_SURFACE_EVENTS__.push({
                        at: performance.now(),
                        kind: 'hidden',
                        sequence: event.payload.sequence,
                    });
                }),
                window.__TAURI__.event.listen('search-surface-shown', (event) => {
                    const shownAt = performance.now();
                    window.__TOUCHAI_E2E_SURFACE_EVENTS__.push({
                        at: shownAt,
                        kind: 'shown',
                        sequence: event.payload.sequence,
                    });
                    const observeFocusedEditor = () => {
                        const activeElement = document.activeElement;
                        if (
                            activeElement instanceof HTMLElement &&
                            activeElement.matches("[data-testid='search-editor-host'] .ProseMirror")
                        ) {
                            window.__TOUCHAI_E2E_SURFACE_EVENTS__.push({
                                kind: 'editor-focused',
                                latencyMs: performance.now() - shownAt,
                                sequence: event.payload.sequence,
                            });
                            return;
                        }
                        if (performance.now() - shownAt < 1000) {
                            requestAnimationFrame(observeFocusedEditor);
                        }
                    };
                    requestAnimationFrame(observeFocusedEditor);
                }),
            ])
                .then((unlisteners) => {
                    window.__TOUCHAI_E2E_SURFACE_UNLISTENERS__ = unlisteners;
                    return null;
                })
                .catch((error) => String(error));
        });

        const isVisible = () =>
            browser.execute(() =>
                window.__TAURI_INTERNALS__.invoke('plugin:window|is_visible', { label: 'main' })
            );
        const editor = await $("[data-testid='search-editor-host'] .ProseMirror");
        await editor.click();

        sendTestGlobalShortcut();
        await browser.waitUntil(async () => !(await isVisible()), {
            timeoutMsg: 'Expected the global shortcut to hide the focused search surface',
        });

        sendTestGlobalShortcut();
        await browser.waitUntil(isVisible, {
            timeoutMsg: 'Expected the global shortcut to show the hidden search surface',
        });
        await browser.waitUntil(() => editor.isFocused(), {
            timeoutMsg: 'Expected focused input after global-shortcut show',
        });

        await browser.execute(() => {
            window.__TOUCHAI_E2E_SURFACE_EVENTS__ = [];
        });
        sendTestGlobalShortcut(2);

        let rapidEvents = [];
        await browser.waitUntil(
            async () => {
                rapidEvents = await browser.execute(
                    () => window.__TOUCHAI_E2E_SURFACE_EVENTS__ ?? []
                );
                const shownSequence = rapidEvents.find((event) => event.kind === 'shown')?.sequence;
                return rapidEvents.some(
                    (event) => event.kind === 'editor-focused' && event.sequence === shownSequence
                );
            },
            {
                timeoutMsg: 'Expected hidden and shown events from two rapid global shortcuts',
            }
        );

        if (
            rapidEvents[0]?.kind !== 'hidden' ||
            rapidEvents[1]?.kind !== 'shown' ||
            rapidEvents[1]?.sequence <= rapidEvents[0]?.sequence
        ) {
            throw new Error(
                `Unexpected rapid shortcut event order: ${JSON.stringify(rapidEvents)}`
            );
        }
        const warmToggleLatencyMs = rapidEvents[1].at - rapidEvents[0].at;
        const focusLatencyMs = rapidEvents.find(
            (event) => event.kind === 'editor-focused' && event.sequence === rapidEvents[1].sequence
        )?.latencyMs;
        if (
            !Number.isFinite(warmToggleLatencyMs) ||
            !Number.isFinite(focusLatencyMs) ||
            warmToggleLatencyMs > 500 ||
            focusLatencyMs > 250
        ) {
            throw new Error(
                `Warm shortcut timing exceeded its budget: toggle=${warmToggleLatencyMs}, focus=${focusLatencyMs}, events=${JSON.stringify(rapidEvents)}`
            );
        }
        if (!(await isVisible())) {
            throw new Error(
                'Expected two rapid global shortcuts to leave the search surface visible'
            );
        }
        await browser.waitUntil(() => editor.isFocused(), {
            timeoutMsg: 'Expected focused input after two rapid global shortcuts',
        });

        await browser.execute(async () => {
            const unlisteners = window.__TOUCHAI_E2E_SURFACE_UNLISTENERS__ ?? [];
            delete window.__TOUCHAI_E2E_SURFACE_UNLISTENERS__;
            delete window.__TOUCHAI_E2E_SURFACE_EVENTS__;
            return Promise.all(unlisteners.map((unlisten) => unlisten()))
                .then(() => null)
                .catch((error) => String(error));
        });
    });

    it('user sees messages stay in place when a short conversation finishes expanding', async () => {
        await browser.waitUntil(() =>
            browser.execute(() => Boolean(window.__TOUCHAI_E2E__?.clearSessionToIdle))
        );
        await browser.execute(async () => {
            await window.__TOUCHAI_E2E__.clearSessionToIdle();
            await window.__TAURI_INTERNALS__.invoke('show_search_window');
        });
        const editor = await $("[data-testid='search-editor-host'] .ProseMirror");
        await editor.waitForDisplayed();
        await editor.click();

        const samples = await browser.execute(
            () =>
                new Promise((done) => {
                    const frames = [];
                    const startedAt = performance.now();
                    const sample = () => {
                        const card = document.querySelector('[data-testid="search-view-card"]');
                        const message = document.querySelector('[data-message-role="user"]');
                        const viewport = document.querySelector(
                            '[data-slot="message-scroller"] section'
                        );
                        if (card && message && viewport) {
                            const cardRect = card.getBoundingClientRect();
                            frames.push({
                                height: cardRect.height,
                                messageTop: message.getBoundingClientRect().top - cardRect.top,
                                overflow: viewport.scrollHeight - viewport.clientHeight,
                                jumpVisible: Boolean(
                                    document.querySelector('.scroll-fade-overlay')
                                ),
                            });
                        }
                        if (performance.now() - startedAt >= 1500) {
                            done(frames);
                            return;
                        }
                        requestAnimationFrame(sample);
                    };
                    requestAnimationFrame(sample);
                    window.sendPrompt('Short conversation layout');
                })
        );

        const settled = samples.at(-1);
        expect(settled?.height).toBeGreaterThan(100);
        const expandedFrames = samples.filter(
            (sample) => Math.abs(sample.height - settled.height) <= 0.25
        );
        expect(expandedFrames.length).toBeGreaterThan(2);
        const messagePositions = expandedFrames.map((sample) => sample.messageTop);
        expect(Math.max(...messagePositions) - Math.min(...messagePositions)).toBeLessThanOrEqual(
            1
        );
        expect(settled.overflow).toBeLessThanOrEqual(1);
        expect(expandedFrames.some((sample) => sample.jumpVisible)).toBe(false);
    });

    it('grows the native host to the idle prompt submit content height', async () => {
        const editor = await $("[data-testid='search-editor-host'] .ProseMirror");
        await editor.waitForDisplayed();
        await browser.waitUntil(
            async () => {
                return browser.execute(() => Boolean(window.__TOUCHAI_E2E__));
            },
            {
                timeoutMsg: 'Expected the E2E bridge before sampling idle submit expand',
            }
        );

        const clearError = await browser.execute(async () => {
            const bridge = window.__TOUCHAI_E2E__;
            if (!bridge?.clearSessionToIdle) {
                return 'missing clearSessionToIdle';
            }
            return bridge
                .clearSessionToIdle()
                .then(() => null)
                .catch((error) => String(error));
        });
        if (clearError) {
            throw new Error(`Failed to return the search surface to idle: ${clearError}`);
        }

        await browser.execute(() => {
            window.__TOUCHAI_E2E__.setSearchQuery('');
        });
        const quickSearchPanel = await $("[data-testid='quick-search-panel']");
        await quickSearchPanel.waitForDisplayed({ reverse: true });
        await browser.pause(300);

        await browser.execute(() => {
            const state = { done: false, heights: [], startHeight: null };
            window.__TOUCHAI_SUBMIT_SAMPLES__ = state;
            const startedAt = performance.now();
            const sample = () => {
                const frame = document.querySelector("[data-testid='search-view-expand-frame']");
                const card = document.querySelector("[data-testid='search-view-card']");
                const frameRect =
                    frame instanceof HTMLElement ? frame.getBoundingClientRect() : null;
                const cardRect = card instanceof HTMLElement ? card.getBoundingClientRect() : null;
                if (frameRect && cardRect) {
                    state.startHeight ??= frameRect.height;
                    state.heights.push({
                        t: Math.round(performance.now() - startedAt),
                        frame: frameRect.height,
                        frameTop: frameRect.top,
                        card: cardRect.height,
                        cardTop: cardRect.top,
                        innerHeight: window.innerHeight,
                        scrollHeight: card.scrollHeight,
                        clientHeight: card.clientHeight,
                    });
                }
                if (performance.now() - startedAt >= 2000) {
                    state.done = true;
                    return;
                }
                requestAnimationFrame(sample);
            };
            sample();
        });

        // Real driver input: a synthetic KeyboardEvent never reaches ProseMirror.
        await editor.click();
        await browser.keys(['h', 'e', 'l', 'l', 'o']);
        await browser.keys(['Enter']);
        await browser.waitUntil(
            async () => browser.execute(() => window.__TOUCHAI_SUBMIT_SAMPLES__?.done === true),
            {
                timeout: 8000,
                timeoutMsg: 'Timed out while sampling the idle prompt submit expand',
            }
        );
        const samples = await browser.execute(() => window.__TOUCHAI_SUBMIT_SAMPLES__);
        const heights = (samples.heights ?? []).filter(
            (sample) => Number.isFinite(sample.frame) && Number.isFinite(sample.card)
        );
        const frameHeights = heights.map((sample) => sample.frame);
        const minHeight = Math.min(...frameHeights);
        const maxHeight = Math.max(...frameHeights);
        const startHeight = Number.isFinite(samples.startHeight) ? samples.startHeight : minHeight;
        const largestCardHostDelta = Math.max(
            ...heights.map((sample) => Math.abs(sample.card - sample.frame))
        );
        const largestCardOverflow = Math.max(
            ...heights.map((sample) => sample.card - sample.frame)
        );
        const settledCardHostDelta = Math.max(
            ...heights.slice(-10).map((sample) => Math.abs(sample.card - sample.frame))
        );
        const largestCardTopOffset = Math.max(
            ...heights.map((sample) => Math.abs(sample.cardTop - sample.frameTop))
        );
        const settledSamples = heights.slice(-10);
        // The card grows out of the middle, so during the animation its top is inset while its
        // bottom is not: what must hold is that it never leaves the host, and that it is
        // centered in the host once the animation is over.
        const settledCenterDelta = Math.max(
            ...settledSamples.map((sample) =>
                Math.abs(sample.cardTop + sample.card / 2 - (sample.frameTop + sample.frame / 2))
            )
        );
        // The inset only has to be constant once the host has settled: mid-transition a
        // frame and the native report can land one sampling tick apart.
        const hostInteriorOverheads = settledSamples.map(
            (sample) => sample.innerHeight - sample.frame
        );
        const hostInteriorOverheadSpread =
            hostInteriorOverheads.length > 0
                ? Math.max(...hostInteriorOverheads) - Math.min(...hostInteriorOverheads)
                : Number.POSITIVE_INFINITY;
        // The request fails without a configured model, so the conversation shrinks back
        // to its message height. Bounce detection therefore only covers the expansion.
        const expansionSamples = frameHeights.slice(0, frameHeights.indexOf(maxHeight) + 1);
        let runningMax = 0;
        let worstRegression = 0;
        for (const height of expansionSamples) {
            runningMax = Math.max(runningMax, height);
            worstRegression = Math.max(worstRegression, runningMax - height);
        }
        const settledSpread =
            settledSamples.length > 0
                ? Math.max(...settledSamples.map((sample) => sample.frame)) -
                  Math.min(...settledSamples.map((sample) => sample.frame))
                : Number.POSITIVE_INFINITY;
        const settled = heights[heights.length - 1];
        if (
            heights.length < 20 ||
            maxHeight - startHeight < 80 ||
            largestCardOverflow > 1 ||
            settledCardHostDelta > 1 ||
            settledCenterDelta > 1 ||
            hostInteriorOverheadSpread > 2 ||
            worstRegression > 2 ||
            settledSpread > 1 ||
            !settled ||
            settled.scrollHeight > settled.clientHeight + 2 ||
            settled.frame >= settled.innerHeight
        ) {
            throw new Error(
                `Expected the native host to grow to the submit content height while the card stayed equal to its interior, received ${JSON.stringify(
                    {
                        sampleCount: heights.length,
                        startHeight,
                        minHeight,
                        maxHeight,
                        largestCardHostDelta,
                        largestCardOverflow,
                        settledCardHostDelta,
                        largestCardTopOffset,
                        hostInteriorOverheadSpread,
                        worstRegression,
                        settledSpread,
                        settledOverflow: settled
                            ? settled.scrollHeight - settled.clientHeight
                            : null,
                        frameSamples: heights.slice(0, 24).map((sample) => ({
                            t: sample.t,
                            frame: sample.frame,
                            card: sample.card,
                            innerHeight: sample.innerHeight,
                        })),
                    }
                )}`
            );
        }
    });
});
