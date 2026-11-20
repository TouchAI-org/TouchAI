export const SHOW_WIDGET_TOOL_NAME = 'builtin__show_widget';
export const SHOW_WIDGET_ALLOWED_RESOURCE_HOSTS = Object.freeze([
    'cdnjs.cloudflare.com',
    'cdn.jsdelivr.net',
    'unpkg.com',
    'esm.sh',
] as const);
export const SHOW_WIDGET_DRAFT_MIN_INTERVAL_MS = 150;
export const SHOW_WIDGET_DRAFT_THROTTLE_MIN_CHARS = 2000;

export interface WidgetMarkupInspector {
    inspect(html: string): {
        firstElementTag: string | null;
        resourceUrls: readonly string[];
        baseUrl: string;
    };
}

export function isShowWidgetResourceUrlAllowed(resourceUrl: string, baseUrl: string): boolean {
    if (!resourceUrl.trim()) return true;
    try {
        const url = new URL(resourceUrl, baseUrl);
        return (
            !['http:', 'https:'].includes(url.protocol) ||
            SHOW_WIDGET_ALLOWED_RESOURCE_HOSTS.some((host) => host === url.hostname)
        );
    } catch {
        return false;
    }
}
