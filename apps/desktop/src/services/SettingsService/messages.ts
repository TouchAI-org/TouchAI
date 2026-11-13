// Copyright (c) 2026. 千诚. Licensed under GPL v3
//
// Presentation-only copy for settings rejections that the user can correct. Internal
// owner/transport/database failure codes deliberately do not live here: those details are
// diagnostics, not user-facing copy.

import { t, tt } from '@/i18n';
import type { MessageKey } from '@/i18n/messages';

import type { SettingsRejectionDescriptor } from './policy';
import { SettingsServiceError } from './types';

export function describeRejection(rejection: SettingsRejectionDescriptor): string {
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

export function unconfirmedMessage(): string {
    return tt('设置结果未确认，请重新查看设置后再重试。');
}

/**
 * Copy for a failed user-initiated change. Only a domain rejection the user can act on
 * gets specific text; any internal failure (owner, transport, native, persistence) falls
 * back to the caller's generic, localized message and leaves its cause in the log.
 */
export function describeSettingsFailure(error: unknown, fallback: string): string {
    return error instanceof SettingsServiceError && error.rejection
        ? describeRejection(error.rejection)
        : fallback;
}
