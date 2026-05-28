import { afterEach, describe, expect, it } from 'vitest';

import { createWidgetRenderer } from '@/services/BuiltInToolService/tools/widgetTool/showWidget/runtime';

describe('show widget renderer i18n opt-out', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('marks the renderer host and root as not eligible for global DOM localization', () => {
        const host = document.createElement('div');
        document.body.appendChild(host);

        const renderer = createWidgetRenderer(host);
        const root = host.querySelector('[data-touchai-widget-root="true"]');

        expect(host.getAttribute('data-no-i18n')).toBe('true');
        expect(host.getAttribute('translate')).toBe('no');
        expect(root?.getAttribute('data-no-i18n')).toBe('true');
        expect(root?.getAttribute('translate')).toBe('no');

        renderer.destroy();
    });
});
