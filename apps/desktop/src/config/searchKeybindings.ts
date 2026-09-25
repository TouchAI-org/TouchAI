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
    allowModifierlessFunctionShortcut: boolean;
}

export type SearchKeybindings = Record<SearchKeybindingActionId, string | null>;

export const SEARCH_KEYBINDING_DEFINITIONS: SearchKeybindingDefinition[] = [
    {
        id: 'search.history.open',
        labelKey: 'settings.general.searchActions.history',
        descriptionKey: 'settings.general.searchActionDescriptions.history',
        defaultShortcut: 'Mod+H',
        allowModifierlessFunctionShortcut: true,
    },
    {
        id: 'search.input.focus',
        labelKey: 'settings.general.searchActions.focusInput',
        descriptionKey: 'settings.general.searchActionDescriptions.focusInput',
        defaultShortcut: 'Mod+L',
        allowModifierlessFunctionShortcut: true,
    },
    {
        id: 'search.session.new',
        labelKey: 'settings.general.searchActions.newSession',
        descriptionKey: 'settings.general.searchActionDescriptions.newSession',
        defaultShortcut: 'Mod+N',
        allowModifierlessFunctionShortcut: true,
    },
    {
        id: 'search.session.reopenLastClosed',
        labelKey: 'settings.general.searchActions.reopenLastClosedSession',
        descriptionKey: 'settings.general.searchActionDescriptions.reopenLastClosedSession',
        defaultShortcut: 'Mod+Shift+T',
        allowModifierlessFunctionShortcut: true,
    },
    {
        id: 'search.model.toggle',
        labelKey: 'settings.general.searchActions.modelToggle',
        descriptionKey: 'settings.general.searchActionDescriptions.modelToggle',
        defaultShortcut: 'Mod+M',
        allowModifierlessFunctionShortcut: true,
    },
    {
        id: 'search.quickSearch.toggleView',
        labelKey: 'settings.general.searchActions.quickSearchToggleView',
        descriptionKey: 'settings.general.searchActionDescriptions.quickSearchToggleView',
        defaultShortcut: 'Mod+G',
        allowModifierlessFunctionShortcut: true,
    },
    {
        id: 'search.window.pin',
        labelKey: 'settings.general.searchActions.windowPin',
        descriptionKey: 'settings.general.searchActionDescriptions.windowPin',
        defaultShortcut: 'Mod+P',
        allowModifierlessFunctionShortcut: true,
    },
    {
        id: 'search.window.maximize',
        labelKey: 'settings.general.searchActions.windowMaximize',
        descriptionKey: 'settings.general.searchActionDescriptions.windowMaximize',
        defaultShortcut: 'F11',
        allowModifierlessFunctionShortcut: true,
    },
    {
        id: 'search.settings.open',
        labelKey: 'settings.general.searchActions.openSettings',
        descriptionKey: 'settings.general.searchActionDescriptions.openSettings',
        defaultShortcut: 'Mod+,',
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
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return createDefaultSearchKeybindings();
    }

    const candidates = value as Record<string, unknown>;
    const result = createDefaultSearchKeybindings();
    const assignedActionIds = new Set<SearchKeybindingActionId>();
    const usedShortcuts = new Set<string>();

    for (const definition of SEARCH_KEYBINDING_DEFINITIONS) {
        const candidate = candidates[definition.id];
        if (candidate === null) {
            result[definition.id] = null;
            assignedActionIds.add(definition.id);
            continue;
        }
        if (typeof candidate !== 'string') {
            continue;
        }

        const shortcut = normalizeLocalShortcutString(candidate);
        if (
            shortcut &&
            (hasCommandModifier(shortcut) ||
                (definition.allowModifierlessFunctionShortcut &&
                    isModifierlessFunctionShortcut(shortcut))) &&
            !isReservedLocalShortcut(shortcut) &&
            !isReservedGlobalShortcut(shortcut) &&
            !usedShortcuts.has(shortcut)
        ) {
            result[definition.id] = shortcut;
            assignedActionIds.add(definition.id);
            usedShortcuts.add(shortcut);
        }
    }

    for (const definition of SEARCH_KEYBINDING_DEFINITIONS) {
        if (assignedActionIds.has(definition.id)) {
            continue;
        }
        const shortcut = normalizeLocalShortcutString(definition.defaultShortcut);
        result[definition.id] = shortcut && !usedShortcuts.has(shortcut) ? shortcut : null;
        if (result[definition.id]) {
            usedShortcuts.add(shortcut!);
        }
    }

    return result;
}
