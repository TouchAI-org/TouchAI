/** Bounded focus diagnostics for the native runner; never record input values. */
export async function startFocusTrace() {
    await browser.execute(() => {
        const original = HTMLElement.prototype.focus;
        const events = [];
        const describe = (element) => {
            if (!(element instanceof HTMLElement)) return null;
            const host = element.closest('[data-search-overlay-host]');
            return {
                tag: element.tagName,
                editor: element.classList.contains('ProseMirror'),
                overlay: Boolean(host),
                motion: host?.getAttribute('data-motion-state') ?? null,
                visibility: getComputedStyle(element).visibility,
                inert: Boolean(element.closest('[inert]')),
            };
        };
        const record = (event) => {
            events.push({ at: Math.round(performance.now()), ...event });
            if (events.length > 80) events.shift();
        };
        const onFocus = (event) => record({ kind: 'focusin', target: describe(event.target) });
        const describeAncestors = (element) => {
            const ancestors = [];
            if (element.closest('[data-search-overlay-host]')) {
                for (let node = element; node && ancestors.length < 12; node = node.parentElement) {
                    const style = getComputedStyle(node);
                    ancestors.push({
                        ...describe(node),
                        inlineVisibility: node.style.visibility,
                        display: style.display,
                        opacity: style.opacity,
                        transition: style.transition,
                        animations: node.getAnimations().map((animation) => ({
                            state: animation.playState,
                            keyframes: animation.effect?.getKeyframes().map((frame) => ({
                                visibility: frame.visibility,
                                opacity: frame.opacity,
                            })),
                        })),
                    });
                }
            }
            return ancestors;
        };
        HTMLElement.prototype.focus = function (...args) {
            const target = describe(this);
            const stack = new Error().stack?.split('\n').slice(1, 7).join('\n');
            original.apply(this, args);
            record({
                kind: 'focus',
                target,
                accepted: document.activeElement === this,
                stack,
                ancestors: document.activeElement === this ? [] : describeAncestors(this),
            });
        };
        document.addEventListener('focusin', onFocus);
        window.__TOUCHAI_E2E_FOCUS_TRACE__ = {
            events,
            describe,
            restore: () => {
                HTMLElement.prototype.focus = original;
                document.removeEventListener('focusin', onFocus);
            },
        };
    });
}

export async function stopFocusTrace() {
    await browser.execute(() => {
        window.__TOUCHAI_E2E_FOCUS_TRACE__?.restore();
        delete window.__TOUCHAI_E2E_FOCUS_TRACE__;
    });
}

export async function expectFocused(element, message) {
    try {
        await browser.waitUntil(() => element.isFocused(), { timeoutMsg: message });
    } catch (error) {
        const diagnostics = await browser.execute(() => {
            const trace = window.__TOUCHAI_E2E_FOCUS_TRACE__;
            return {
                active: trace?.describe(document.activeElement),
                events: trace?.events,
                documentFocused: document.hasFocus(),
                visibility: document.visibilityState,
                viewport: [innerWidth, innerHeight],
                overlays: [...document.querySelectorAll('[data-search-overlay-host]')].map(
                    (host) => ({
                        ...trace?.describe(host),
                        bounds: host.getBoundingClientRect().toJSON(),
                        filter: trace?.describe(host.querySelector('input')),
                    })
                ),
            };
        });
        throw new Error(`${message}\nFocus diagnostics: ${JSON.stringify(diagnostics)}`, {
            cause: error,
        });
    }
}
