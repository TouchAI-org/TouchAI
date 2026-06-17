type TouchAiHost = HTMLElement & {
    __touchaiMounted?: boolean;
    __touchaiReady?: boolean;
    __touchaiLoadVersion?: number;
    __touchaiController?: AbortController | null;
    __touchaiMessageHandlers?: Set<TouchAiMessageHandler>;
    __touchaiWindowHandlers?: Map<
        EventListenerOrEventListenerObject,
        EventListenerOrEventListenerObject
    >;
    __touchaiPendingMessages?: unknown[];
    __touchaiResizeObservers?: ResizeObserver[];
    postMessage?: (data: unknown) => void;
    reload?: () => Promise<void>;
};

type TouchAiMessageHandler = (event: { data: unknown }) => void;

type TouchAiRuntime = {
    mount: (id: string) => TouchAiHost | null;
    mountAll: () => void;
    send: (target: string | TouchAiHost | null | undefined, data: unknown) => boolean;
};

declare global {
    interface Window {
        __touchaiLightDemoRuntime?: TouchAiRuntime;
    }
}

const loadedScripts = new Map<string, Promise<void>>();
const loadedStyles = new Set<string>();
const unsafeUrlAttributes = new Set(['href', 'src', 'xlink:href', 'manifest', 'formaction']);
const unsafeHtmlAttributes = new Set(['srcdoc']);

const hostCssFor = (id: string) => `
touchai-component-demo[data-demo-id="${id}"] {
    display: block;
    width: 100%;
    height: 100%;
    overflow: hidden;
    border-radius: inherit;
    isolation: isolate;
    background: var(--page-bg, transparent);
    color-scheme: light;
}

touchai-component-demo[data-demo-id="${id}"].component-frame {
    width: min(60vw, 680px, 100%) !important;
    max-width: min(680px, 100%);
    justify-self: center;
    overflow: visible !important;
}

touchai-component-demo[data-demo-id="${id}"].component-frame .stage {
    width: 100% !important;
    max-width: 100% !important;
}

touchai-component-demo[data-demo-id="${id}"].feature-component-frame,
touchai-component-demo[data-demo-id="${id}"].feature-work-frame,
touchai-component-demo[data-demo-id="${id}"].feature-reminder-frame {
    display: flex;
    align-items: stretch;
    justify-content: center;
    width: 760px !important;
    height: 657px !important;
    min-height: 657px !important;
    max-height: 657px !important;
    overflow: visible !important;
    background: transparent !important;
}

touchai-component-demo[data-demo-id="${id}"].feature-component-frame .stage,
touchai-component-demo[data-demo-id="${id}"].feature-work-frame .stage,
touchai-component-demo[data-demo-id="${id}"].feature-reminder-frame .stage {
    width: 100% !important;
    min-height: 100% !important;
    height: 100% !important;
    padding: 0 !important;
    justify-content: flex-start !important;
    align-items: center !important;
}

touchai-component-demo[data-demo-id="${id}"].component-frame .chat-panel,
touchai-component-demo[data-demo-id="${id}"].feature-component-frame .chat-panel,
touchai-component-demo[data-demo-id="${id}"].feature-work-frame .chat-panel,
touchai-component-demo[data-demo-id="${id}"].feature-reminder-frame .chat-panel {
    margin: 0 auto !important;
    box-shadow:
        0 34px 90px rgba(107, 114, 128, 0.22),
        0 12px 34px rgba(107, 114, 128, 0.12),
        0 0 48px rgba(107, 114, 128, 0.14) !important;
}

touchai-component-demo[data-demo-id="${id}"].is-scroll-driven .chat-panel {
    will-change: auto !important;
}

touchai-component-demo[data-demo-id="${id}"].component-frame .chat-panel {
    width: 100% !important;
    max-width: 100% !important;
}

touchai-component-demo[data-demo-id="${id}"].component-frame.is-idle .chat-panel {
    border-radius: 8px !important;
    overflow: hidden !important;
    background: var(--panel, #fff) !important;
}

touchai-component-demo[data-demo-id="${id}"].component-frame .conversation-content {
    flex: 1 1 auto !important;
    min-height: 0 !important;
    overflow-y: auto !important;
    padding-bottom: 18px !important;
    overscroll-behavior: contain !important;
    scrollbar-width: none !important;
    -webkit-overflow-scrolling: touch !important;
}

touchai-component-demo[data-demo-id="${id}"].component-frame .conversation-content,
touchai-component-demo[data-demo-id="${id}"].feature-component-frame .conversation-content,
touchai-component-demo[data-demo-id="${id}"].feature-work-frame .conversation-content,
touchai-component-demo[data-demo-id="${id}"].feature-reminder-frame .conversation-content {
    min-height: 0 !important;
    overflow-y: auto !important;
    overscroll-behavior: contain !important;
    scrollbar-width: none !important;
    -webkit-overflow-scrolling: touch !important;
}

touchai-component-demo[data-demo-id="${id}"].component-frame .conversation-content::-webkit-scrollbar,
touchai-component-demo[data-demo-id="${id}"].feature-component-frame .conversation-content::-webkit-scrollbar,
touchai-component-demo[data-demo-id="${id}"].feature-work-frame .conversation-content::-webkit-scrollbar,
touchai-component-demo[data-demo-id="${id}"].feature-reminder-frame .conversation-content::-webkit-scrollbar {
    display: none;
}

touchai-component-demo[data-demo-id="${id}"].component-frame.is-answering .chat-panel,
touchai-component-demo[data-demo-id="${id}"].component-frame.is-complete .chat-panel,
touchai-component-demo[data-demo-id="${id}"].feature-component-frame.is-answering .chat-panel,
touchai-component-demo[data-demo-id="${id}"].feature-component-frame.is-complete .chat-panel,
touchai-component-demo[data-demo-id="${id}"].feature-work-frame.is-answering .chat-panel,
touchai-component-demo[data-demo-id="${id}"].feature-work-frame.is-complete .chat-panel,
touchai-component-demo[data-demo-id="${id}"].feature-reminder-frame.is-answering .chat-panel,
touchai-component-demo[data-demo-id="${id}"].feature-reminder-frame.is-complete .chat-panel {
    display: flex !important;
    flex-direction: column !important;
    max-width: 100% !important;
}

touchai-component-demo[data-demo-id="${id}"].feature-component-frame.is-answering .stage,
touchai-component-demo[data-demo-id="${id}"].feature-component-frame.is-complete .stage,
touchai-component-demo[data-demo-id="${id}"].feature-work-frame.is-answering .stage,
touchai-component-demo[data-demo-id="${id}"].feature-work-frame.is-complete .stage,
touchai-component-demo[data-demo-id="${id}"].feature-reminder-frame.is-answering .stage,
touchai-component-demo[data-demo-id="${id}"].feature-reminder-frame.is-complete .stage {
    justify-content: flex-start !important;
}

touchai-component-demo[data-demo-id="${id}"].feature-component-frame.is-complete .chat-panel,
touchai-component-demo[data-demo-id="${id}"].feature-work-frame.is-complete .chat-panel,
touchai-component-demo[data-demo-id="${id}"].feature-reminder-frame.is-complete .chat-panel,
touchai-component-demo[data-demo-id="${id}"].feature-component-frame.is-scroll-driven.is-complete .chat-panel,
touchai-component-demo[data-demo-id="${id}"].feature-work-frame.is-scroll-driven.is-complete .chat-panel,
touchai-component-demo[data-demo-id="${id}"].feature-reminder-frame.is-scroll-driven.is-complete .chat-panel {
    min-height: 0 !important;
    height: auto !important;
}

touchai-component-demo[data-demo-id="${id}"].component-frame.is-answering .conversation-content,
touchai-component-demo[data-demo-id="${id}"].component-frame.is-complete .conversation-content,
touchai-component-demo[data-demo-id="${id}"].feature-component-frame.is-answering .conversation-content,
touchai-component-demo[data-demo-id="${id}"].feature-component-frame.is-complete .conversation-content,
touchai-component-demo[data-demo-id="${id}"].feature-work-frame.is-answering .conversation-content,
touchai-component-demo[data-demo-id="${id}"].feature-work-frame.is-complete .conversation-content,
touchai-component-demo[data-demo-id="${id}"].feature-reminder-frame.is-answering .conversation-content,
touchai-component-demo[data-demo-id="${id}"].feature-reminder-frame.is-complete .conversation-content {
    flex: 1 1 auto !important;
    min-height: 0 !important;
    overflow-y: auto !important;
    padding-bottom: 20px !important;
    overscroll-behavior: contain !important;
    -webkit-overflow-scrolling: touch !important;
}

touchai-component-demo[data-demo-id="${id}"].component-frame.is-answering .composer,
touchai-component-demo[data-demo-id="${id}"].component-frame.is-complete .composer,
touchai-component-demo[data-demo-id="${id}"].feature-component-frame.is-answering .composer,
touchai-component-demo[data-demo-id="${id}"].feature-component-frame.is-complete .composer,
touchai-component-demo[data-demo-id="${id}"].feature-work-frame.is-answering .composer,
touchai-component-demo[data-demo-id="${id}"].feature-work-frame.is-complete .composer,
touchai-component-demo[data-demo-id="${id}"].feature-reminder-frame.is-answering .composer,
touchai-component-demo[data-demo-id="${id}"].feature-reminder-frame.is-complete .composer {
    margin-top: auto !important;
}

@media (max-width: 900px) {
    touchai-component-demo[data-demo-id="${id}"].component-frame {
        width: min(60vw, 520px, 100%) !important;
        height: auto !important;
        min-height: 0 !important;
        aspect-ratio: 760 / 657 !important;
        max-height: min(62vh, 657px) !important;
    }

    touchai-component-demo[data-demo-id="${id}"].component-frame .stage {
        height: 100% !important;
        min-height: 0 !important;
    }
}

@media (max-height: 780px) {
    touchai-component-demo[data-demo-id="${id}"].component-frame {
        width: min(52vw, 560px, 100%) !important;
        max-width: min(560px, 100%) !important;
        height: auto !important;
        min-height: 0 !important;
        aspect-ratio: 760 / 657 !important;
        max-height: min(60vh, 520px) !important;
        overflow: hidden !important;
    }

    touchai-component-demo[data-demo-id="${id}"].component-frame .stage {
        min-height: 0 !important;
        height: 100% !important;
        padding: 0 !important;
        align-items: center !important;
        justify-content: center !important;
    }

    touchai-component-demo[data-demo-id="${id}"].component-frame.is-answering .chat-panel,
    touchai-component-demo[data-demo-id="${id}"].component-frame.is-complete .chat-panel,
    touchai-component-demo[data-demo-id="${id}"].component-frame.is-scroll-driven.is-answering .chat-panel,
    touchai-component-demo[data-demo-id="${id}"].component-frame.is-scroll-driven.is-complete .chat-panel {
        display: flex !important;
        flex-direction: column !important;
        max-width: 100% !important;
    }
}

@media (max-width: 560px) {
    touchai-component-demo[data-demo-id="${id}"].component-frame {
        width: min(calc(100vw - 56px), 360px, 100%) !important;
        max-width: min(calc(100vw - 56px), 360px, 100%) !important;
        height: auto !important;
        min-height: 0 !important;
        aspect-ratio: 760 / 657 !important;
        max-height: min(58vh, 420px) !important;
        overflow: visible !important;
    }

    touchai-component-demo[data-demo-id="${id}"].component-frame .stage {
        min-height: 0 !important;
        height: 100% !important;
        padding: 0 !important;
        align-items: center !important;
        justify-content: center !important;
    }
}
`;

const resolveUrl = (value: string, baseUrl: string) => {
    if (!value || value.startsWith('data:') || value.startsWith('#')) return value;
    const url = new URL(value, baseUrl);
    return `${url.pathname}${url.search}${url.hash}`;
};

const normalizeSelector = (selectorText: string, hostSelector: string) => {
    const trimmed = selectorText.trim();
    if (!trimmed) return '';
    if (trimmed.startsWith('@')) return trimmed;
    if (trimmed.startsWith('from') || trimmed.startsWith('to') || /^\d+%$/.test(trimmed))
        return trimmed;

    const scoped = trimmed
        .replace(/:root/g, hostSelector)
        .replace(/\bhtml\s*,\s*body\b/g, hostSelector)
        .replace(/\bbody((?:\.[\w-]+)+)/g, (_match, classes) => `${hostSelector}${classes}`)
        .replace(/\bbody\b/g, hostSelector)
        .replace(/\bhtml\b/g, hostSelector);

    if (scoped.startsWith(hostSelector)) {
        return scoped;
    }

    return `${hostSelector} ${scoped}`;
};

const scopeSelectorList = (selectorText: string, hostSelector: string) =>
    selectorText
        .split(',')
        .map((part) => normalizeSelector(part, hostSelector))
        .filter(Boolean)
        .join(', ');

const scopeCss = (css: string, hostSelector: string) => {
    let index = 0;

    const consumeBlock = (): string => {
        let output = '';
        let selectorBuffer = '';

        while (index < css.length) {
            const char = css[index];

            if (char === '"' || char === "'") {
                const quote = char;
                selectorBuffer += char;
                index += 1;
                while (index < css.length) {
                    const innerChar = css[index];
                    selectorBuffer += innerChar;
                    index += 1;
                    if (innerChar === '\\') {
                        if (index < css.length) {
                            selectorBuffer += css[index];
                            index += 1;
                        }
                        continue;
                    }
                    if (innerChar === quote) break;
                }
                continue;
            }

            if (char === '/' && css[index + 1] === '*') {
                const end = css.indexOf('*/', index + 2);
                const comment = end === -1 ? css.slice(index) : css.slice(index, end + 2);
                selectorBuffer += comment;
                index = end === -1 ? css.length : end + 2;
                continue;
            }

            if (char === '{') {
                const selector = selectorBuffer.trim();
                selectorBuffer = '';
                index += 1;

                if (
                    selector.startsWith('@keyframes') ||
                    selector.startsWith('@-webkit-keyframes')
                ) {
                    const keyframeBodyStart = index;
                    let depth = 1;
                    while (index < css.length && depth > 0) {
                        if (css[index] === '{') depth += 1;
                        if (css[index] === '}') depth -= 1;
                        index += 1;
                    }
                    output += `${selector}{${css.slice(keyframeBodyStart, index - 1)}}`;
                    continue;
                }

                if (selector.startsWith('@')) {
                    const inner = consumeBlock();
                    output += `${selector}{${inner}}`;
                    continue;
                }

                const bodyStart = index;
                let depth = 1;
                while (index < css.length && depth > 0) {
                    if (css[index] === '{') depth += 1;
                    if (css[index] === '}') depth -= 1;
                    index += 1;
                }
                const body = css.slice(bodyStart, index - 1);
                output += `${scopeSelectorList(selector, hostSelector)}{${body}}`;
                continue;
            }

            if (char === '}') {
                index += 1;
                output += selectorBuffer;
                return output;
            }

            selectorBuffer += char;
            index += 1;
        }

        output += selectorBuffer;
        return output;
    };

    return consumeBlock();
};

const loadExternalStyle = (href: string) => {
    if (loadedStyles.has(href)) return;
    loadedStyles.add(href);
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    document.head.appendChild(link);
};

const parseHtml = (html: string) => new DOMParser().parseFromString(html, 'text/html');

const normalizeUrlScheme = (value: string) => {
    let normalized = '';
    for (const character of value) {
        const code = character.charCodeAt(0);
        // Prevent scheme obfuscation such as "java\0script:" or "java\tscript:".
        if (code <= 0x1f || code === 0x7f || character.trim() === '') continue;
        normalized += character;
    }
    return normalized.toLowerCase();
};

const isUnsafeUrl = (value: string) => {
    const normalized = normalizeUrlScheme(value);
    return (
        normalized.startsWith('javascript:') ||
        normalized.startsWith('vbscript:') ||
        normalized.startsWith('data:')
    );
};

const resolveSafeExternalUrl = (value: string, baseUrl: string) => {
    if (isUnsafeUrl(value)) return null;
    const resolved = resolveUrl(value, baseUrl);
    return isUnsafeUrl(resolved) ? null : resolved;
};

const sanitizeClonedBody = (bodyContent: HTMLElement) => {
    bodyContent.querySelectorAll<HTMLElement>('*').forEach((node) => {
        [...node.attributes].forEach((attribute) => {
            const name = attribute.name.toLowerCase();
            if (name.startsWith('on')) {
                node.removeAttribute(attribute.name);
                return;
            }

            if (
                unsafeHtmlAttributes.has(name) ||
                (unsafeUrlAttributes.has(name) && isUnsafeUrl(attribute.value))
            ) {
                node.removeAttribute(attribute.name);
            }
        });
    });
};

const loadExternalScript = (src: string) => {
    if (loadedScripts.has(src)) return loadedScripts.get(src)!;
    const promise = new Promise<void>((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.async = false;
        script.onload = () => resolve();
        script.onerror = () => {
            loadedScripts.delete(src);
            reject(new Error(`Failed to load script: ${src}`));
        };
        document.head.appendChild(script);
    });
    loadedScripts.set(src, promise);
    return promise;
};

const getMessageType = (data: unknown) =>
    typeof data === 'object' && data && 'type' in (data as Record<string, unknown>)
        ? String((data as Record<string, unknown>).type)
        : '';

const getMessageProgress = (data: unknown) =>
    typeof data === 'object' && data && 'progress' in (data as Record<string, unknown>)
        ? Number((data as Record<string, unknown>).progress)
        : NaN;

const isScrollDrivenProgressType = (messageType: string) =>
    messageType === 'touchai-set-progress' || messageType === 'touchai-set-scroll-progress';

const isScrollDrivenResetType = (messageType: string) =>
    messageType.endsWith('-start') || messageType === 'touchai-reset-demo';

const clearScrollDrivenState = (host: TouchAiHost) => {
    host.classList.remove('is-scroll-driven');
    delete host.dataset.touchaiScrollDriven;
};

const queuePendingMessage = (host: TouchAiHost, data: unknown, messageType: string) => {
    const pendingMessages = host.__touchaiPendingMessages ?? [];

    if (messageType) {
        const existingIndex = pendingMessages.findIndex(
            (pendingMessage) => getMessageType(pendingMessage) === messageType
        );
        if (existingIndex >= 0) {
            pendingMessages[existingIndex] = data;
        } else {
            pendingMessages.push(data);
        }
    } else {
        pendingMessages.push(data);
    }

    if (pendingMessages.length > 12) {
        pendingMessages.splice(0, pendingMessages.length - 12);
    }

    host.__touchaiPendingMessages = pendingMessages;
};

const flushPendingMessages = (host: TouchAiHost) => {
    const pendingMessages = host.__touchaiPendingMessages;
    if (!host.__touchaiMessageHandlers?.size || !pendingMessages?.length) return;

    host.__touchaiPendingMessages = [];
    pendingMessages.forEach((message) => {
        dispatchMessage(host, message);
    });
    delete host.__touchaiPendingMessages;
};

const dispatchMessage = (host: TouchAiHost | null | undefined, data: unknown) => {
    if (!host) return false;

    const event = { data };
    const handlers = host.__touchaiMessageHandlers;
    const messageType = getMessageType(data);

    if (isScrollDrivenProgressType(messageType)) {
        const progress = getMessageProgress(data);
        if (Number.isFinite(progress) && (progress <= 0.0005 || progress >= 0.9995)) {
            clearScrollDrivenState(host);
        } else {
            host.classList.add('is-scroll-driven');
            host.dataset.touchaiScrollDriven = 'true';
        }
    } else if (isScrollDrivenResetType(messageType)) {
        clearScrollDrivenState(host);
    }

    host.dataset.touchaiMessageHandlerCount = String(handlers?.size ?? 0);
    host.dataset.touchaiMessageDispatchCount = String(
        (Number(host.dataset.touchaiMessageDispatchCount || '0') || 0) + 1
    );
    if (!handlers?.size) {
        queuePendingMessage(host, data, messageType);
    } else {
        handlers.forEach((handler) => handler(event));
    }
    host.dataset.touchaiLastMessage = messageType || 'unknown';

    return true;
};

const updateResolvedSources = (host: TouchAiHost, baseUrl: string) => {
    host.querySelectorAll<HTMLElement>('[src]').forEach((node) => {
        const value = node.getAttribute('src');
        if (!value) return;
        node.setAttribute('src', resolveUrl(value, baseUrl));
    });
};

const runInlineScript = (host: TouchAiHost, code: string) => {
    const messageHandlers = host.__touchaiMessageHandlers!;
    const windowHandlers = host.__touchaiWindowHandlers!;

    const localDocument = {
        body: host,
        documentElement: host,
        head: document.head,
        querySelector: host.querySelector.bind(host),
        querySelectorAll: host.querySelectorAll.bind(host),
        getElementById: (id: string) => host.querySelector(`#${CSS.escape(id)}`),
        createElement: document.createElement.bind(document),
        createElementNS: document.createElementNS.bind(document),
        createTextNode: document.createTextNode.bind(document),
        createDocumentFragment: document.createDocumentFragment.bind(document),
        createTreeWalker: document.createTreeWalker.bind(document),
        addEventListener: (
            type: string,
            handler: EventListenerOrEventListenerObject,
            options?: boolean | AddEventListenerOptions
        ) => {
            if (type === 'DOMContentLoaded') {
                window.setTimeout(() => {
                    if (typeof handler === 'function') {
                        handler(new Event('DOMContentLoaded'));
                    } else {
                        handler.handleEvent(new Event('DOMContentLoaded'));
                    }
                }, 0);
                return;
            }
            document.addEventListener(type, handler, options);
        },
        removeEventListener: document.removeEventListener.bind(document),
    };

    const localWindow = new Proxy(window, {
        get(target, prop) {
            if (prop === 'document') return localDocument;
            if (prop === 'self') return localWindow;
            if (prop === 'top') return window;
            if (prop === 'parent') {
                return {
                    postMessage(data: unknown) {
                        window.dispatchEvent(new MessageEvent('message', { data }));
                    },
                };
            }
            if (prop === 'addEventListener') {
                return (
                    type: string,
                    handler: EventListenerOrEventListenerObject,
                    options?: boolean | AddEventListenerOptions
                ) => {
                    if (type === 'message') {
                        const wrappedMessageHandler: TouchAiMessageHandler = (event) => {
                            host.dataset.touchaiLastReceivedMessage =
                                getMessageType(event?.data) || 'unknown';
                            host.dataset.touchaiMessageReceiveCount = String(
                                (Number(host.dataset.touchaiMessageReceiveCount || '0') || 0) + 1
                            );
                            if (typeof handler === 'function') {
                                handler.call(localWindow, event as unknown as Event);
                            } else {
                                handler.handleEvent(event as unknown as Event);
                            }
                        };
                        windowHandlers.set(
                            handler,
                            wrappedMessageHandler as unknown as EventListenerOrEventListenerObject
                        );
                        messageHandlers.add(wrappedMessageHandler);
                        host.dataset.touchaiMessageHandlerCount = String(messageHandlers.size);
                        return;
                    }
                    if (type === 'load') {
                        window.setTimeout(() => {
                            if (typeof handler === 'function') {
                                handler(new Event('load'));
                            } else {
                                handler.handleEvent(new Event('load'));
                            }
                        }, 0);
                        return;
                    }
                    const wrapped =
                        type === 'resize'
                            ? () => {
                                  if (typeof handler === 'function') {
                                      handler.call(localWindow, new Event('resize'));
                                  } else {
                                      handler.handleEvent(new Event('resize'));
                                  }
                              }
                            : handler;
                    windowHandlers.set(handler, wrapped);
                    window.addEventListener(type, wrapped, options);
                };
            }
            if (prop === 'removeEventListener') {
                return (
                    type: string,
                    handler: EventListenerOrEventListenerObject,
                    options?: boolean | EventListenerOptions
                ) => {
                    if (type === 'message') {
                        const wrappedMessageHandler = windowHandlers.get(handler);
                        if (wrappedMessageHandler) {
                            messageHandlers.delete(
                                wrappedMessageHandler as unknown as TouchAiMessageHandler
                            );
                            windowHandlers.delete(handler);
                        }
                        return;
                    }
                    const wrapped = windowHandlers.get(handler) ?? handler;
                    windowHandlers.delete(handler);
                    window.removeEventListener(type, wrapped, options);
                };
            }
            if (prop === 'innerWidth') return host.clientWidth || target.innerWidth;
            if (prop === 'innerHeight') return host.clientHeight || target.innerHeight;
            const value = Reflect.get(target, prop);
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });

    const ScopedResizeObserver = function (callback: ResizeObserverCallback) {
        const observer = new ResizeObserver(callback);
        host.__touchaiResizeObservers?.push(observer);
        return observer;
    } as unknown as typeof ResizeObserver;

    ScopedResizeObserver.prototype = ResizeObserver.prototype;

    const runner = new Function(
        'document',
        'window',
        'NodeFilter',
        'Element',
        'ResizeObserver',
        'navigator',
        'MutationObserver',
        'requestAnimationFrame',
        'cancelAnimationFrame',
        code
    );

    runner(
        localDocument,
        localWindow,
        NodeFilter,
        Element,
        ScopedResizeObserver,
        navigator,
        MutationObserver,
        window.requestAnimationFrame.bind(window),
        window.cancelAnimationFrame.bind(window)
    );
};

const applyDocument = async (
    host: TouchAiHost,
    styleNode: HTMLStyleElement | null,
    doc: Document,
    componentUrl: URL,
    loadVersion: number
) => {
    if (loadVersion !== host.__touchaiLoadVersion) return;
    host.dataset.touchaiStatus = 'applying';
    host.dataset.touchaiLoadVersion = String(loadVersion);

    host.__touchaiResizeObservers?.forEach((observer) => {
        observer.disconnect();
    });
    host.__touchaiResizeObservers = [];

    host.__touchaiWindowHandlers?.forEach((wrapped) => {
        window.removeEventListener('resize', wrapped);
    });
    host.__touchaiWindowHandlers?.clear();
    host.__touchaiMessageHandlers?.clear();

    const bodyClassName = doc.body.className || '';
    host.className = host.dataset.baseClass || '';
    clearScrollDrivenState(host);
    if (bodyClassName) {
        host.classList.add(...bodyClassName.split(/\s+/).filter(Boolean));
    }

    const scopedCss = [...doc.querySelectorAll('style')]
        .map((style) => style.textContent || '')
        .join('\n');

    if (styleNode) {
        styleNode.textContent = scopeCss(
            `${scopedCss}\n${hostCssFor(host.dataset.demoId || '')}`,
            `touchai-component-demo[data-demo-id="${host.dataset.demoId || ''}"]`
        );
    }

    doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]').forEach((link) => {
        const href = link.getAttribute('href');
        if (!href) return;
        const resolvedHref = resolveSafeExternalUrl(href, componentUrl.href);
        if (!resolvedHref) {
            host.dataset.touchaiSkippedStyle = href;
            return;
        }
        loadExternalStyle(resolvedHref);
    });

    const bodyContent = doc.body.cloneNode(true) as HTMLElement;
    sanitizeClonedBody(bodyContent);
    bodyContent.querySelectorAll('script').forEach((script) => script.remove());
    host.replaceChildren(...Array.from(bodyContent.childNodes));
    updateResolvedSources(host, componentUrl.href);

    for (const script of [...doc.querySelectorAll('script')]) {
        if (loadVersion !== host.__touchaiLoadVersion) return;
        const srcAttr = script.getAttribute('src');
        if (srcAttr) {
            const resolvedSrc = resolveSafeExternalUrl(srcAttr, componentUrl.href);
            if (!resolvedSrc) {
                host.dataset.touchaiSkippedScript = srcAttr;
                continue;
            }
            host.dataset.touchaiLastScript = resolvedSrc;
            await loadExternalScript(resolvedSrc);
            continue;
        }
        host.dataset.touchaiLastScript = 'inline';
        runInlineScript(host, script.textContent || '');
    }

    if (loadVersion !== host.__touchaiLoadVersion) return;

    host.dataset.touchaiStatus = 'loaded';
    flushPendingMessages(host);
    host.dispatchEvent(new Event('load'));
    host.dispatchEvent(new CustomEvent('touchai-component-loaded'));
};

const mount = (id: string): TouchAiHost | null => {
    const host = document.querySelector<TouchAiHost>(
        `touchai-component-demo[data-demo-id="${id}"]`
    );
    const styleNode = document.querySelector<HTMLStyleElement>(`style[data-demo-style="${id}"]`);
    if (!host || host.__touchaiMounted) return host;

    host.__touchaiMounted = true;
    host.dataset.touchaiMounted = 'true';
    host.__touchaiReady = false;
    host.dataset.touchaiReady = 'false';
    host.__touchaiLoadVersion = 0;
    host.__touchaiController = null;
    host.__touchaiMessageHandlers = new Set();
    host.__touchaiWindowHandlers = new Map();
    host.__touchaiPendingMessages = [];
    host.dataset.touchaiMessageHandlerCount = '0';
    host.__touchaiResizeObservers = [];
    host.dataset.touchaiMessageDispatchCount = '0';
    host.dataset.touchaiMessageReceiveCount = '0';
    host.dataset.demoId = id;
    host.dataset.touchaiStatus = 'mount-created';

    const load = async () => {
        const src = host.dataset.src;
        if (!src) return;

        const loadVersion = (host.__touchaiLoadVersion || 0) + 1;
        host.__touchaiLoadVersion = loadVersion;
        const componentUrl = new URL(src, window.location.href);
        const controller = new AbortController();
        host.__touchaiController?.abort();
        host.__touchaiController = controller;
        host.dataset.touchaiStatus = 'fetching';
        host.dataset.touchaiLoadVersion = String(loadVersion);

        try {
            const response = await fetch(componentUrl.pathname + componentUrl.search, {
                cache: 'no-store',
                signal: controller.signal,
            });
            host.dataset.touchaiStatus = `fetched-${response.status}`;
            if (!response.ok) {
                throw new Error(`Failed to fetch component: ${response.status}`);
            }
            const html = await response.text();
            const doc = parseHtml(html);
            await applyDocument(host, styleNode, doc, componentUrl, loadVersion);
            host.__touchaiReady = true;
            host.dataset.touchaiReady = 'true';
            host.dataset.touchaiStatus = 'ready';
            delete host.dataset.touchaiError;
        } catch (error) {
            if ((error as Error)?.name === 'AbortError') return;
            host.__touchaiReady = false;
            host.dataset.touchaiReady = 'false';
            host.dataset.touchaiStatus = 'error';
            host.dataset.touchaiError = error instanceof Error ? error.message : String(error);
            console.error('TouchAI component mount failed:', error);
        } finally {
            if (host.__touchaiController === controller) {
                host.__touchaiController = null;
            }
        }
    };

    host.postMessage = (data: unknown) => {
        dispatchMessage(host, data);
    };

    host.reload = async () => {
        host.__touchaiReady = false;
        await load();
    };

    if (host.dataset.loading !== 'lazy') {
        void load();
    }

    return host;
};

const mountAll = () => {
    document
        .querySelectorAll<TouchAiHost>('touchai-component-demo[data-demo-id]')
        .forEach((host) => {
            const id = host.dataset.demoId;
            if (!id) return;
            mount(id);
        });
};

const send = (target: string | TouchAiHost | null | undefined, data: unknown) => {
    if (!target) return false;

    const host =
        typeof target === 'string'
            ? mount(target)
            : target.dataset.demoId
              ? (mount(target.dataset.demoId) ?? target)
              : target;

    return dispatchMessage(host, data);
};

export const ensureTouchaiLightDemoRuntime = (): TouchAiRuntime => {
    document.body.dataset.touchaiRuntimeFactory = 'starting';
    if (window.__touchaiLightDemoRuntime) {
        document.body.dataset.touchaiRuntimeFactory = 'reused';
        return window.__touchaiLightDemoRuntime;
    }

    window.__touchaiLightDemoRuntime = {
        mount,
        mountAll,
        send,
    };
    document.body.dataset.touchaiRuntimeFactory = 'created';

    return window.__touchaiLightDemoRuntime;
};
