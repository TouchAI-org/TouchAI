import { describe, expect, it } from 'vitest';

import { containsLongCodeBlock } from '@/utils/markdownCodeBlock';

describe('containsLongCodeBlock', () => {
    it('detects a long fenced code block', () => {
        const markdown = ['intro', '```ts', 'x'.repeat(120), '```', 'outro'].join('\n');
        expect(containsLongCodeBlock(markdown, 100)).toBe(true);
    });

    it('ignores short code blocks', () => {
        const markdown = ['```ts', 'const value = 1;', '```', '```sh', 'echo hi', '```'].join('\n');
        expect(containsLongCodeBlock(markdown, 100)).toBe(false);
    });

    it('treats an unfinished streaming fence as its current body length', () => {
        const markdown = ['```ts', 'y'.repeat(150)].join('\n');
        expect(containsLongCodeBlock(markdown, 100)).toBe(true);
    });

    it('supports tilde fences', () => {
        const markdown = ['~~~js', 'z'.repeat(150), '~~~'].join('\n');
        expect(containsLongCodeBlock(markdown, 100)).toBe(true);
    });

    it('returns false when there is no fenced block', () => {
        expect(containsLongCodeBlock('plain text with `inline` code', 10)).toBe(false);
    });
});
