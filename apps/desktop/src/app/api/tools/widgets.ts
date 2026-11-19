import { isShowWidgetResourceUrlAllowed as isAllowed } from '@/modules/tools/public';

export {
    SHOW_WIDGET_ALLOWED_RESOURCE_HOSTS,
    SHOW_WIDGET_DRAFT_MIN_INTERVAL_MS,
    SHOW_WIDGET_DRAFT_THROTTLE_MIN_CHARS,
    SHOW_WIDGET_TOOL_NAME,
} from '@/modules/tools/public';

export interface ShowWidgetPayload {
    callId: string;
    widgetId: string;
    title: string;
    description: string;
    html: string;
    mode: 'render' | 'remove';
    phase: 'draft' | 'ready';
}

export function isShowWidgetResourceUrlAllowed(url: string): boolean {
    return isAllowed(
        url,
        typeof window === 'undefined' ? 'https://claude.ai/' : window.location.href
    );
}
