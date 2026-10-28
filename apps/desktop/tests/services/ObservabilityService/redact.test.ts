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

        expect(redactText(text)).toBe('GET https://example.test/[redacted-path]');
    });

    it('user gets credentials removed from non-http urls in text', () => {
        const redacted = redactText(
            'connect postgres://user:pass@db.example.test:5432/app?sslkey=secret'
        );

        expect(redacted).toBe('connect postgres://db.example.test:5432/[redacted-path]');
        expect(redacted).not.toContain('pass');
        expect(redacted).not.toContain('secret');
    });

    it('user gets bearer tokens and credential assignments removed', () => {
        const text = 'Authorization: Bearer abcdefghijklmnopqrst token=secret-value';

        const redacted = redactText(text);
        expect(redacted).not.toContain('abcdefghijklmnopqrst');
        expect(redacted).not.toContain('secret-value');
    });

    it('user gets standalone basic credentials removed', () => {
        const redacted = redactText('connect failed Basic dXNlcjpwYXNz retrying');

        expect(redacted).not.toContain('dXNlcjpwYXNz');
        expect(redacted).toContain('Basic [redacted]');
        expect(redacted).toContain('retrying');
    });

    it('user does not see the tail of a cookie header', () => {
        const redacted = redactText('Cookie: session=abc123; csrftoken=leak456');

        expect(redacted).toBe('Cookie: [redacted]');
        expect(redacted).not.toContain('abc123');
        expect(redacted).not.toContain('leak456');
    });

    it('user gets auth assignments removed', () => {
        const redacted = redactText('auth=opaque-secret retrying');

        expect(redacted).toBe('auth=[redacted] retrying');
    });

    it('user gets mixed-case and prefixed credential keys removed', () => {
        const text =
            'X-Api-Key: sk-live-secret Proxy-Authorization: Basic dXNlcjpwYXNz Cookie=session=abc123';

        const redacted = redactText(text);
        expect(redacted).not.toContain('sk-live-secret');
        expect(redacted).not.toContain('dXNlcjpwYXNz');
        expect(redacted).not.toContain('abc123');
        expect(redacted).toContain('X-Api-Key: [redacted]');
    });

    it('user keeps an ordinary word that ends in key untouched', () => {
        expect(redactText('monkey=banana')).toBe('monkey=banana');
    });

    it('user gets home directories replaced', () => {
        expect(redactText('/home/alice/project/file.ts')).toBe('~/project/file.ts');
        expect(redactText('/root/project/file.ts')).toBe('~/project/file.ts');
    });

    it('user gets long multibyte text truncated by utf8 bytes', () => {
        const redacted = redactText('汉'.repeat(400));

        expect(new TextEncoder().encode(redacted).length).toBeLessThanOrEqual(1024);
        expect(redacted.endsWith('…')).toBe(true);
    });

    it('user gets urls without credentials or query', () => {
        expect(redactUrl('https://user:pass@example.test/path?token=1#frag')).toBe(
            'https://example.test/[redacted-path]'
        );
        expect(redactUrl('https://example.test/')).toBe('https://example.test');
        expect(redactUrl('not-a-url?token=secret')).toBe('[redacted-url]');
        expect(redactUrl('https://user:pass@')).toBe('[redacted-url]');
    });
});
