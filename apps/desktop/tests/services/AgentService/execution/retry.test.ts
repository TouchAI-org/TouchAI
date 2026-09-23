import { describe, expect, it } from 'vitest';

import { AiError, AiErrorCode } from '@/services/AgentService/contracts/errors';
import { shouldRetryRequestFailure } from '@/services/AgentService/execution/retry';

describe('AgentService retry policy', () => {
    it('retries errors that are retryable by error code', () => {
        const error = new AiError(AiErrorCode.TIMEOUT, undefined, 'Request timed out');

        expect(shouldRetryRequestFailure(error)).toBe(true);
    });

    it('retries generic API errors when error details carry a retryable HTTP status', () => {
        const error = new AiError(
            AiErrorCode.API_ERROR,
            {
                statusCode: 429,
            },
            'HTTP 429'
        );

        expect(shouldRetryRequestFailure(error)).toBe(true);
    });

    it('retries non-API errors when error details carry a retryable HTTP status', () => {
        const error = new AiError(
            AiErrorCode.INVALID_CONFIG,
            {
                statusCode: 503,
            },
            'Provider returned HTTP 503'
        );

        expect(shouldRetryRequestFailure(error)).toBe(true);
    });

    it('retries generic API errors when runtime provider details carry a retryable HTTP status', () => {
        const error = new AiError(AiErrorCode.API_ERROR, undefined, 'HTTP 503');

        expect(
            shouldRetryRequestFailure(error, {
                statusCode: 503,
            })
        ).toBe(true);
    });
});
