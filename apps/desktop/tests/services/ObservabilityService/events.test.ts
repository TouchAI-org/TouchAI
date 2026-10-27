// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { ATTR } from '@services/ObservabilityService/attributes';
import { validateEventAttributes } from '@services/ObservabilityService/events';
import { describe, expect, it } from 'vitest';

describe('user gets a fixed schema for critical events', () => {
    it('user cannot attach prompt contents to an agent event', () => {
        expect(() =>
            validateEventAttributes('agent.request.failed', {
                [ATTR.providerName]: 'openai',
                [ATTR.requestModel]: 'gpt-test',
                [ATTR.errorCode]: 'provider.rate_limited',
                'error.type': 'APICallError',
                prompt: 'private user text',
            })
        ).toThrow();
    });

    it('user gets a documented agent failure event accepted', () => {
        expect(() =>
            validateEventAttributes('agent.request.failed', {
                [ATTR.providerName]: 'openai',
                [ATTR.requestModel]: 'gpt-test',
                [ATTR.errorCode]: 'provider.rate_limited',
                'error.type': 'APICallError',
                [ATTR.httpStatus]: 429,
                [ATTR.retryable]: true,
            })
        ).not.toThrow();
    });
});
