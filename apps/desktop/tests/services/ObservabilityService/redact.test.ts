// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import {
    MAX_AUDIT_PAYLOAD_BYTES,
    redactAttributes,
    redactText,
    redactUrl,
    serializeAuditPayload,
} from '@services/ObservabilityService/redact';
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

    it('user gets common api tokens redacted without a key name', () => {
        expect(redactText('failed with sk-live-secret-123456')).not.toContain(
            'sk-live-secret-123456'
        );
    });

    it('user gets secret object fields redacted in audit payloads', () => {
        const payload = serializeAuditPayload({
            command: 'deploy',
            apiKey: 'sk-live-secret-123456',
            nested: { token: 'secret-token-value' },
        });

        expect(payload).not.toContain('sk-live-secret-123456');
        expect(payload).not.toContain('secret-token-value');
        expect(JSON.parse(payload)).toMatchObject({
            command: 'deploy',
            apiKey: '[redacted]',
            nested: { token: '[redacted]' },
        });
    });

    it('user gets camelCase credential fields redacted in audit payloads', () => {
        const payload = serializeAuditPayload({
            accessToken: 'plain-access-token',
            refreshToken: 'plain-refresh-token',
            clientSecret: 'plain-client-secret',
            privateKey: 'plain-private-key',
            sessionId: 'kept',
        });

        expect(payload).not.toContain('plain-access-token');
        expect(payload).not.toContain('plain-refresh-token');
        expect(payload).not.toContain('plain-client-secret');
        expect(payload).not.toContain('plain-private-key');
        expect(JSON.parse(payload)).toEqual({
            accessToken: '[redacted]',
            refreshToken: '[redacted]',
            clientSecret: '[redacted]',
            privateKey: '[redacted]',
            sessionId: 'kept',
        });
    });

    it('user gets nested truncation marked in audit payloads', () => {
        const payload = serializeAuditPayload({
            items: Array.from({ length: 102 }, (_, index) => index),
            wide: Object.fromEntries(
                Array.from({ length: 202 }, (_, index) => [`k${index}`, index])
            ),
        });
        const parsed = JSON.parse(payload);

        expect(parsed.items).toHaveLength(101);
        expect(parsed.items[100]).toBe('[truncated 2 entries]');
        expect(parsed.wide._truncated_keys).toBe(2);
    });

    it('user gets deep nesting marked in audit payloads', () => {
        let deep: Record<string, unknown> = { leaf: 'value' };
        for (let level = 0; level < 12; level += 1) {
            deep = { nested: deep };
        }

        const payload = serializeAuditPayload(deep);

        expect(payload).toContain('[redacted-depth]');
    });

    it('user gets a marked preview when a large object exceeds the audit ceiling', () => {
        const payload = serializeAuditPayload({
            output: Array.from({ length: 200 }, () => 'y'.repeat(1000)),
        });
        const parsed = JSON.parse(payload);

        expect(new TextEncoder().encode(payload).byteLength).toBeLessThanOrEqual(
            MAX_AUDIT_PAYLOAD_BYTES
        );
        expect(parsed._truncated).toBe(true);
        expect(parsed.originalBytes).toBeGreaterThan(MAX_AUDIT_PAYLOAD_BYTES);
        expect(typeof parsed.preview).toBe('string');
    });

    it('user gets a quote-dense preview that still fits the audit ceiling', () => {
        const payload = serializeAuditPayload({
            output: Array.from({ length: 200 }, () => '"\\"'.repeat(500)),
        });
        const parsed = JSON.parse(payload);

        expect(new TextEncoder().encode(payload).byteLength).toBeLessThanOrEqual(
            MAX_AUDIT_PAYLOAD_BYTES
        );
        expect(parsed._truncated).toBe(true);
    });

    it('user keeps ordinary tool output beyond the log attribute limit', () => {
        const output = serializeAuditPayload(`result: ${'x'.repeat(2000)}`);

        expect(output).toContain('x'.repeat(2000));
        expect(output).not.toContain('[truncated');
    });

    it('user gets a marked payload when tool output exceeds the audit ceiling', () => {
        const output = serializeAuditPayload('x'.repeat(MAX_AUDIT_PAYLOAD_BYTES + 1024));

        expect(new TextEncoder().encode(output).byteLength).toBeLessThanOrEqual(
            MAX_AUDIT_PAYLOAD_BYTES
        );
        expect(output).toContain('[truncated original_bytes=');
    });

    it('user gets adversarial tool output redacted without stalling the window', () => {
        // Dash-joined identifiers used to make the key pattern backtrack
        // catastrophically: 128KB took ~20s on the renderer thread.
        const hostile = `result: ${'a-'.repeat(64 * 1024)}done`;
        const startedAt = performance.now();
        const output = serializeAuditPayload(hostile);
        const elapsedMs = performance.now() - startedAt;

        expect(output).toContain('result:');
        expect(elapsedMs).toBeLessThan(1000);
    });

    it('user gets an ordinary assignment left alone when the key is not a secret', () => {
        const output = serializeAuditPayload('status=completed attempts=3 path=a-b-c');

        expect(output).toBe('status=completed attempts=3 path=a-b-c');
    });
});
