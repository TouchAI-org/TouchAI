import { describe, expect, it } from 'vitest';

import {
    REDACTED_SECRET_LIKE_CONTENT,
    containsSecretLikeContent,
    redactAllStringValues,
    redactSecretLikeContent,
    redactSecretLikeStringValues,
} from '@/utils/secretLikeContent';

describe('secretLikeContent', () => {
    it('detects common secret-like substrings', () => {
        expect(containsSecretLikeContent('OPENAI_API_KEY=sk-test-secret-value')).toBe(true);
        expect(containsSecretLikeContent('ghp_1234567890abcdefghijklmnopqrstuvwxyzAB')).toBe(
            true
        );
        expect(containsSecretLikeContent('Durable desktop workflow note')).toBe(false);
    });

    it('redacts secret-like substrings from plain text', () => {
        const redacted = redactSecretLikeContent(
            'Remember OPENAI_API_KEY=sk-test-secret-value for clipboard workflows.'
        );

        expect(redacted).toContain(REDACTED_SECRET_LIKE_CONTENT);
        expect(redacted).not.toContain('sk-test-secret-value');
    });

    it('redacts only secret-bearing string values deeply', () => {
        const redacted = redactSecretLikeStringValues({
            title: 'Desktop workflow',
            nested: {
                token: 'ghp_1234567890abcdefghijklmnopqrstuvwxyzAB',
                note: 'Clipboard continuity',
            },
            keywords: ['memory', 'OPENAI_API_KEY=sk-test-secret-value'],
        });

        expect(redacted).toEqual({
            title: 'Desktop workflow',
            nested: {
                token: REDACTED_SECRET_LIKE_CONTENT,
                note: 'Clipboard continuity',
            },
            keywords: ['memory', REDACTED_SECRET_LIKE_CONTENT],
        });
    });

    it('redacts every string value when asked to fully scrub nested data', () => {
        const redacted = redactAllStringValues({
            title: 'Desktop workflow',
            nested: {
                note: 'Clipboard continuity',
            },
            keywords: ['memory'],
        });

        expect(redacted).toEqual({
            title: REDACTED_SECRET_LIKE_CONTENT,
            nested: {
                note: REDACTED_SECRET_LIKE_CONTENT,
            },
            keywords: [REDACTED_SECRET_LIKE_CONTENT],
        });
    });
});
