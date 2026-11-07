import { describe, expect, it } from 'vitest';

import {
    buildReasoningPreview,
    REASONING_PREVIEW_MAX_CHARS,
} from '@/views/SearchView/components/ConversationPanel/components/reasoningPreview';

describe('buildReasoningPreview', () => {
    it('normalizes whitespace for short content without truncating', () => {
        expect(buildReasoningPreview('First thought\n\nMore detail')).toBe(
            'First thought More detail'
        );
        expect(buildReasoningPreview('   padded   ')).toBe('padded');
        expect(buildReasoningPreview('')).toBe('');
    });

    it('bounds the returned length for very long reasoning', () => {
        const preview = buildReasoningPreview('a'.repeat(100_000));

        expect(preview.length).toBeLessThanOrEqual(REASONING_PREVIEW_MAX_CHARS + 1);
        expect(preview.endsWith('…')).toBe(true);
    });

    it('bounds how much content is scanned when whitespace would collapse it', () => {
        // 大量空白会被归一化成很短的结果，不应为了预览扫描整段文本。
        const preview = buildReasoningPreview(`${'a'.repeat(50)}${' '.repeat(500_000)}`);

        expect(preview).toBe('a'.repeat(50));
    });
});
