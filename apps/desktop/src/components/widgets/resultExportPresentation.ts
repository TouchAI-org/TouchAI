// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { ResultExportPresentation } from '@/app/api/agent/resultExport';

import { createShowWidgetBaseStyles } from './runtime';
import { SHOW_WIDGET_THEME_FALLBACKS } from './runtimeConstants';

export function createResultExportPresentation(): ResultExportPresentation {
    const computed = getComputedStyle(document.documentElement);
    const theme = Object.fromEntries(
        Object.keys(SHOW_WIDGET_THEME_FALLBACKS).map((name) => [
            name,
            computed.getPropertyValue(name).trim() ||
                SHOW_WIDGET_THEME_FALLBACKS[name as keyof typeof SHOW_WIDGET_THEME_FALLBACKS],
        ])
    );

    return {
        theme,
        themeFallbacks: SHOW_WIDGET_THEME_FALLBACKS,
        baseStyles: createShowWidgetBaseStyles('[data-result-widget]'),
    };
}
