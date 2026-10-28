/**
 * Shared app-driving helpers for the explore and record jobs.
 *
 * Both jobs boot the same binary the same way: Xvfb with a window manager, a
 * tauri-driver session, and the app's own E2E bridge. Nothing here reads or
 * writes user data; the app runs against a temporary root.
 */

import { OVERLAY_SCRIPT } from './overlay.mjs';
import { createSession, isSearchUrl, startDriver } from './webdriver.mjs';

export const MAIN_WINDOW_TIMEOUT_MS = 30000;

export async function boot({ application, port = 4444 }) {
    const driver = await startDriver({ port });

    let session;
    try {
        session = await createSession({ port, application });
    } catch (error) {
        // `exited` separates "the driver died" from "the driver waited and the
        // app never registered", which are fixed in different places.
        console.error(
            `ui-preview: WebDriver session failed on port ${port} (driver exited: ${JSON.stringify(driver.exited)})`
        );
        // A driver left running keeps the port, so the next boot fails to bind
        // and reports a port conflict instead of the original session error.
        driver.stop();
        throw error;
    }

    return {
        driver,
        session,
        async close() {
            await session.quit();
            driver.stop();
        },
    };
}

export async function ensureOverlay(session) {
    try {
        await session.execute(OVERLAY_SCRIPT);
    } catch {
        // A window that is still loading can reject the injection; the next call
        // retries after the surface is ready.
    }
}

export async function waitForBridge(session, timeoutMs = 30000) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
        try {
            const ready = await session.execute('return Boolean(window.__TOUCHAI_E2E__);');

            if (ready) {
                return true;
            }
        } catch {
            // Renderer is still starting.
        }

        await new Promise((resolve) => setTimeout(resolve, 300));
    }

    throw new Error('the app did not expose its E2E bridge');
}

export async function bridge(session, method, args = []) {
    const result = await session.executeAsync(
        `
        const done = arguments[arguments.length - 1];
        const name = arguments[0];
        const bridgeArgs = arguments[1] || [];
        const bridge = window.__TOUCHAI_E2E__;
        if (!bridge || typeof bridge[name] !== 'function') {
            done({ ok: false, error: 'bridge method ' + name + ' is unavailable' });
            return;
        }
        Promise.resolve(bridge[name](...bridgeArgs))
            .then(() => done({ ok: true }))
            .catch((error) => done({ ok: false, error: String(error) }));
        `,
        [method, args]
    );

    if (!result?.ok) {
        throw new Error(result?.error ?? `bridge call ${method} failed`);
    }
}

export async function windowHandles(session) {
    return session.windowHandles();
}

export async function mainWindowHandle(session) {
    for (const handle of await session.windowHandles()) {
        await session.switchTo(handle);
        const url = String(await session.currentUrl());

        if (isSearchUrl(url)) {
            return handle;
        }
    }

    throw new Error('the main window was not found');
}

export async function openSettings(session) {
    const main = await mainWindowHandle(session);
    await bridge(session, 'openSettingsWindow');
    const settings = await session.switchToWindowContaining('/settings');
    await session.waitForElement("[data-testid='settings-view']");
    await ensureOverlay(session);

    return { main, settings };
}

export async function switchToSurface(session, surface, state = {}) {
    if (surface === 'settings') {
        const handle = state.settingsHandle ?? (await openSettings(session)).settings;
        await session.switchTo(handle);
        await session.waitForElement("[data-testid='settings-view']");
        await ensureOverlay(session);
        return handle;
    }

    const handle = state.mainHandle ?? (await mainWindowHandle(session));
    await session.switchTo(handle);
    await session.waitForElement("[data-testid='search-view']");
    await ensureOverlay(session);
    return handle;
}

export async function collectTestIds(session) {
    const ids = await session.execute(`
        const values = new Set();
        for (const element of document.querySelectorAll('[data-testid]')) {
            values.add(element.getAttribute('data-testid'));
        }
        return [...values].sort();
    `);

    return Array.isArray(ids) ? ids : [];
}

export async function collectSettingsSections(session) {
    const ids = await session.execute(`
        const values = new Set();
        for (const element of document.querySelectorAll('[data-testid^="settings-"][data-testid$="-section"]')) {
            values.add(element.getAttribute('data-testid'));
        }
        return [...values].sort();
    `);

    return Array.isArray(ids) ? ids : [];
}

/**
 * A compact map of what is on screen, so the planner knows which test id is a
 * button, a field, or a heading, and which ones sit below the fold.
 *
 * Only test ids can be clicked, but the surrounding labels and roles are what
 * let the model choose the right one. Elements without a test id are kept as
 * context when they are interactive or carry text.
 */
export async function collectOutline(session, limit = 60, skip = []) {
    const outline = await session.execute(
        `
        const max = Number(arguments[0]) || 60;
        const skip = new Set(arguments[1] || []);
        const rows = [];
        const interactive = 'button,a,input,select,textarea,summary';
        const roles = new Set(['button', 'link', 'tab', 'switch', 'checkbox', 'menuitem', 'option']);
        const ownText = (element) =>
            [...element.childNodes]
                .filter((node) => node.nodeType === 3)
                .map((node) => node.textContent.trim())
                .join(' ')
                .replace(/\\s+/g, ' ')
                .trim();
        const attributeLabel = (element) =>
            String(
                element.getAttribute('aria-label') ||
                    element.getAttribute('placeholder') ||
                    element.getAttribute('title') ||
                    ''
            )
                .replace(/\\s+/g, ' ')
                .trim();

        for (const element of document.querySelectorAll('body *')) {
            if (rows.length >= max) {
                break;
            }

            if (element.closest('#__ui_preview_overlay') || element.closest('[data-ui-preview]')) {
                continue;
            }

            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);

            if (
                rect.width < 2 ||
                rect.height < 2 ||
                style.visibility === 'hidden' ||
                style.display === 'none' ||
                Number(style.opacity) === 0
            ) {
                continue;
            }

            const testId = element.getAttribute('data-testid');

            if (testId && skip.has(testId)) {
                continue;
            }

            // A label inside a control that already has a test id is the same
            // thing twice; keep the control.
            if (!testId && element.closest('[data-testid]')) {
                continue;
            }

            const tag = element.tagName.toLowerCase();
            const role = element.getAttribute('role') || '';
            const isInteractive =
                interactive.split(',').includes(tag) || roles.has(role) || element.tabIndex >= 0;
            // A button often holds its label in a child span, so interactive
            // elements read their whole text; a container would read the page.
            const text = (
                (isInteractive ? element.innerText || '' : ownText(element)) ||
                attributeLabel(element)
            )
                .replace(/\\s+/g, ' ')
                .trim()
                .slice(0, 40);

            if (!testId && !text) {
                continue;
            }

            rows.push({
                testId,
                tag,
                role: role || (isInteractive ? tag : ''),
                text,
                belowFold: rect.top >= window.innerHeight || rect.bottom <= 0,
            });
        }

        return rows;
        `,
        [limit, skip]
    );

    return Array.isArray(outline) ? outline : [];
}

/**
 * Walks every settings section once so the plan can only target ids that the
 * build really renders.
 */
export async function collectSettingsOutline(session, elements = {}) {
    const navIds = (await collectTestIds(session)).filter((id) => id.startsWith('settings-nav-'));
    const sections = new Set();
    const testIds = new Set();
    const seen = new Set();

    for (const id of navIds) {
        try {
            await session.click(`[data-testid='${id}']`);
            await new Promise((resolve) => setTimeout(resolve, 450));

            for (const testId of await collectTestIds(session)) {
                testIds.add(testId);
            }

            for (const section of await collectSettingsSections(session)) {
                sections.add(section);
            }

            elements[id] = await collectOutline(session, 40, [...seen]);

            for (const row of elements[id]) {
                if (row.testId) {
                    seen.add(row.testId);
                }
            }
        } catch {
            // A section that cannot be opened is simply not offered to the plan.
        }
    }

    return { navIds, sections: [...sections].sort(), testIds: [...testIds].sort(), elements };
}

export async function measureOverflow(session) {
    const result = await session.execute(`
        return {
            innerWidth: window.innerWidth,
            scrollWidth: document.documentElement.scrollWidth,
            innerHeight: window.innerHeight,
            scrollHeight: document.documentElement.scrollHeight,
        };
    `);

    const overflowX = Math.max(
        0,
        Number(result?.scrollWidth ?? 0) - Number(result?.innerWidth ?? 0)
    );

    return {
        innerWidth: Number(result?.innerWidth ?? 0),
        innerHeight: Number(result?.innerHeight ?? 0),
        overflowX,
    };
}

/**
 * Puts the settings content back at the top.
 *
 * The sections share one scroll container, so scrolling the shortcut list and
 * then opening another section left that section mid-page: its title and its
 * first control were above the viewport, in the video and in every screenshot.
 */
export async function resetContentScroll(session) {
    try {
        await session.execute(`
            const root = document.querySelector('[data-testid="settings-view"]');
            if (!root) {
                return false;
            }
            const scrollers = [root, ...root.querySelectorAll('*')].filter((element) => {
                const style = getComputedStyle(element);
                return (
                    ['auto', 'scroll'].includes(style.overflowY) &&
                    element.scrollHeight - element.clientHeight > 80
                );
            });
            for (const element of scrollers) {
                element.scrollTop = 0;
            }
            window.scrollTo(0, 0);
            return true;
        `);
    } catch {
        // A window that is closing has no scroll state to reset.
    }
}
