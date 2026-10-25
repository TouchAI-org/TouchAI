// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { describe, expect, it } from 'vitest';

import { AiErrorCode } from '@/services/AgentService/contracts/errors';
import {
    buildUrlWithQueryParams,
    extractApiCallError,
    mapHttpStatusToAiError,
    normalizeProviderBaseUrl,
} from '@/services/AgentService/infrastructure/providers/ai-sdk/base';

/**
 * A provider base URL is typed by the user. Appending or keeping a trailing slash produces a
 * double slash on the wire, which some gateways reject and others treat as a different path.
 */
describe('user types a provider base url', () => {
    it('user gets the trailing slashes removed', () => {
        expect(normalizeProviderBaseUrl('https://api.example.com/v1/')).toBe(
            'https://api.example.com/v1'
        );
        expect(normalizeProviderBaseUrl('https://api.example.com/v1///')).toBe(
            'https://api.example.com/v1'
        );
    });

    it('user gets a url without a trailing slash left alone', () => {
        expect(normalizeProviderBaseUrl('https://api.example.com/v1')).toBe(
            'https://api.example.com/v1'
        );
    });

    it('user gets an empty url left empty rather than turning into a slash', () => {
        expect(normalizeProviderBaseUrl('')).toBe('');
    });
});

/**
 * Azure-style providers need an api-version query parameter. It has to be merged into a URL
 * that may already carry its own query, without dropping or duplicating anything.
 */
describe('user connects to a provider that needs query parameters', () => {
    it('user gets the parameter added to a url that had none', () => {
        const url = buildUrlWithQueryParams('https://api.example.com/v1/chat', {
            'api-version': '2024-02-01',
        });

        expect(url).toContain('api-version=2024-02-01');
    });

    it('user gets existing query parameters kept alongside the new one', () => {
        const url = buildUrlWithQueryParams('https://api.example.com/v1/chat?model=gpt', {
            'api-version': '2024-02-01',
        });

        expect(url).toContain('model=gpt');
        expect(url).toContain('api-version=2024-02-01');
    });

    it('user gets an existing parameter replaced rather than duplicated', () => {
        const url = buildUrlWithQueryParams('https://api.example.com/v1?api-version=old', {
            'api-version': 'new',
        });

        // A duplicate would still satisfy a "contains" check, so count the parameters.
        const params = new URL(url).searchParams.getAll('api-version');
        expect(params).toEqual(['new']);
    });

    it('user gets the url untouched when there is nothing to add', () => {
        expect(buildUrlWithQueryParams('https://api.example.com/v1', {})).toBe(
            'https://api.example.com/v1'
        );
        expect(buildUrlWithQueryParams('', { 'api-version': '1' })).toBe('');
    });
});

/**
 * The AI SDK wraps failures in its own error types. The app has to read them without
 * depending on the SDK's internals, or a minor SDK upgrade silently changes the behaviour.
 */
describe('user gets a provider failure recognised whatever shape it arrives in', () => {
    it('user gets a plain api error read for its status and body', () => {
        const error = extractApiCallError({
            statusCode: 429,
            responseBody: '{"error":"slow down"}',
            message: 'Too many requests',
        });

        expect(error?.statusCode).toBe(429);
        expect(error?.responseBody).toBe('{"error":"slow down"}');
        expect(error?.message).toBe('Too many requests');
    });

    it('user gets a retry wrapper unwrapped to the last error', () => {
        const error = extractApiCallError({
            name: 'AI_RetryError',
            lastError: { statusCode: 503, responseBody: 'unavailable', message: 'Server busy' },
        });

        expect(error?.statusCode).toBe(503);
        expect(error?.message).toBe('Server busy');
    });

    it('user gets no api error from something unrelated', () => {
        expect(extractApiCallError(new Error('plain failure'))).toBeNull();
        expect(extractApiCallError(null)).toBeNull();
        expect(extractApiCallError('a string')).toBeNull();
        expect(extractApiCallError({ message: 'no status here' })).toBeNull();
    });

    it('user gets a missing message rendered as an empty string rather than undefined', () => {
        const error = extractApiCallError({ statusCode: 500 });

        expect(error?.message).toBe('');
    });
});

/**
 * A provider failure becomes a message the user reads. The status code decides whether the
 * app offers a retry, and getting the mapping wrong either hides a retryable failure or
 * retries something that will never succeed.
 */
describe('user gets a provider failure explained from its status code', () => {
    it('user gets an auth failure mapped for 401 and 403', () => {
        expect(mapHttpStatusToAiError(401, 'nope')?.code).toBe(AiErrorCode.UNAUTHORIZED);
        expect(mapHttpStatusToAiError(403, 'nope')?.code).toBe(AiErrorCode.UNAUTHORIZED);
    });

    it('user gets a timeout mapped for 408', () => {
        expect(mapHttpStatusToAiError(408, 'slow')?.code).toBe(AiErrorCode.TIMEOUT);
    });

    it('user gets a rate limit mapped for 429', () => {
        expect(mapHttpStatusToAiError(429, 'slow down')?.code).toBe(AiErrorCode.RATE_LIMIT);
    });

    it('user gets each gateway failure mapped distinctly', () => {
        expect(mapHttpStatusToAiError(502, 'bad')?.code).toBe(AiErrorCode.BAD_GATEWAY);
        expect(mapHttpStatusToAiError(503, 'busy')?.code).toBe(AiErrorCode.SERVICE_UNAVAILABLE);
        expect(mapHttpStatusToAiError(504, 'slow')?.code).toBe(AiErrorCode.GATEWAY_TIMEOUT);
    });

    it('user gets an unmapped server failure treated as a generic api error', () => {
        expect(mapHttpStatusToAiError(500, 'boom')?.code).toBe(AiErrorCode.API_ERROR);
        expect(mapHttpStatusToAiError(599, 'boom')?.code).toBe(AiErrorCode.API_ERROR);
    });

    it('user gets no error for a status that is not a server or auth failure', () => {
        // A 400 is the caller's fault and is reported by the caller, not mapped here.
        expect(mapHttpStatusToAiError(400, 'bad request')).toBeNull();
        expect(mapHttpStatusToAiError(200, 'ok')).toBeNull();
        expect(mapHttpStatusToAiError(undefined, 'unknown')).toBeNull();
    });

    it('user gets the provider detail kept when it is not just a status line', () => {
        const error = mapHttpStatusToAiError(429, 'quota exhausted for this key');

        expect(error?.message).toBe('quota exhausted for this key');
    });

    it('user gets a bare status line dropped in favour of the standard message', () => {
        // "HTTP 429" carries nothing the user can act on, so the standard text is used.
        const error = mapHttpStatusToAiError(429, 'HTTP 429');

        expect(error?.message).not.toBe('HTTP 429');
        expect(error?.message.length).toBeGreaterThan(0);
    });
});
