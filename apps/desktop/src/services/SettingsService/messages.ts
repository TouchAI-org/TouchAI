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
    return tt('设置尚未就绪，暂时无法修改。');
}

export function ownerClosedMessage(): string {
    return tt('设置所有者已关闭。');
}

export function ownerUnavailableMessage(): string {
    return tt('设置所有者不可用。');
}

export function ownerChangedMessage(): string {
    return tt('设置结果未知：设置所有者已变化。');
}

export function writeTimeoutMessage(): string {
    return tt('设置结果未知：请求超时，请重新查看设置后再决定是否重试。');
}

export function staleOwnerResponseMessage(): string {
    return tt('设置结果未知：响应来自已失效的设置所有者。');
}

export function invalidResponseMessage(): string {
    return tt('设置结果未知：未收到有效响应。');
}

export function mutationFailedMessage(): string {
    return tt('设置修改失败。');
}

export function unknownKeyMessage(key: string): string {
    return tt('不支持的设置键：{key}', { key });
}

export function ownerQueueFullMessage(): string {
    return tt('设置修改队列已满，请稍后重试。');
}

export function nativeReconcilePendingMessage(): string {
    return tt('系统设置状态未确认，已暂停新的修改，请重新检查设置。');
}

export function invalidValueMessage(error: unknown): string {
    return tt('设置值无效：{error}', {
        error: error instanceof Error ? error.message : String(error),
    });
}

export function nativeFailedMessage(error: unknown): string {
    return tt('设置未生效：{error}', { error: String(error) });
}

export function persistenceUnconfirmedMessage(): string {
    return tt('设置结果未知：保存未确认，请重新查看设置。');
}

export function restoredMessage(): string {
    return tt('设置未保存，已恢复到执行前的值。');
}

export function compensationFailedMessage(): string {
    return tt('设置可能未保存，且无法确认系统状态，请重新检查设置。');
}

export function ownerChangedDuringWriteMessage(): string {
    return tt('设置结果未知：保存过程中设置所有者已变化。');
}

export function syncWarningMessage(): string {
    return tt('设置已保存，但同步到其他窗口失败。');
}

export function syncFailedMessage(): string {
    return tt('设置同步失败。');
}

export function snapshotFailedMessage(): string {
    return tt('设置同步失败：未收到有效快照。');
}

export function requestTimeoutMessage(): string {
    return tt('设置请求超时。');
}

export function tooManyPendingMessage(): string {
    return tt('设置请求过多，请稍后重试。');
}

export function syncTimeoutMessage(): string {
    return tt('设置同步超时。');
}

/**
 * Message for an owner-side failure reply. The reply keeps its stable error code; only the
 * human-readable text is chosen here so different failures are not all reported as
 * "owner unavailable".
 */
export function replyErrorMessage(code: string): string {
    switch (code) {
        case SettingsErrorCode.NotReady:
            return notReadyMessage();
        case SettingsErrorCode.StaleEpoch:
            return staleOwnerResponseMessage();
        case SettingsErrorCode.OwnerDisposed:
            return ownerClosedMessage();
        case SettingsErrorCode.TooManyPending:
            return tooManyPendingMessage();
        case SettingsErrorCode.Timeout:
            return requestTimeoutMessage();
        case SettingsErrorCode.OwnerUnavailable:
        default:
            return ownerUnavailableMessage();
    }
}
