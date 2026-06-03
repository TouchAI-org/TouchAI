import { beforeEach, describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';
import { AiError, AiErrorCode } from '@/services/AgentService/contracts/errors';

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

        const error = new AiError(AiErrorCode.API_ERROR, undefined, '供应商返回的原始错误 payload');

        expect(error.getDisplayMessage()).toBe('供应商返回的原始错误 payload');
    });

    it('normalizes unsupported input endpoint errors from plain Error objects', () => {
        const error = new Error('No endpoints found that support image input');

        expect(AiError.getDisplayMessage(error)).toBe(
            '当前模型不支持图片/文件输入，请选择合适模型继续。'
        );
    });

    it('normalizes unsupported endpoint errors when other capabilities are listed too', () => {
        const error = new AiError(
            AiErrorCode.API_ERROR,
            undefined,
            'No endpoints found that support tool, image, and file inputs'
        );

        expect(error.getDisplayMessage()).toBe('当前模型不支持图片/文件输入，请选择合适模型继续。');
    });

    it('keeps default Error.message stable while exposing localized display text', () => {
        setLocale('en-US');
        const error = new AiError(AiErrorCode.NO_ACTIVE_MODEL);

        expect(error.message).toBe('未配置可用的 AI 模型，请前往设置页面添加模型');
        expect(error.getDisplayMessage()).toBe(
            'No available AI model is configured. Add a model in Settings.'
        );
    });
});
