import morphdomSource from 'morphdom/dist/morphdom-umd.js?raw';

import { SHOW_WIDGET_ALLOWED_RESOURCE_HOSTS } from './runtimeConstants';

/** Runs in an opaque-origin frame. No application object is passed into this realm. */
export function createWidgetSandboxDocument(scopeId: string, styles: string): string {
    const hosts = SHOW_WIDGET_ALLOWED_RESOURCE_HOSTS.map((host) => `https://${host}`).join(' ');
    const bootstrap = `
(() => {
    const scopeId = ${JSON.stringify(scopeId)};
    const root = document.querySelector('[data-touchai-widget-root]');
    const post = (data) => parent.postMessage({ source: 'touchai-show-widget', scopeId, ...data }, '*');
    let version = 0;
    let lastExecuted = '';
    let measurePending = false;
    const measure = () => {
        if (measurePending) return;
        measurePending = true;
        requestAnimationFrame(() => {
            measurePending = false;
            post({ type: 'resize', height: Math.ceil(root.getBoundingClientRect().height) });
        });
    };
    window.sendPrompt = (text) => post({ type: 'sendPrompt', text: String(text || '') });
    window.openLink = (url) => post({ type: 'openLink', url: String(url || '') });
    document.addEventListener('click', event => {
        const element = event.target instanceof Element ? event.target : null;
        const prompt = element?.closest('[data-send-prompt]')?.getAttribute('data-send-prompt');
        if (prompt?.trim()) { event.preventDefault(); window.sendPrompt(prompt); return; }
        const url = element?.closest('[data-open-link]')?.getAttribute('data-open-link') || element?.closest('a[href]')?.getAttribute('href');
        if (url && !url.startsWith('#')) { event.preventDefault(); window.openLink(url); }
    }, true);
    window.addEventListener('message', async event => {
        const data = event.data;
        if (event.source !== parent || !data || data.scopeId !== scopeId || data.type !== 'render') return;
        if (data.phase === 'ready' && lastExecuted === data.signature) return;
        const current = ++version;
        const next = document.createElement('div');
        next.innerHTML = data.html;
        window.morphdom(root, next, {
            childrenOnly: true,
            getNodeKey: node => node.nodeType === 1 ? node.getAttribute('data-widget-key') || node.id : undefined,
            onBeforeElUpdated: (from, to) => !from.isEqualNode(to),
            onNodeAdded: node => {
                if (node.nodeType !== 1 || ['SCRIPT','STYLE','META','LINK'].includes(node.tagName)) return;
                node.setAttribute('data-touchai-widget-added', 'true');
                node.addEventListener('animationend', () => node.removeAttribute('data-touchai-widget-added'), { once: true });
            },
        });
        measure();
        if (data.phase !== 'ready') { lastExecuted = ''; return; }
        lastExecuted = data.signature;
        for (const source of data.scripts) {
            if (current !== version) break;
            const script = document.createElement('script');
            for (const attribute of source.attributes) {
                if (attribute.name !== 'src' && !attribute.name.startsWith('on')) script.setAttribute(attribute.name, attribute.value);
            }
            if (source.src) {
                script.src = source.src;
                script.async = false;
                await new Promise(resolve => {
                    const timeout = setTimeout(settle, 8000);
                    function settle() { clearTimeout(timeout); script.onload = script.onerror = null; script.remove(); resolve(); }
                    script.onload = script.onerror = settle;
                    document.head.append(script);
                });
            } else {
                script.textContent = '(() => {\\n' + source.source + '\\n})();';
                document.head.append(script);
                script.remove();
            }
        }
        measure();
    });
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(measure).observe(root);
    window.addEventListener('load', measure);
})();`;
    const safeScript = (value: string) => value.replace(/<\/script/gi, '<\\/script');
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' ${hosts}; style-src 'unsafe-inline'; img-src data: ${hosts}; font-src data: ${hosts}; media-src ${hosts}; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"><style data-touchai-widget-base-style>html,body{margin:0;padding:0;background:transparent;overflow-x:hidden}${styles.replace(/<\/style/gi, '')}</style></head><body><div data-touchai-widget-host="${scopeId}"><div data-touchai-widget-root="true" data-no-i18n="true" translate="no"></div></div><script>${safeScript(morphdomSource)}</script><script>${safeScript(bootstrap)}</script></body></html>`;
}
