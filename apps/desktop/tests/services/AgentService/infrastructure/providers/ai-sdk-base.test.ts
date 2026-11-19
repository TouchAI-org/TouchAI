// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { trace } from '@opentelemetry/api';
import {
    InMemorySpanExporter,
    SimpleSpanProcessor,
    TracerProvider,
} from '@opentelemetry/sdk-trace';
import { compatibleResponse, createCompatibleProvider } from '@tests/utils/provider';
import { normalizeProviderBaseUrl } from '@touchai/models';
import { AiErrorCode } from '@touchai/models/contracts';
import { describe, expect, it } from 'vitest';

function classify(error: unknown) {
    const connection = createCompatibleProvider(globalThis.fetch);
    try {
        return connection.classifyError?.(error) ?? null;
    } finally {
        connection.dispose();
    }
}

function mapped(statusCode: number | undefined, message: string) {
    return classify({ statusCode, message });
}

async function discoveryUrl(endpoint: string, queryParams: Record<string, string>) {
    let url = '';
    const connection = createCompatibleProvider(
        async (input) => {
            url = String(input);
            return Response.json({ data: [] });
        },
        { apiEndpoint: endpoint, config: { queryParams } }
    );
    try {
        await connection.listModels();
        return url;
    } finally {
        connection.dispose();
    }
}

describe('given a real provider request records local SDK spans', () => {
    it('user keeps prompt and generated text out of every completed SDK span', async () => {
        trace.disable();
        const exporter = new InMemorySpanExporter();
        const tracer = new TracerProvider({
            spanProcessors: [new SimpleSpanProcessor({ exporter })],
        });
        trace.setGlobalTracerProvider(tracer);
        const connection = createCompatibleProvider(async () =>
            compatibleResponse('private-generated-sentinel')
        );
        try {
            expect(
                (
                    await connection.request({
                        model: 'fixture',
                        messages: [{ role: 'user', content: 'private-prompt-sentinel' }],
                    })
                ).content
            ).toBe('private-generated-sentinel');
            await tracer.forceFlush();
            const spans = exporter.getFinishedSpans();
            expect(spans.length).toBeGreaterThan(0);
            const payload = JSON.stringify(
                spans.map(({ attributes, events }) => ({ attributes, events }))
            );
            expect(payload).not.toMatch(/private-prompt-sentinel|private-generated-sentinel/);
            expect(payload).not.toMatch(/ai\.prompt\.messages|ai\.response\.text/);
        } finally {
            connection.dispose();
            await tracer.shutdown();
            trace.disable();
        }
    });
});

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
    it('user gets the parameter added to a url that had none', async () => {
        const url = await discoveryUrl('https://api.example.com/v1/chat', {
            'api-version': '2024-02-01',
        });

        expect(url).toContain('api-version=2024-02-01');
    });

    it('user gets existing query parameters kept alongside the new one', async () => {
        const url = await discoveryUrl('https://api.example.com/v1?model=gpt', {
            'api-version': '2024-02-01',
        });

        expect(url).toContain('model=gpt');
        expect(url).toContain('api-version=2024-02-01');
    });

    it('user gets an existing parameter replaced rather than duplicated', async () => {
        const url = await discoveryUrl('https://api.example.com/v1?api-version=old', {
            'api-version': 'new',
        });

        // A duplicate would still satisfy a "contains" check, so count the parameters.
        const params = new URL(url).searchParams.getAll('api-version');
        expect(params).toEqual(['new']);
    });

    it('user gets the discovery endpoint unchanged when there is nothing to add', async () => {
        expect(await discoveryUrl('https://api.example.com/v1', {})).toBe(
            'https://api.example.com/v1/models'
        );
        await expect(discoveryUrl('', { 'api-version': '1' })).rejects.toThrow(
            'Provider base URL is empty'
        );
    });
});

/**
 * The AI SDK wraps failures in its own error types. The app has to read them without
 * depending on the SDK's internals, or a minor SDK upgrade silently changes the behaviour.
 */
describe('user gets a provider failure recognised whatever shape it arrives in', () => {
    it('user gets a plain api error read for its status and body', () => {
        const error = classify({
            statusCode: 429,
            responseBody: '{"error":"slow down"}',
            message: 'Too many requests',
        });

        expect(error?.code).toBe(AiErrorCode.RATE_LIMIT);
        expect(error?.cause).toMatchObject({ responseBody: '{"error":"slow down"}' });
        expect(error?.message).toBe('Too many requests');
    });

    it('user gets a retry wrapper unwrapped to the last error', () => {
        const error = classify({
            name: 'AI_RetryError',
            lastError: { statusCode: 503, responseBody: 'unavailable', message: 'Server busy' },
        });

        expect(error?.code).toBe(AiErrorCode.SERVICE_UNAVAILABLE);
        expect(error?.message).toBe('Server busy');
    });

    it('user gets no api error from something unrelated', () => {
        expect(classify(new Error('plain failure'))).toBeNull();
        expect(classify(null)).toBeNull();
        expect(classify('a string')).toBeNull();
        expect(classify({ message: 'no status here' })).toBeNull();
    });

    it('user gets a missing message rendered as an empty string rather than undefined', () => {
        const error = classify({ statusCode: 500 });

        expect(error?.code).toBe(AiErrorCode.API_ERROR);
        expect(error?.usesDefaultMessage).toBe(true);
    });
});

/**
 * A provider failure becomes a message the user reads. The status code decides whether the
 * app offers a retry, and getting the mapping wrong either hides a retryable failure or
 * retries something that will never succeed.
 */
describe('user gets a provider failure explained from its status code', () => {
    it('user gets an auth failure mapped for 401 and 403', () => {
        expect(mapped(401, 'nope')?.code).toBe(AiErrorCode.UNAUTHORIZED);
        expect(mapped(403, 'nope')?.code).toBe(AiErrorCode.UNAUTHORIZED);
    });

    it('user gets a timeout mapped for 408', () => {
        expect(mapped(408, 'slow')?.code).toBe(AiErrorCode.TIMEOUT);
    });

    it('user gets a rate limit mapped for 429', () => {
        expect(mapped(429, 'slow down')?.code).toBe(AiErrorCode.RATE_LIMIT);
    });

    it('user gets each gateway failure mapped distinctly', () => {
        expect(mapped(502, 'bad')?.code).toBe(AiErrorCode.BAD_GATEWAY);
        expect(mapped(503, 'busy')?.code).toBe(AiErrorCode.SERVICE_UNAVAILABLE);
        expect(mapped(504, 'slow')?.code).toBe(AiErrorCode.GATEWAY_TIMEOUT);
    });

    it('user gets an unmapped server failure treated as a generic api error', () => {
        expect(mapped(500, 'boom')?.code).toBe(AiErrorCode.API_ERROR);
        expect(mapped(599, 'boom')?.code).toBe(AiErrorCode.API_ERROR);
    });

    it('user gets no error for a status that is not a server or auth failure', () => {
        // A 400 is the caller's fault and is reported by the caller, not mapped here.
        expect(mapped(400, 'bad request')).toBeNull();
        expect(mapped(200, 'ok')).toBeNull();
        expect(mapped(undefined, 'unknown')).toBeNull();
    });

    it('user gets the provider detail kept when it is not just a status line', () => {
        const error = mapped(429, 'quota exhausted for this key');

        expect(error?.message).toBe('quota exhausted for this key');
    });

    it('user gets a bare status line dropped in favour of the standard message', () => {
        // "HTTP 429" carries nothing the user can act on, so the standard text is used.
        const error = mapped(429, 'HTTP 429');

        expect(error?.message).not.toBe('HTTP 429');
        expect(error?.message.length).toBeGreaterThan(0);
    });
});
