import { describe, expect, it } from 'vitest';

import { AiError, AiErrorCode } from './errors';

describe('AiError.fromError', () => {
    it('classifies low-level send failures as retryable network errors', () => {
        const error = AiError.fromError(
            new Error(
                'Request failed: error sending request for url (https://example.com/v1/chat/completions)'
            )
        );

        expect(error.code).toBe(AiErrorCode.NETWORK_ERROR);
        expect(error.message).toContain('error sending request for url');
        expect(error.isRetryable()).toBe(true);
    });

    it('keeps aborted requests non-retryable', () => {
        const error = AiError.fromError(new Error('The operation was aborted'));

        expect(error.code).toBe(AiErrorCode.REQUEST_CANCELLED);
        expect(error.isRetryable()).toBe(false);
    });
});
