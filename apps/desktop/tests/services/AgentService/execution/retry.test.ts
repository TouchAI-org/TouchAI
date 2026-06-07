import { describe, expect, it } from 'vitest';

import { AiError, AiErrorCode } from '@/contracts/agentErrors';
import { shouldRetryRequestFailure } from '@/services/AgentService/execution/retry';

describe('AgentService retry policy', () => {
    it('does not retry provider business API errors', () => {
        const error = new AiError(
            AiErrorCode.API_ERROR,
            {
                gatewayCode: 'policy_blocked',
                statusCode: 403,
                requiresRelogin: false,
            },
            'This activity is not eligible for your account.'
        );

        expect(shouldRetryRequestFailure(error)).toBe(false);
    });

    it('retries transient provider gateway failures even when they are generic API errors', () => {
        const error = new AiError(
            AiErrorCode.API_ERROR,
            {
                gatewayCode: 'upstream_unavailable',
                statusCode: 503,
                requiresRelogin: false,
            },
            'The upstream provider is temporarily unavailable.'
        );

        expect(shouldRetryRequestFailure(error)).toBe(true);
    });

    it('retries generic API errors when provider details carry a retryable HTTP status', () => {
        const error = new AiError(
            AiErrorCode.API_ERROR,
            {
                statusCode: 503,
                requiresRelogin: false,
            },
            'HTTP 503'
        );

        expect(shouldRetryRequestFailure(error)).toBe(true);
    });

    it('retries generic API errors when runtime provider details carry a retryable HTTP status', () => {
        const error = new AiError(
            AiErrorCode.API_ERROR,
            {
                requiresRelogin: false,
            },
            'HTTP 503'
        );

        expect(
            shouldRetryRequestFailure(error, {
                statusCode: 503,
            })
        ).toBe(true);
    });

    it('does not retry when requiresRelogin is true', () => {
        const error = new AiError(
            AiErrorCode.API_ERROR,
            {
                gatewayCode: 'upstream_unauthorized',
                statusCode: 503,
                requiresRelogin: true,
            },
            'Managed session expired.'
        );

        expect(shouldRetryRequestFailure(error)).toBe(false);
    });
});
