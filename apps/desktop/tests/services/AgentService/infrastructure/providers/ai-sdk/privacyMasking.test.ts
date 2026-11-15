import { describe, expect, it } from 'vitest';

import { PrivacyMaskingSession } from '@/services/AgentService/infrastructure/providers/ai-sdk/privacyMasking';

describe('given a private value was found before a provider request', () => {
    it('user has the same value replaced by different sources then its actual per-rule counts are retained independently', () => {
        const session = new PrivacyMaskingSession();
        const original = 'ada@example.test';
        const placeholder = '{{EMAIL_0123456789abcdef}}';
        session.maskText(original, [
            { start: 0, end: original.length, kind: 'email', placeholder, rule: { id: 'email' } },
        ]);
        session.maskText(original, [
            {
                start: 0,
                end: original.length,
                kind: 'email',
                placeholder,
                rule: { id: 'localModel', modelId: 'astrlink-guard-int8' },
            },
        ]);
        session.maskText(original, [
            { start: 0, end: original.length, kind: 'email', placeholder, rule: { id: 'email' } },
        ]);
        const details = session.protectionDetails();
        expect(details.values).toHaveLength(1);
        expect(details.values[0]?.count).toBe(3);
        expect(details.values[0]?.matches).toEqual([
            { id: 'email', count: 2 },
            { id: 'localModel', modelId: 'astrlink-guard-int8', count: 1 },
        ]);
        details.values[0]!.matches![0]!.count = 99;
        expect(session.protectionDetails().values[0]?.matches?.[0]?.count).toBe(2);
        expect(session.restoreText(placeholder)).toBe(original);
    });

    it('user opens a recent record then sees only accepted replacements and the actual masked text', () => {
        const session = new PrivacyMaskingSession();
        const text = 'Ada ada@example.test';
        const masked = session.maskText(text, [
            {
                start: 0,
                end: 3,
                kind: 'private_person',
                placeholder: '{{PERSON_0123456789abcdef}}',
            },
            {
                start: 4,
                end: text.length,
                kind: 'email',
                placeholder: '{{EMAIL_0123456789abcdef}}',
            },
            { start: 4, end: 7, kind: 'secret', placeholder: '{{SECRET_0123456789abcdef}}' },
            { start: -1, end: 2, kind: 'secret', placeholder: '{{INVALID_0123456789abcdef}}' },
        ]);
        expect(session.protectionDetails()).toEqual({
            values: [
                {
                    kind: 'privatePerson',
                    original: 'Ada',
                    placeholder: '{{PERSON_0123456789abcdef}}',
                    count: 1,
                },
                {
                    kind: 'email',
                    original: 'ada@example.test',
                    placeholder: '{{EMAIL_0123456789abcdef}}',
                    count: 1,
                },
            ],
            texts: [masked],
            truncated: false,
        });
        expect(session.restoreText(masked)).toBe(text);
        expect(JSON.stringify(session.protectionSummary())).not.toContain('Ada');
    });

    it('user masks the same value in several places then sees one replacement with its total count and independent detail snapshots', () => {
        const session = new PrivacyMaskingSession();
        const original = 'ada@example.test';
        const placeholder = '{{EMAIL_0123456789abcdef}}';
        const text = `${original} and ${original}`;
        session.maskText(text, [
            { start: 0, end: original.length, kind: 'email', placeholder },
            { start: original.length + 5, end: text.length, kind: 'email', placeholder },
        ]);
        session.maskText(`To: ${original}`, [
            { start: 4, end: 4 + original.length, kind: 'email', placeholder },
        ]);
        const details = session.protectionDetails();
        expect(details.values).toEqual([{ kind: 'email', original, placeholder, count: 3 }]);
        expect(details.texts).toEqual([`${placeholder} and ${placeholder}`, `To: ${placeholder}`]);
        details.values[0]!.original = 'changed';
        details.values[0]!.count = 99;
        details.texts.length = 0;
        expect(session.protectionDetails().values[0]).toEqual({
            kind: 'email',
            original,
            placeholder,
            count: 3,
        });
        expect(session.protectionDetails().texts).toHaveLength(2);
    });

    it('user protects a large request then sees bounded details without losing masking or restoration', () => {
        const session = new PrivacyMaskingSession();
        const values = Array.from(
            { length: 240 },
            (_, index) => `private-${index}-${'名'.repeat(100)}`
        );
        const text = values.join('\n');
        let start = 0;
        const spans = values.map((value, index) => {
            const span = {
                start,
                end: start + value.length,
                kind: 'term',
                placeholder: `{{TERM_${index.toString(16).padStart(16, '0')}}}`,
            };
            start += value.length + 1;
            return span;
        });
        const masked = session.maskText(text, spans);
        const details = session.protectionDetails();
        const bytes =
            new TextEncoder().encode(details.texts.join('')).length +
            details.values.reduce(
                (sum, value) =>
                    sum + new TextEncoder().encode(value.original + value.placeholder).length,
                0
            );
        expect(details.values.length).toBeLessThanOrEqual(200);
        expect(details.texts.length).toBeLessThanOrEqual(20);
        expect(bytes).toBeLessThanOrEqual(64 * 1024);
        expect(details.truncated).toBe(true);
        expect(session.protectionSummary().maskedCount).toBe(240);
        expect(session.restoreText(masked)).toBe(text);
        expect(masked).not.toContain('private-');
    });

    it('user protects more distinct values than the detail limit then all values stay masked while only two hundred appear in details', () => {
        const session = new PrivacyMaskingSession();
        const values = Array.from({ length: 220 }, (_, index) => `value${index}`);
        const text = values.join(' ');
        let start = 0;
        const spans = values.map((value, index) => {
            const span = {
                start,
                end: start + value.length,
                kind: 'term',
                placeholder: `{{TERM_${index.toString(16).padStart(16, '0')}}}`,
            };
            start += value.length + 1;
            return span;
        });
        const masked = session.maskText(text, spans);
        expect(session.protectionDetails().values).toHaveLength(200);
        expect(session.protectionDetails().truncated).toBe(true);
        expect(session.protectionSummary().maskedCount).toBe(220);
        expect(session.restoreText(masked)).toBe(text);
    });

    it('user protects many text parts then previews stay bounded and the same value is still counted everywhere', () => {
        const session = new PrivacyMaskingSession();
        for (let index = 0; index < 22; index += 1) {
            const text = `${index}: Ada`;
            session.maskText(text, [
                {
                    start: text.indexOf('Ada'),
                    end: text.length,
                    kind: 'private_person',
                    placeholder: '{{PERSON_0123456789abcdef}}',
                },
            ]);
        }
        const details = session.protectionDetails();
        expect(details.texts).toHaveLength(20);
        expect(details.values[0]?.count).toBe(22);
        expect(details.truncated).toBe(true);
    });

    it('user protects an oversized value then it is omitted only from details while the original can still be restored locally', () => {
        const session = new PrivacyMaskingSession();
        const text = '名'.repeat(40_000);
        const masked = session.maskText(text, [
            { start: 0, end: text.length, kind: 'term', placeholder: '{{TERM_0123456789abcdef}}' },
        ]);
        expect(session.protectionDetails().values).toEqual([]);
        expect(session.protectionDetails().truncated).toBe(true);
        expect(session.restoreText(masked)).toBe(text);
    });

    it('user sees only accepted masking counts in protection records and no original text or placeholders', () => {
        const session = new PrivacyMaskingSession();
        session.maskText('Ada ada@example.test', [
            { start: 0, end: 3, kind: 'private_person', placeholder: '{{PERSON_test}}' },
            { start: 4, end: 20, kind: 'email', placeholder: '{{EMAIL_test}}' },
            { start: 4, end: 7, kind: 'secret', placeholder: '{{SECRET_test}}' },
            { start: -1, end: 2, kind: 'secret', placeholder: '{{INVALID_test}}' },
        ]);
        const summary = session.protectionSummary();
        expect(summary).toEqual({
            maskedCount: 2,
            categories: [
                { kind: 'privatePerson', count: 1 },
                { kind: 'email', count: 1 },
            ],
        });
        expect(JSON.stringify(summary)).not.toContain('Ada');
        expect(JSON.stringify(summary)).not.toContain('@');
        expect(JSON.stringify(summary)).not.toContain('{{');
        summary.categories[0]!.count = 99;
        expect(session.protectionSummary().maskedCount).toBe(2);
        expect(session.protectionSummary().categories[0]!.count).toBe(1);
    });

    it('user sees the original value restored in the answer when a masked placeholder returns', () => {
        const session = new PrivacyMaskingSession();
        const text = 'Contact Ada at ada@example.test';
        const valueStart = text.indexOf('ada@example.test');
        const placeholder = '{{PRIVATE_EMAIL_0123456789ab}}';

        expect(
            session.maskText(text, [
                {
                    start: valueStart,
                    end: valueStart + 'ada@example.test'.length,
                    kind: 'private_email',
                    placeholder,
                },
            ])
        ).toBe(`Contact Ada at ${placeholder}`);
        expect(session.restoreText(`I will contact ${placeholder}.`)).toBe(
            'I will contact ada@example.test.'
        );
    });

    it('user sees the full original value when a placeholder is split across response chunks', () => {
        const session = new PrivacyMaskingSession();
        const text = 'Alice';
        const placeholder = '{{PRIVATE_PERSON_abcdef012345}}';

        session.maskText(text, [
            { start: 0, end: text.length, kind: 'private_person', placeholder },
        ]);

        const visible = [
            session.pushText(`Hello ${placeholder.slice(0, 12)}`),
            session.pushText(placeholder.slice(12)),
            session.flushText(),
        ].join('');

        expect(visible).toBe('Hello Alice');
        expect(visible).not.toContain(placeholder);
    });

    it('user gives a tool its original argument when the provider returns a placeholder', () => {
        const session = new PrivacyMaskingSession();
        const text = 'ada@example.test';
        const placeholder = '{{PRIVATE_EMAIL_9876543210ab}}';

        session.maskText(text, [
            { start: 0, end: text.length, kind: 'private_email', placeholder },
        ]);

        expect(session.restoreToolArguments(`{"recipient":"${placeholder}"}`)).toBe(
            `{"recipient":"${text}"}`
        );
    });
});
