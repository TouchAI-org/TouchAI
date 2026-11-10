import { describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';
import { describeSettingsFailure } from '@/services/SettingsService/messages';
import { SettingsErrorCode, SettingsServiceError } from '@/services/SettingsService/types';

describe('user reads a settings failure that matches what they can act on', () => {
    it('user is told which action already uses the shortcut', () => {
        setLocale('zh-CN');
        const error = new SettingsServiceError(SettingsErrorCode.Rejected, {
            rejection: {
                kind: 'shortcut-conflict',
                actionLabelKey: 'settings.general.searchActions.history',
            },
        });

        expect(describeSettingsFailure(error, '保存设置失败')).toBe(
            '该快捷键已被“打开会话历史”使用，请换一个组合'
        );
    });

    it('user gets the generic save message when an internal failure has no rejection', () => {
        setLocale('zh-CN');
        const cases = [
            new SettingsServiceError(SettingsErrorCode.PersistenceFailed, {
                cause: new Error('database is locked: /root/app.db'),
            }),
            new SettingsServiceError(SettingsErrorCode.NativeFailed, {
                cause: new Error('already registered'),
            }),
            new Error('settings owner went away'),
        ];

        for (const error of cases) {
            expect(describeSettingsFailure(error, '保存设置失败')).toBe('保存设置失败');
        }
    });
});
