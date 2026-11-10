import { describe, expect, it } from 'vitest';

import { createWidgetRenderer } from '@/services/BuiltInToolService/tools/widgetTool/showWidget/runtime';

describe('given generated widgets and local skill access share a conversation window', () => {
    it('user skill access stays outside the generated widget execution realm', () => {
        const host = document.createElement('div');
        document.body.append(host);
        const renderer = createWidgetRenderer(host);
        renderer.render({
            widgetId: 'isolation',
            title: 'Widget',
            description: '',
            phase: 'ready',
            html: '<p>Widget</p><script>window.__probe = window.__TAURI_INTERNALS__</script>',
        });
        const frame = host.querySelector('iframe');
        expect(frame).not.toBeNull();
        expect(frame?.getAttribute('sandbox')).toBe('allow-scripts');
        expect(host.querySelector('script')).toBeNull();
        renderer.destroy();
        host.remove();
    });
});
