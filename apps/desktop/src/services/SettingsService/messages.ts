// Copyright (c) 2026. 千诚. Licensed under GPL v3
//
// i18n adapter for the settings service. Keeps localization (Vue-backed i18n) out of the
// pure policy/domain modules; the service asks this module for user-facing text.

import { t, tt } from '@/i18n';
import type { MessageKey } from '@/i18n/messages';

import type { SettingsRejection } from './policy';
import { SettingsErrorCode } from './types';

export function formatShortcutRegistrationError(shortcut: string, error: unknown): string {
    const errorText = String(error);
    if (errorText.includes('already registered') || errorText.includes('已注册')) {
        return tt('快捷键 {shortcut} 已被其他应用占用。', { shortcut });
    }
    if (errorText.includes('invalid') || errorText.includes('无效')) {
        return tt('快捷键 {shortcut} 格式无效。', { shortcut });
    }
    if (errorText.includes('Unknown key')) {
        return tt('快捷键包含不支持的按键。');
    }
    return tt('注册快捷键失败：{error}', { error: errorText });
}

export function describeRejection(rejection: SettingsRejection): string {
    switch (rejection.kind) {
        case 'shortcut-reserved':
            return t('settings.general.globalShortcutReservedOnMac');
        case 'shortcut-conflict':
            return t('settings.general.searchShortcuts.errors.duplicate', {
                action: t((rejection.actionLabelKey ?? 'common.default') as MessageKey),
            });
        case 'shortcut-global-conflict':
            return t('settings.general.searchShortcuts.errors.globalConflict');
    }
}

export function notReadyMessage(): string {
    return tt('设置尚未就绪，请稍后再试。');
}

export function unconfirmedMessage(): string {
    return tt('设置结果未确认，请重新查看设置后再重试。');
}

export function mutationFailedMessage(): string {
    return tt('设置修改失败。');
}

export function syncWarningMessage(): string {
    return tt('设置已保存，但同步到其他窗口失败。');
}

/**
 * Message for an owner-side failure reply. Keep the stable code for diagnostics and use
 * only the small set of user-facing messages the caller actually needs.
 */
export function replyErrorMessage(code: string): string {
    return code === SettingsErrorCode.NotReady ? notReadyMessage() : mutationFailedMessage();
}
