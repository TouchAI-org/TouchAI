import { describe, expect, it } from 'vitest';

import { PrivacyMaskingSession, type PrivacyMaskingSpan } from '@/modules/privacy/masking';

describe('given a private value was found before a provider request', () => {
    it('user masks the same value from two sources then the active request restoration stays independent of the review callback', () => {
        const session = new PrivacyMaskingSession();
        const original = 'ada@example.test';
        const placeholder = '{{EMAIL_0123456789abcdef}}';
        const accepted: Array<{ span: PrivacyMaskingSpan; original: string }> = [];
        const remember = (span: PrivacyMaskingSpan, value: string) =>
            accepted.push({ span: { ...span }, original: value });
        session.maskText(
            original,
            [{ start: 0, end: original.length, kind: 'email', placeholder, rule: { id: 'email' } }],
            remember
        );
        session.maskText(
            original,
            [
                {
                    start: 0,
                    end: original.length,
                    kind: 'email',
                    placeholder,
                    rule: { id: 'localModel', modelId: 'astrlink-guard-int8' },
                },
            ],
            remember
        );
        session.maskText(
            original,
            [{ start: 0, end: original.length, kind: 'email', placeholder, rule: { id: 'email' } }],
            remember
        );
        expect(accepted.map(({ span }) => span.rule)).toEqual([
            { id: 'email' },
            { id: 'localModel', modelId: 'astrlink-guard-int8' },
            { id: 'email' },
        ]);
        expect(session.protectionSummary().maskedCount).toBe(3);
        expect(session.restoreText(placeholder)).toBe(original);
        expect(session.protectionDetails()).toEqual({
            values: [
                {
                    original,
                    placeholder,
                    kind: 'email',
                    count: 3,
                    matches: [
                        { id: 'email', count: 2 },
                        { id: 'localModel', modelId: 'astrlink-guard-int8', count: 1 },
                    ],
                },
            ],
            texts: [placeholder],
            truncated: false,
        });
        const snapshot = session.protectionDetails();
        snapshot.values[0]!.matches![0]!.count = 99;
        expect(session.protectionDetails().values[0]!.matches![0]!.count).toBe(2);
    });

    it('user rejects overlaps and invalid spans then only accepted substitutions are reported', () => {
        const session = new PrivacyMaskingSession();
        const text = 'Ada ada@example.test';
        const accepted: Array<{ span: PrivacyMaskingSpan; original: string }> = [];
        const masked = session.maskText(
            text,
            [
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
            ],
            (span, original) => accepted.push({ span, original })
        );
        expect(accepted.map(({ original }) => original)).toEqual(['Ada', 'ada@example.test']);
        expect(masked).toBe('{{PERSON_0123456789abcdef}} {{EMAIL_0123456789abcdef}}');
    });

    it('user masks one request with many values then every transient mapping still restores its own text', () => {
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
        const observed: string[] = [];
        const masked = session.maskText(text, spans, (_span, original) => observed.push(original));
        expect(observed).toHaveLength(240);
        expect(session.protectionSummary().maskedCount).toBe(240);
        expect(session.restoreText(masked)).toBe(text);
        expect(masked).not.toContain('private-');
        const details = session.protectionDetails();
        expect(details.truncated).toBe(true);
        expect(details.values.length).toBeGreaterThan(0);
        expect(details.values.length).toBeLessThanOrEqual(200);
        expect(new TextEncoder().encode(JSON.stringify(details)).length).toBeLessThan(64 * 1024);
    });

    it('user repeats a value then the accepted replacement mapping stays tied to the active request placeholder', () => {
        const session = new PrivacyMaskingSession();
        const original = 'ada@example.test';
        const placeholder = '{{EMAIL_0123456789abcdef}}';
        const text = `${original} and ${original}`;
        const accepted: string[] = [];
        const masked = session.maskText(
            text,
            [
                { start: 0, end: original.length, kind: 'email', placeholder },
                { start: original.length + 5, end: text.length, kind: 'email', placeholder },
            ],
            (_span, value) => accepted.push(value)
        );
        expect(accepted).toEqual([original, original]);
        expect(session.protectionSummary().maskedCount).toBe(2);
        expect(session.restoreText(masked)).toBe(text);
    });

    it('user sees only accepted masking counts in protection summaries and no original text or placeholders', () => {
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
