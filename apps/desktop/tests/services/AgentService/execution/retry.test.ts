import { describe, expect, it } from 'vitest';

import { AiError, AiErrorCode } from '@/services/AgentService/contracts/errors';
import { shouldRetryRequestFailure } from '@/services/AgentService/execution/retry';

describe('AgentService retry policy', () => {
    it('retries generic API errors when runtime provider details carry a retryable HTTP status', () => {
        const error = new AiError(AiErrorCode.API_ERROR, undefined, 'HTTP 503');

        expect(
            shouldRetryRequestFailure(error, {
                statusCode: 503,
            })
        ).toBe(true);
    });
});
