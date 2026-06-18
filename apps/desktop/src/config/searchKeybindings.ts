import type { MessageKey } from '@/i18n';
import {
    hasCommandModifier,
    isModifierlessFunctionShortcut,
    isReservedGlobalShortcut,
    isReservedLocalShortcut,
    normalizeLocalShortcutString,
} from '@/utils/shortcuts';

export const SEARCH_KEYBINDING_ACTION_IDS = [
    'search.history.open',
    'search.input.focus',
    'search.session.new',
    'search.session.reopenLastClosed',
    'search.model.toggle',
    'search.quickSearch.toggleView',
    'search.window.pin',
    'search.window.maximize',
    'search.settings.open',
] as const;

export type SearchKeybindingActionId = (typeof SEARCH_KEYBINDING_ACTION_IDS)[number];

export interface SearchKeybindingDefinition {
    id: SearchKeybindingActionId;
    labelKey: MessageKey;
    descriptionKey: MessageKey;
    defaultShortcut: string | null;
    allowDisable: boolean;
    allowModifierlessFunctionShortcut: boolean;
}

export type SearchKeybindings = Record<SearchKeybindingActionId, string | null>;

export const SEARCH_KEYBINDING_DEFINITIONS: SearchKeybindingDefinition[] = [
    {
        id: 'search.history.open',
        labelKey: 'settings.general.searchActions.history',
        descriptionKey: 'settings.general.searchActionDescriptions.history',
        defaultShortcut: 'Mod+H',
        allowDisable: true,
        allowModifierlessFunctionShortcut: true,
    },
    {
        id: 'search.input.focus',
        labelKey: 'settings.general.searchActions.focusInput',
        descriptionKey: 'settings.general.searchActionDescriptions.focusInput',
        defaultShortcut: 'Mod+L',
        allowDisable: true,
        allowModifierlessFunctionShortcut: true,
    },
    {
        id: 'search.session.new',
        labelKey: 'settings.general.searchActions.newSession',
        descriptionKey: 'settings.general.searchActionDescriptions.newSession',
        defaultShortcut: 'Mod+N',
        allowDisable: true,
        allowModifierlessFunctionShortcut: true,
    },
    {
        id: 'search.session.reopenLastClosed',
        labelKey: 'settings.general.searchActions.reopenLastClosedSession',
        descriptionKey: 'settings.general.searchActionDescriptions.reopenLastClosedSession',
        defaultShortcut: 'Mod+Shift+T',
        allowDisable: true,
        allowModifierlessFunctionShortcut: true,
    },
    {
        id: 'search.model.toggle',
        labelKey: 'settings.general.searchActions.modelToggle',
        descriptionKey: 'settings.general.searchActionDescriptions.modelToggle',
        defaultShortcut: 'Mod+M',
        allowDisable: true,
        allowModifierlessFunctionShortcut: true,
    },
    {
        id: 'search.quickSearch.toggleView',
        labelKey: 'settings.general.searchActions.quickSearchToggleView',
        descriptionKey: 'settings.general.searchActionDescriptions.quickSearchToggleView',
        defaultShortcut: 'Mod+G',
        allowDisable: true,
        allowModifierlessFunctionShortcut: true,
    },
    {
        id: 'search.window.pin',
        labelKey: 'settings.general.searchActions.windowPin',
        descriptionKey: 'settings.general.searchActionDescriptions.windowPin',
        defaultShortcut: 'Mod+P',
        allowDisable: true,
        allowModifierlessFunctionShortcut: true,
    },
    {
        id: 'search.window.maximize',
        labelKey: 'settings.general.searchActions.windowMaximize',
        descriptionKey: 'settings.general.searchActionDescriptions.windowMaximize',
        defaultShortcut: 'F11',
        allowDisable: true,
        allowModifierlessFunctionShortcut: true,
    },
    {
        id: 'search.settings.open',
        labelKey: 'settings.general.searchActions.openSettings',
        descriptionKey: 'settings.general.searchActionDescriptions.openSettings',
        defaultShortcut: 'Mod+,',
        allowDisable: true,
        allowModifierlessFunctionShortcut: false,
    },
];

const SEARCH_KEYBINDING_DEFINITION_MAP = new Map(
    SEARCH_KEYBINDING_DEFINITIONS.map((definition) => [definition.id, definition])
);

const SEARCH_KEYBINDING_ACTION_ID_SET = new Set<string>(SEARCH_KEYBINDING_ACTION_IDS);

export function isSearchKeybindingActionId(value: string): value is SearchKeybindingActionId {
    return SEARCH_KEYBINDING_ACTION_ID_SET.has(value);
}

export function getSearchKeybindingDefinition(
    actionId: SearchKeybindingActionId
): SearchKeybindingDefinition {
    const definition = SEARCH_KEYBINDING_DEFINITION_MAP.get(actionId);
    if (!definition) {
        throw new Error(`Unknown search keybinding action: ${actionId}`);
    }
    return definition;
}

export function createDefaultSearchKeybindings(): SearchKeybindings {
    return SEARCH_KEYBINDING_DEFINITIONS.reduce<SearchKeybindings>((accumulator, definition) => {
        accumulator[definition.id] = definition.defaultShortcut;
        return accumulator;
    }, {} as SearchKeybindings);
}

export function normalizeSearchKeybindings(value: unknown): SearchKeybindings {
    const defaults = createDefaultSearchKeybindings();
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return defaults;
    }

    const candidates = value as Record<string, unknown>;
    const resolved = new Map<
        SearchKeybindingActionId,
        { shortcut: string | null; isPersisted: boolean }
    >();

    for (const definition of SEARCH_KEYBINDING_DEFINITIONS) {
        const candidate = candidates[definition.id];

        if (candidate === null && definition.allowDisable) {
            resolved.set(definition.id, { shortcut: null, isPersisted: true });
            continue;
        }

        if (typeof candidate === 'string') {
            const shortcut = normalizeLocalShortcutString(candidate);
            if (shortcut) {
                const allowsModifierlessFunction =
                    definition.allowModifierlessFunctionShortcut &&
                    isModifierlessFunctionShortcut(shortcut);
                const passesModifierPolicy =
                    hasCommandModifier(shortcut) || allowsModifierlessFunction;
                if (
                    passesModifierPolicy &&
                    !isReservedLocalShortcut(shortcut) &&
                    !isReservedGlobalShortcut(shortcut)
                ) {
                    resolved.set(definition.id, { shortcut, isPersisted: true });
                    continue;
                }
            }
        }

        resolved.set(definition.id, {
            shortcut: defaults[definition.id],
            isPersisted: false,
        });
    }

    const result = createDefaultSearchKeybindings();
    const assignedActionIds = new Set<SearchKeybindingActionId>();
    const usedShortcuts = new Set<string>();

    function assignShortcut(
        definition: SearchKeybindingDefinition,
        desired: string | null,
        fallbackOnConflict = true
    ) {
        if (desired === null) {
            result[definition.id] = null;
            assignedActionIds.add(definition.id);
            return true;
        }

        if (!usedShortcuts.has(desired)) {
            usedShortcuts.add(desired);
            result[definition.id] = desired;
            assignedActionIds.add(definition.id);
            return true;
        }

        if (!fallbackOnConflict) {
            return false;
        }

        const fallback = normalizeLocalShortcutString(definition.defaultShortcut);
        if (fallback && !usedShortcuts.has(fallback)) {
            usedShortcuts.add(fallback);
            result[definition.id] = fallback;
        } else {
            result[definition.id] = null;
        }
        assignedActionIds.add(definition.id);
        return true;
    }

    for (const definition of SEARCH_KEYBINDING_DEFINITIONS) {
        const resolvedShortcut = resolved.get(definition.id);
        if (!resolvedShortcut?.isPersisted) {
            continue;
        }

        assignShortcut(definition, resolvedShortcut.shortcut, false);
    }

    for (const definition of SEARCH_KEYBINDING_DEFINITIONS) {
        if (assignedActionIds.has(definition.id)) {
            continue;
        }

        assignShortcut(definition, defaults[definition.id]);
    }

    return result;
}
