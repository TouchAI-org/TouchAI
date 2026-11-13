// Copyright (c) 2026. 千诚. Licensed under GPL v3
//
// Pure settings policy: shortcut reservation and cross-key conflict rules. It carries only
// stable rejection kinds (and a message-key reference), never localized text or a Vue/runtime
// import, so it can be reasoned about and tested without the i18n or UI layers. The service
// adapter (messages.ts) turns a rejection into user-facing text.

import {
    getSearchKeybindingDefinition,
    SEARCH_KEYBINDING_DEFINITIONS,
    type SearchKeybindingActionId,
    type SearchKeybindings,
} from '@/config/searchKeybindings';
import type { MessageKey } from '@/i18n/messages';
import {
    findShortcutConflict,
    isReservedGlobalShortcut,
    normalizeLocalShortcutString,
} from '@/utils/shortcuts';

import type { GeneralSettingsData } from './domain';

export type SettingsRejectionKind =
    | 'shortcut-reserved'
    | 'shortcut-conflict'
    | 'shortcut-global-conflict';

export interface SettingsRejectionDescriptor {
    kind: SettingsRejectionKind;
    actionLabelKey?: MessageKey;
}

export class SettingsRejection extends Error {
    readonly kind: SettingsRejectionKind;
    readonly actionLabelKey?: MessageKey;

    constructor(kind: SettingsRejectionKind, actionLabelKey?: MessageKey) {
        super(kind);
        this.name = 'SettingsRejection';
        this.kind = kind;
        this.actionLabelKey = actionLabelKey;
    }

    toDescriptor(): SettingsRejectionDescriptor {
        return this.actionLabelKey
            ? { kind: this.kind, actionLabelKey: this.actionLabelKey }
            : { kind: this.kind };
    }
}

function entries(
    keybindings: SearchKeybindings
): Array<{ id: SearchKeybindingActionId; shortcut: string | null }> {
    return SEARCH_KEYBINDING_DEFINITIONS.map((definition) => ({
        id: definition.id,
        shortcut: keybindings[definition.id] ?? null,
    }));
}

/**
 * Global shortcut validation against the latest committed state: it must not be a
 * system-reserved combination and must not collide with any configured search shortcut.
 */
export function validateGlobalShortcut(shortcut: string, committed: GeneralSettingsData): void {
    if (isReservedGlobalShortcut(shortcut)) {
        throw new SettingsRejection('shortcut-reserved');
    }

    const conflictActionId = findShortcutConflict(shortcut, entries(committed.searchKeybindings));
    if (conflictActionId) {
        throw new SettingsRejection(
            'shortcut-conflict',
            getSearchKeybindingDefinition(conflictActionId).labelKey
        );
    }
}

/**
 * Search keybinding validation against the latest committed state: no two actions may
 * share a shortcut and none may collide with the global shortcut.
 */
export function validateSearchKeybindings(
    next: SearchKeybindings,
    committed: GeneralSettingsData
): void {
    const seen = new Map<string, SearchKeybindingActionId>();
    for (const definition of SEARCH_KEYBINDING_DEFINITIONS) {
        const normalized = normalizeLocalShortcutString(next[definition.id]);
        if (!normalized) {
            continue;
        }

        const duplicate = seen.get(normalized);
        if (duplicate) {
            throw new SettingsRejection(
                'shortcut-conflict',
                getSearchKeybindingDefinition(duplicate).labelKey
            );
        }
        seen.set(normalized, definition.id);
    }

    const normalizedGlobal = normalizeLocalShortcutString(committed.globalShortcut);
    if (normalizedGlobal && seen.has(normalizedGlobal)) {
        throw new SettingsRejection('shortcut-global-conflict');
    }
}
