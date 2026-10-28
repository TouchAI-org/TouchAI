/**
 * A tiny W3C WebDriver client for tauri-driver.
 *
 * Only the handful of endpoints the recorder needs are implemented. Every call
 * throws with the driver's own error message so a failed step names what broke
 * instead of timing out silently.
 */

import { spawn } from 'node:child_process';

export const DRIVER_PORT = 4444;

/**
 * The app opens several webview windows: search, settings, tray menu, and
 * transient popups. Only the search window is the main surface.
 */
export function isSearchUrl(url) {
    const value = String(url ?? '');

    if (value.includes('/settings') || value.includes('/popup') || value.includes('/tray-menu')) {
        return false;
    }

    return value.endsWith('#/') || value === 'tauri://localhost';
}

export function isSettingsUrl(url) {
    return String(url ?? '').includes('/settings');
}

async function waitForPort(port, timeoutMs = 30000) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
        try {
            const response = await fetch(`http://127.0.0.1:${port}/status`, {
                signal: AbortSignal.timeout(1000),
            });
            if (response.ok) {
                return;
            }
        } catch {
            // Driver is still starting.
        }

        await new Promise((resolve) => setTimeout(resolve, 250));
    }

    throw new Error(`tauri-driver did not listen on port ${port} within ${timeoutMs}ms`);
}

export async function startDriver({ port = DRIVER_PORT, env = process.env } = {}) {
    const child = spawn('tauri-driver', ['--port', String(port)], {
        env,
        stdio: ['ignore', 'inherit', 'inherit'],
    });

    let exited = null;
    child.on('exit', (code, signal) => {
        exited = { code, signal };
    });

    await waitForPort(port);

    return {
        child,
        port,
        get exited() {
            return exited;
        },
        stop() {
            child.kill('SIGTERM');
        },
    };
}

export class Session {
    constructor(sessionId, port) {
        this.sessionId = sessionId;
        this.base = `http://127.0.0.1:${port}/session/${sessionId}`;
        this.currentWindow = null;
    }

    async call(path, { method = 'POST', body, timeoutMs = 60000 } = {}) {
        // WebKitWebDriver rejects a POST without a JSON body, even when the command
        // takes no parameters.
        const requestBody = body === undefined && method === 'POST' ? {} : body;
        const response = await fetch(`${this.base}${path}`, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: requestBody === undefined ? undefined : JSON.stringify(requestBody),
            signal: AbortSignal.timeout(timeoutMs),
        });

        const payload = await response.json().catch(() => ({}));

        if (!response.ok || payload?.value?.error) {
            const message = payload?.value?.message ?? `driver call ${method} ${path} failed`;
            throw new Error(message);
        }

        return payload.value;
    }

    async quit() {
        try {
            await fetch(this.base, { method: 'DELETE', signal: AbortSignal.timeout(10000) });
        } catch {
            // The driver may already be gone; quitting is best effort.
        }
    }

    async execute(script, args = []) {
        return this.call('/execute/sync', { body: { script, args } });
    }

    async executeAsync(script, args = []) {
        return this.call('/execute/async', { body: { script, args } });
    }

    async findElement(selector) {
        const element = await this.call('/element', {
            body: { using: 'css selector', value: selector },
        });
        return element['element-6066-11e4-a52e-4f735466cecf'];
    }

    /**
     * WebKitWebDriver does not implement the `displayed` endpoint, so visibility is
     * answered from the renderer instead.
     */
    async isDisplayed(selector) {
        return this.execute(
            `
      const element = document.querySelector(arguments[0]);
      if (!element) {
        return false;
      }
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      `,
            [selector]
        );
    }

    async waitForElement(selector, timeoutMs = 15000) {
        const startedAt = Date.now();
        let lastError = null;

        while (Date.now() - startedAt < timeoutMs) {
            try {
                const displayed = await this.isDisplayed(selector);

                if (displayed) {
                    return this.findElement(selector);
                }
            } catch (error) {
                lastError = error;
            }

            await new Promise((resolve) => setTimeout(resolve, 250));
        }

        throw new Error(
            `element ${selector} was not displayed within ${timeoutMs}ms${lastError ? `: ${lastError.message}` : ''}`
        );
    }

    async click(selector, { timeoutMs = 15000 } = {}) {
        const elementId = await this.waitForElement(selector, timeoutMs);
        await this.call(`/element/${elementId}/click`);
    }

    async hover(selector, { timeoutMs = 8000 } = {}) {
        const elementId = await this.waitForElement(selector);
        await this.call('/actions', {
            timeoutMs,
            body: {
                actions: [
                    {
                        type: 'pointer',
                        id: 'mouse',
                        parameters: { pointerType: 'mouse' },
                        actions: [
                            {
                                type: 'pointerMove',
                                origin: { 'element-6066-11e4-a52e-4f735466cecf': elementId },
                                x: 0,
                                y: 0,
                            },
                        ],
                    },
                ],
            },
        });
    }

    async type(selector, text) {
        const elementId = await this.waitForElement(selector);
        await this.call(`/element/${elementId}/click`);
        await this.call(`/element/${elementId}/value`, { body: { text } });
    }

    /**
     * Appends text to the focused element. The recorder calls this once per
     * character so typing is visible in the video.
     */
    async appendText(selector, text) {
        const elementId = await this.waitForElement(selector);
        await this.call(`/element/${elementId}/value`, { body: { text } });
    }

    async press(key) {
        await this.call('/actions', {
            body: {
                actions: [
                    {
                        type: 'key',
                        id: 'keyboard',
                        actions: [
                            { type: 'keyDown', value: key },
                            { type: 'keyUp', value: key },
                        ],
                    },
                ],
            },
        });
    }

    async scroll(pixels) {
        await this.call('/actions', {
            body: {
                actions: [
                    {
                        type: 'wheel',
                        id: 'wheel',
                        actions: [
                            { type: 'scroll', x: 0, y: 0, deltaX: 0, deltaY: Number(pixels) },
                        ],
                    },
                ],
            },
        });
    }

    async windowHandles() {
        return this.call('/window/handles', { method: 'GET' });
    }

    async switchTo(handle) {
        await this.call('/window', { body: { handle } });
        this.currentWindow = handle;
    }

    async currentUrl() {
        return this.call('/url', { method: 'GET' });
    }

    /**
     * Switches to the window whose URL contains the fragment, creating it first if
     * needed. Returns the handle so the caller can switch back.
     */
    async switchToWindowContaining(fragment, timeoutMs = 15000) {
        const startedAt = Date.now();

        while (Date.now() - startedAt < timeoutMs) {
            for (const handle of await this.windowHandles()) {
                await this.switchTo(handle);
                const url = await this.currentUrl();

                if (String(url).includes(fragment)) {
                    return handle;
                }
            }

            await new Promise((resolve) => setTimeout(resolve, 250));
        }

        throw new Error(`no window whose URL contains ${fragment} appeared`);
    }
}

export async function createSession({ port = DRIVER_PORT, application }) {
    const response = await fetch(`http://127.0.0.1:${port}/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            capabilities: {
                alwaysMatch: {
                    browserName: 'wry',
                    'tauri:options': { application },
                },
            },
        }),
        signal: AbortSignal.timeout(120000),
    });

    const payload = await response.json().catch(() => ({}));

    if (!response.ok || !payload?.value?.sessionId) {
        throw new Error(
            `could not start a WebDriver session: ${payload?.value?.message ?? response.status}`
        );
    }

    const session = new Session(payload.value.sessionId, port);
    const handles = await session.windowHandles();

    for (const handle of handles) {
        await session.switchTo(handle);
        const url = await session.currentUrl();

        if (isSearchUrl(url)) {
            return session;
        }
    }

    if (handles.length > 0) {
        await session.switchTo(handles[0]);
    }

    return session;
}
