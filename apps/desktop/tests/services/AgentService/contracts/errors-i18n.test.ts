import { beforeEach, describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';
import { AiError, AiErrorCode } from '@/services/AgentService/contracts/errors';
import { mapHttpStatusToAiError } from '@/services/AgentService/infrastructure/providers/ai-sdk/base';

describe('user reads request failures in their own language', () => {
    beforeEach(() => {
        setLocale('zh-CN');
    });

    it('user reads app-generated failure text in the active language', () => {
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

    it('user sees provider-supplied failure text exactly as the provider sent it', () => {
        setLocale('en-US');

        const error = new AiError(AiErrorCode.API_ERROR, undefined, 'provider raw payload');

        expect(error.getDisplayMessage()).toBe('provider raw payload');
    });

    it('user sees an unsupported-endpoint failure explained for an input the model cannot take', () => {
        const error = new Error('No endpoints found that support image input');

        expect(AiError.getDisplayMessage(error)).toBe(
            AiError.getMessage(AiErrorCode.UNSUPPORTED_INPUT)
        );
    });

    it('user sees an unsupported-endpoint failure explained when other capabilities are listed too', () => {
        const error = new AiError(
            AiErrorCode.API_ERROR,
            undefined,
            'No endpoints found that support tool, image, and file inputs'
        );

        expect(error.getDisplayMessage()).toBe(AiError.getMessage(AiErrorCode.UNSUPPORTED_INPUT));
    });

    it('user sees a stable technical message with a localized one for display', () => {
        setLocale('en-US');
        const error = new AiError(AiErrorCode.NO_ACTIVE_MODEL);

        expect(error.message).toBe(AiError.getMessage(AiErrorCode.NO_ACTIVE_MODEL));
        expect(error.getDisplayMessage()).toBe(
            'No available AI model is configured. Add a model in Settings.'
        );
    });

    it('user sees a cancelled request recognized whatever the language', () => {
        const error = AiError.fromError(new Error('\u8bf7\u6c42\u5df2\u53d6\u6d88'));

        expect(error.is(AiErrorCode.REQUEST_CANCELLED)).toBe(true);
    });

    it('user sees a friendly network failure instead of a transport dump', () => {
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

    it('user sees a friendly message for an unexplained HTTP failure', () => {
        setLocale('en-US');

        const error = mapHttpStatusToAiError(401, 'HTTP 401');

        expect(error?.code).toBe(AiErrorCode.UNAUTHORIZED);
        expect(error?.message).toBe(AiError.getMessage(AiErrorCode.UNAUTHORIZED));
        expect(error?.getDisplayMessage()).toBe('Authentication failed. Check the API key.');
    });
});
