import type {
    ResultExportMessage,
    ResultExportTheme,
    ResultExportWidgetPresentation,
} from '@/modules/result-export/public';

export const RESULT_EXPORT_TEST_THEME: ResultExportTheme = {
    '--color-background-primary': 'rgba(251, 251, 246, 0.98)',
    '--color-background-secondary': 'rgba(246, 243, 238, 0.98)',
    '--color-background-tertiary': 'rgba(239, 235, 228, 0.96)',
    '--color-text-primary': '#4a4039',
    '--color-text-secondary': '#6b5f54',
    '--color-text-tertiary': '#968b7d',
    '--color-text-info': '#1e40af',
    '--color-border-primary': 'rgba(95, 94, 90, 0.4)',
    '--color-border-secondary': 'rgba(95, 94, 90, 0.3)',
    '--color-border-tertiary': 'rgba(95, 94, 90, 0.15)',
    '--color-scrollbar-thumb': 'rgba(156, 163, 175, 0.25)',
    '--font-sans': "'Segoe UI', sans-serif",
    '--font-serif': "'Source Han Serif SC', serif",
    '--font-mono': "'JetBrains Mono', monospace",
    '--border-radius-md': '10px',
    '--border-radius-lg': '12px',
};

export const RESULT_EXPORT_TEST_PRESENTATION: ResultExportWidgetPresentation = {
    theme: RESULT_EXPORT_TEST_THEME,
    themeFallbacks: RESULT_EXPORT_TEST_THEME,
    baseStyles: '[data-result-widget]{display:block;max-width:680px;margin:0 auto}',
    allowedResourceHosts: ['cdnjs.cloudflare.com', 'cdn.jsdelivr.net', 'unpkg.com', 'esm.sh'],
};

export function createResultExportMessage(
    overrides: Partial<ResultExportMessage> = {}
): ResultExportMessage {
    return {
        role: 'assistant',
        parts: [],
        widgets: [],
        ...overrides,
    };
}

export function createReadyResultWidget(html: string) {
    return {
        id: 'internal-widget-row-id',
        callId: 'internal-widget-call-id',
        widgetId: 'internal-widget-id',
        title: 'Quarterly revenue',
        description: 'Revenue by quarter',
        html,
        mode: 'render' as const,
        phase: 'ready' as const,
        updatedAt: 1,
    };
}
