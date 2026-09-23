import { beforeEach, describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';
import { AiError, AiErrorCode } from '@/services/AgentService/contracts/errors';
import { mapHttpStatusToAiError } from '@/services/AgentService/infrastructure/providers/ai-sdk/base';

describe('AiError display localization', () => {
    beforeEach(() => {
        setLocale('zh-CN');
    });

    it('localizes app-generated default messages for the active locale', () => {
        setLocale('en-US');

        expect(new AiError(AiErrorCode.NO_ACTIVE_MODEL).getDisplayMessage()).toBe(
            'No available AI model is configured. Add a model in Settings.'
        );
        expect(new AiError(AiErrorCode.EMPTY_RESPONSE).getDisplayMessage()).toBe(
            'The model returned an empty response. Try asking again or switch models.'
        );
        expect(new AiError(AiErrorCode.TIMEOUT).getDisplayMessage()).toBe(
            'Request timed out. Try again later.'
        );
        expect(new AiError(AiErrorCode.SESSION_ACTIVE_TASK_EXISTS).getDisplayMessage()).toBe(
            'This session already has a running task. Wait for it to finish or cancel it first.'
        );
    });

    it('keeps provider and API payload messages raw when a custom message is supplied', () => {
        setLocale('en-US');

        const error = new AiError(AiErrorCode.API_ERROR, undefined, 'provider raw payload');

        expect(error.getDisplayMessage()).toBe('provider raw payload');
    });

    it('normalizes unsupported input endpoint errors from plain Error objects', () => {
        const error = new Error('No endpoints found that support image input');

        expect(AiError.getDisplayMessage(error)).toBe(
            AiError.getMessage(AiErrorCode.UNSUPPORTED_INPUT)
        );
    });

    it('normalizes unsupported endpoint errors when other capabilities are listed too', () => {
        const error = new AiError(
            AiErrorCode.API_ERROR,
            undefined,
            'No endpoints found that support tool, image, and file inputs'
        );

        expect(error.getDisplayMessage()).toBe(AiError.getMessage(AiErrorCode.UNSUPPORTED_INPUT));
    });

    it('keeps default Error.message stable while exposing localized display text', () => {
        setLocale('en-US');
        const error = new AiError(AiErrorCode.NO_ACTIVE_MODEL);

        expect(error.message).toBe(AiError.getMessage(AiErrorCode.NO_ACTIVE_MODEL));
        expect(error.getDisplayMessage()).toBe(
            'No available AI model is configured. Add a model in Settings.'
        );
    });

    it('classifies localized cancellation messages as request cancellation', () => {
        const error = AiError.fromError(new Error('\u8bf7\u6c42\u5df2\u53d6\u6d88'));

        expect(error.is(AiErrorCode.REQUEST_CANCELLED)).toBe(true);
    });

    it('shows the default localized network message for transport failures', () => {
        setLocale('en-US');

        const rawError = new Error(
            'error sending request for url (https://token-plan-cn.xiaomimimo.com/v1/chat/completions)'
        );
        const error = AiError.fromError(rawError);

        expect(error.code).toBe(AiErrorCode.NETWORK_ERROR);
        expect(error.getDisplayMessage()).toBe(
            'Network connection failed. Check your network settings.'
        );
        expect(error.cause).toBe(rawError);
        expect(error.details).toBe(rawError);
    });

    it('uses the default localized message for generic HTTP status errors', () => {
        setLocale('en-US');

        const error = mapHttpStatusToAiError(401, 'HTTP 401');

        expect(error?.code).toBe(AiErrorCode.UNAUTHORIZED);
        expect(error?.message).toBe(AiError.getMessage(AiErrorCode.UNAUTHORIZED));
        expect(error?.getDisplayMessage()).toBe('Authentication failed. Check the API key.');
    });
});
