// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { redactAttributes, redactText, redactUrl } from '@services/ObservabilityService/redact';
import { describe, expect, it } from 'vitest';

describe('user does not leak secrets into logs', () => {
    it('user gets secret attribute values replaced', () => {
        const redacted = redactAttributes({
            authorization: 'Bearer abcdefghijklmnop',
            'api.key': 'sk-live-secret',
            model: 'gpt-4.1',
            monkey: 'not-a-secret',
        });

        expect(redacted.authorization).toBe('[redacted]');
        expect(redacted['api.key']).toBe('[redacted]');
        expect(redacted.model).toBe('gpt-4.1');
        expect(redacted.monkey).toBe('not-a-secret');
    });

    it('user gets query values removed from urls in text', () => {
        const text = 'GET https://example.test/v1/models?api_key=sk-secret';

        expect(redactText(text)).toBe('GET https://example.test/v1/models');
    });

    it('user gets bearer tokens and credential assignments removed', () => {
        const text = 'Authorization: Bearer abcdefghijklmnopqrst token=secret-value';

        const redacted = redactText(text);
        expect(redacted).not.toContain('abcdefghijklmnopqrst');
        expect(redacted).not.toContain('secret-value');
    });

    it('user gets home directories replaced', () => {
        expect(redactText('/home/alice/project/file.ts')).toBe('~/project/file.ts');
        expect(redactText('/root/project/file.ts')).toBe('~/project/file.ts');
    });

    it('user gets urls without credentials or query', () => {
        expect(redactUrl('https://user:pass@example.test/path?token=1#frag')).toBe(
            'https://example.test/path'
        );
        expect(redactUrl('not-a-url?token=secret')).toBe('not-a-url');
    });
});
