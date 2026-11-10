import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    callE2eBridge,
    resetSearchSurface,
    switchToWindowContaining,
    useInterfaceLanguage,
    useProductFont,
    useSearchFixture,
    waitForE2eBridge,
    waitForTestIdDisplayed,
} from '../test/support/desktop.js';
import { SEARCH_FIXTURE_QUERY, SEARCH_FIXTURE_RESULTS } from '../test/support/fixtures.js';

const report = {
    variant: process.env.TOUCHAI_PERF_VARIANT,
    commit: process.env.TOUCHAI_PERF_COMMIT,
    block: Number(process.env.TOUCHAI_PERF_BLOCK),
    cases: {},
    memory: [],
};

async function measureFlow(kind) {
    return browser.execute(async (flow) => {
        const warmup = 5;
        const samples = 50;
        const openMs = [];
        const closeMs = [];
        const longTasks = [];
        const observer = new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) longTasks.push(entry.duration);
        });
        observer.observe({ type: 'longtask' });
        const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
        const requireElement = (selector) => {
            const element = document.querySelector(selector);
            if (!(element instanceof HTMLElement)) throw new Error(`Missing ${selector}`);
            return element;
        };
        const settled = (element) => {
            if (!element || element.getBoundingClientRect().height === 0) return false;
            if (Number(getComputedStyle(element).opacity) < 0.99) return false;
            return element
                .getAnimations({ subtree: true })
                .every(
                    (animation) =>
                        animation.effect?.getComputedTiming().iterations === Infinity ||
                        animation.playState === 'finished' ||
                        animation.playState === 'idle'
                );
        };
        const waitFor = async (predicate, label) => {
            const deadline = performance.now() + 10000;
            let stableFrames = 0;
            while (performance.now() < deadline) {
                await frame();
                stableFrames = predicate() ? stableFrames + 1 : 0;
                if (stableFrames === 2) return;
            }
            throw new Error(`Native ${flow} did not ${label}`);
        };
        const selector = {
            menu: '[data-context-menu-id]',
            model: '[data-search-overlay-host]',
            confirm: '[role="alertdialog"]',
            import: '[role="dialog"]',
        }[flow];
        const open = () => {
            if (flow === 'menu') {
                const item = requireElement('[data-testid="quick-search-panel"] button');
                const rect = item.getBoundingClientRect();
                item.dispatchEvent(
                    new MouseEvent('contextmenu', {
                        bubbles: true,
                        cancelable: true,
                        clientX: rect.x + 10,
                        clientY: rect.y + 10,
                    })
                );
            } else if (flow === 'model') {
                requireElement('[data-testid="search-view"]').dispatchEvent(
                    new KeyboardEvent('keydown', {
                        bubbles: true,
                        cancelable: true,
                        key: 'm',
                        code: 'KeyM',
                        ctrlKey: true,
                    })
                );
            } else {
                requireElement(
                    flow === 'confirm'
                        ? '[data-testid="settings-diagnostics-export"]'
                        : '[data-settings-search-target="import-settings"] button'
                ).click();
            }
        };
        try {
            for (let sample = 0; sample < warmup + samples; sample += 1) {
                const openedAt = performance.now();
                open();
                await waitFor(() => {
                    const element = document.querySelector(selector);
                    return (
                        settled(element) &&
                        (flow !== 'model' || element.dataset.motionState === 'open')
                    );
                }, 'open');
                const openDuration = performance.now() - openedAt;
                const closedAt = performance.now();
                if (flow === 'model') open();
                else
                    requireElement(selector).dispatchEvent(
                        new KeyboardEvent('keydown', {
                            key: 'Escape',
                            code: 'Escape',
                            bubbles: true,
                            cancelable: true,
                        })
                    );
                await waitFor(() => !document.querySelector(selector), 'close');
                if (flow === 'confirm') {
                    await waitFor(
                        () =>
                            !requireElement('[data-testid="settings-diagnostics-export"]').disabled,
                        'release export'
                    );
                }
                if (sample >= warmup) {
                    openMs.push(openDuration);
                    closeMs.push(performance.now() - closedAt);
                }
            }
            for (let frameIndex = 0; frameIndex < 120; frameIndex += 1) await frame();
            return {
                openMs,
                closeMs,
                longTasks,
                dom: document.body.querySelectorAll('*').length,
                environment: {
                    userAgent: navigator.userAgent,
                    dpr: devicePixelRatio,
                    width: innerWidth,
                    height: innerHeight,
                    reducedMotion:
                        matchMedia('(prefers-reduced-motion: reduce)').matches ||
                        document.documentElement.hasAttribute('data-reduced-motion'),
                    visibility: document.visibilityState,
                },
            };
        } finally {
            observer.disconnect();
        }
    }, kind);
}

describe('user completes native lifecycle interactions within the release performance budget', () => {
    before(async () => {
        await browser.setTimeout({ script: 120000 });
        await waitForE2eBridge();
        await useInterfaceLanguage();
        await useProductFont();
    });

    it('user repeatedly opens and dismisses result menus without accumulating resources', async () => {
        await useSearchFixture(SEARCH_FIXTURE_QUERY, SEARCH_FIXTURE_RESULTS);
        await callE2eBridge('setSearchQuery', SEARCH_FIXTURE_QUERY);
        await waitForTestIdDisplayed('quick-search-panel');
        await $('[data-testid="quick-search-panel"] button').waitForDisplayed();
        report.cases.menu = await measureFlow('menu');
    });

    it('user repeatedly opens and dismisses the model overlay without delaying its native reveal', async () => {
        await resetSearchSurface();
        report.cases.model = await measureFlow('model');
    });

    it('user repeatedly cancels confirmation and import dialogs without accumulating native memory', async () => {
        await callE2eBridge('openSettingsWindow');
        await switchToWindowContaining('/settings');
        await waitForTestIdDisplayed('settings-view');
        await useProductFont();
        await (await waitForTestIdDisplayed('settings-nav-data-management')).click();
        await waitForTestIdDisplayed('settings-diagnostics-export');
        report.cases.confirm = await measureFlow('confirm');
        report.cases.import = await measureFlow('import');
        const memoryScript = path.join(
            path.dirname(fileURLToPath(import.meta.url)),
            'process-memory.ps1'
        );
        for (let sample = 0; sample < 5; sample += 1) {
            report.memory.push(
                JSON.parse(
                    execFileSync(
                        'powershell.exe',
                        ['-NoProfile', '-NonInteractive', '-File', memoryScript],
                        { encoding: 'utf8', windowsHide: true }
                    )
                )
            );
        }
        writeFileSync(process.env.TOUCHAI_PERF_REPORT, JSON.stringify(report, null, 2));
    });
});
