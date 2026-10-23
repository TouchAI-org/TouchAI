import { describe, expect, it } from 'vitest';

import { AiError, AiErrorCode } from '@/services/AgentService/contracts/errors';
import { shouldRetryRequestFailure } from '@/services/AgentService/execution/retry';

describe('user gets a failing request retried when the failure may be temporary', () => {
    it('user gets a temporary failure retried when the provider says it may pass', () => {
        const error = new AiError(AiErrorCode.TIMEOUT, undefined, 'Request timed out');

        expect(shouldRetryRequestFailure(error)).toBe(true);
    });

    it('user gets a rate-limited failure retried even when the provider reports no details', () => {
        const error = new AiError(
            AiErrorCode.API_ERROR,
            {
                statusCode: 429,
            },
            'HTTP 429'
        );

        expect(shouldRetryRequestFailure(error)).toBe(true);
    });

    it('user gets a service-unavailable failure retried even when it is classified as config', () => {
        const error = new AiError(
            AiErrorCode.INVALID_CONFIG,
            {
                statusCode: 503,
            },
            'Provider returned HTTP 503'
        );

        expect(shouldRetryRequestFailure(error)).toBe(true);
    });

    it('user gets a retryable status from the provider runtime retried', () => {
        const error = new AiError(AiErrorCode.API_ERROR, undefined, 'HTTP 503');

        expect(
            shouldRetryRequestFailure(error, {
                statusCode: 503,
            })
        ).toBe(true);
    });
});
