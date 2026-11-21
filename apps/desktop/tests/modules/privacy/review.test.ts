import { webcrypto } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPrivacyReview, hashPrivacyText } from '@/modules/privacy';
import type { PrivacyReviewAnnotation } from '@/modules/privacy/public';
const review = createPrivacyReview();
const {
    clearPrivacyReview,
    privacyReviewGeneration,
    publishPrivacyReview,
    selectPrivacyAnnotations,
} = review;

function entry(
    messageId: number,
    hash: string,
    original = 'ada@example.test'
): PrivacyReviewAnnotation {
    return {
        messageId,
        textHash: hash,
        start: 0,
        end: original.length,
        original,
        placeholder: `{{EMAIL_${String(messageId).padStart(16, '0')}}}`,
        kind: 'email',
        rule: { id: 'email' },
    };
}

beforeEach(() => {
    vi.stubGlobal('crypto', webcrypto);
    clearPrivacyReview();
});
afterEach(() => vi.unstubAllGlobals());

describe('given a user reviews an actually masked message', () => {
    it('user sees annotations only for the exact message and text version that was scanned', async () => {
        const text = 'ada@example.test';
        const hash = await hashPrivacyText(text);
        publishPrivacyReview([entry(41, hash)]);
        expect(selectPrivacyAnnotations(41, text, hash)).toHaveLength(1);
        expect(selectPrivacyAnnotations(42, text, hash)).toEqual([]);
        expect(
            selectPrivacyAnnotations(
                41,
                `Changed: ${text}`,
                await hashPrivacyText(`Changed: ${text}`)
            )
        ).toEqual([]);
    });

    it('user revisits an invalid or mismatched span then it does not claim protection', async () => {
        const text = 'ada@example.test';
        const hash = await hashPrivacyText(text);
        publishPrivacyReview([
            { ...entry(1, hash), start: -1 },
            { ...entry(2, hash), original: 'other@example.test' },
        ]);
        expect(selectPrivacyAnnotations(1, text, hash)).toEqual([]);
        expect(selectPrivacyAnnotations(2, text, hash)).toEqual([]);
    });

    it('user exceeds two hundred recent replacements then only the newest bounded mappings remain', async () => {
        const text = 'ada@example.test';
        const hash = await hashPrivacyText(text);
        publishPrivacyReview(Array.from({ length: 220 }, (_, i) => entry(i + 1, hash)));
        expect(review.getReviewSnapshot().annotations).toHaveLength(200);
        expect(selectPrivacyAnnotations(1, text, hash)).toEqual([]);
        expect(selectPrivacyAnnotations(220, text, hash)).toHaveLength(1);
    });

    it('user has very long private values then the review stays within its byte budget', async () => {
        const original = '私'.repeat(10000);
        const hash = await hashPrivacyText(original);
        publishPrivacyReview(Array.from({ length: 8 }, (_, i) => entry(i + 1, hash, original)));
        expect(
            new TextEncoder().encode(JSON.stringify(review.getReviewSnapshot().annotations)).length
        ).toBeLessThanOrEqual(64 * 1024);
    });

    it('user clears recent review then no original mappings remain available', async () => {
        const text = 'ada@example.test';
        const hash = await hashPrivacyText(text);
        publishPrivacyReview([entry(1, hash)]);
        clearPrivacyReview();
        expect(review.getReviewSnapshot().annotations).toEqual([]);
        expect(selectPrivacyAnnotations(1, text, hash)).toEqual([]);
    });

    it('user clears review while a request is pending then its late response cannot reintroduce cleared annotations', async () => {
        const text = 'ada@example.test';
        const hash = await hashPrivacyText(text);
        const oldGeneration = privacyReviewGeneration();
        clearPrivacyReview();
        publishPrivacyReview([entry(1, hash)], oldGeneration);
        expect(review.getReviewSnapshot().annotations).toEqual([]);
    });

    it('user changes the caller metadata after capture then retained provenance does not change', async () => {
        const text = 'Project Nightfall';
        const hash = await hashPrivacyText(text);
        const value = {
            ...entry(1, hash, text),
            kind: 'custom' as const,
            rule: { id: 'customWord' as const, value: text },
        };
        publishPrivacyReview([value]);
        value.rule.value = 'Changed';
        expect(selectPrivacyAnnotations(1, text, hash)[0]?.rule).toEqual({
            id: 'customWord',
            value: text,
        });
    });
});
