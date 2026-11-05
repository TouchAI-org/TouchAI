import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { verifyFontBuffer } from '../../../.github/ui-preview/lib/font.mjs';

const expectedFor = (data) => ({
    size: data.length,
    sha256: createHash('sha256').update(data).digest('hex'),
});

describe('user reviews evidence rendered with the product font', () => {
    it('user gets a pass only when the bytes match the product size and hash', () => {
        const data = Buffer.from('source-han-serif');

        expect(verifyFontBuffer(data, expectedFor(data))).toEqual({ ok: true });
    });

    it('user sees a substituted file rejected even when its size matches', () => {
        const expected = Buffer.from('source-han-serif');
        const substituted = Buffer.from('not-the-product-font');

        expect(verifyFontBuffer(substituted, expectedFor(expected)).ok).toBe(false);
    });

    it('user sees a truncated download rejected', () => {
        const expected = Buffer.from('source-han-serif');
        const truncated = expected.subarray(0, 8);

        expect(verifyFontBuffer(truncated, expectedFor(expected)).ok).toBe(false);
    });
});
