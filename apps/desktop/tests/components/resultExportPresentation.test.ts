import { afterEach, describe, expect, it, vi } from 'vitest';

import { createResultExportPresentation } from '@/components/widgets/resultExportPresentation';
import { SHOW_WIDGET_THEME_FALLBACKS } from '@/components/widgets/runtimeConstants';

afterEach(() => {
    vi.restoreAllMocks();
});

describe('user saves a widget result', () => {
    it('user gets the current theme value when available and the fallback when it is not', () => {
        const getPropertyValue = vi.fn((name: string) =>
            name === '--color-text-primary' ? '  #123456  ' : ''
        );
        vi.spyOn(window, 'getComputedStyle').mockReturnValue({
            getPropertyValue,
        } as unknown as CSSStyleDeclaration);

        const presentation = createResultExportPresentation();

        expect(presentation.theme['--color-text-primary']).toBe('#123456');
        expect(presentation.theme['--color-background-primary']).toBe(
            SHOW_WIDGET_THEME_FALLBACKS['--color-background-primary']
        );
        expect(Object.keys(presentation.theme)).toEqual(Object.keys(SHOW_WIDGET_THEME_FALLBACKS));
        expect(presentation.themeFallbacks).toBe(SHOW_WIDGET_THEME_FALLBACKS);
        expect(presentation.baseStyles).toContain('[data-result-widget]');
        expect(getPropertyValue).toHaveBeenCalled();
    });
});
