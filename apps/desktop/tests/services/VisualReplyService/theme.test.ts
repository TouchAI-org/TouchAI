import { describe, expect, it } from 'vitest';

import {
    normalizeVisualReplyThemeSnapshot,
    serializeVisualReplyTheme,
} from '@/services/VisualReplyService/theme';

describe('when a visual reply receives a host theme snapshot', () => {
    it('user keeps only known safe CSS variables', () => {
        const snapshot = normalizeVisualReplyThemeSnapshot({
            '--touchai-color-text-primary': '#112233',
            '--unexpected': 'url(https://example.com/track)',
            '--touchai-font-sans': 'url(https://example.com/font)',
            '--touchai-radius-control': '8px; color:red',
            extra: 12,
        });

        expect(snapshot).toEqual({ '--touchai-color-text-primary': '#112233' });
        expect(serializeVisualReplyTheme(snapshot)).toBe('--touchai-color-text-primary:#112233');
    });
});
