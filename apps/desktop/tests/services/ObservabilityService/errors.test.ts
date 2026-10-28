// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { classifyError } from '@services/ObservabilityService/errors';
import { describe, expect, it } from 'vitest';

describe('user reads the failure reason of a failed request', () => {
    it('user gets a rate limit code when the message carries status 429', () => {
        expect(classifyError(new Error('HTTP 429 Too Many Requests'))).toBe(
            'provider.rate_limited'
        );
    });

    it('user gets no rate limit code when a longer number merely contains 429', () => {
        expect(classifyError(new Error('port 14290 refused'))).not.toBe('provider.rate_limited');
    });

    it('user gets an auth code when the message carries status 401', () => {
        expect(classifyError(new Error('401 Unauthorized'))).toBe('provider.auth');
    });

    it('user gets no auth code when a request id merely contains 401', () => {
        expect(classifyError(new Error('request id 40123 finished'))).not.toBe('provider.auth');
    });
});
