import type { MessageKey } from '@/i18n';
import { normalizeLocalShortcutString } from '@/utils/shortcuts';

export const SEARCH_KEYBINDING_ACTION_IDS = [
    'search.history.open',
    'search.input.focus',
    'search.session.new',
    'search.model.toggle',
    'search.window.pin',
    'search.window.maximize',
    'search.request.cancel',
    'search.draft.clearAll',
] as const;

export type SearchKeybindingActionId = (typeof SEARCH_KEYBINDING_ACTION_IDS)[number];

export interface SearchKeybindingDefinition {
    id: SearchKeybindingActionId;
    labelKey: MessageKey;
    defaultShortcut: string | null;
    allowDisable: boolean;
    allowModifierlessFunctionKey?: boolean;
}

export type SearchKeybindings = Record<SearchKeybindingActionId, string | null>;

export const SEARCH_KEYBINDING_DEFINITIONS: SearchKeybindingDefinition[] = [
    {
        id: 'search.history.open',
        labelKey: 'settings.general.searchActions.history',
        defaultShortcut: 'Mod+H',
        allowDisable: true,
    },
    {
        id: 'search.input.focus',
        labelKey: 'settings.general.searchActions.focusInput',
        defaultShortcut: 'Mod+L',
        allowDisable: true,
    },
    {
        id: 'search.session.new',
        labelKey: 'settings.general.searchActions.newSession',
        defaultShortcut: 'Mod+N',
        allowDisable: true,
    },
    {
        id: 'search.model.toggle',
        labelKey: 'settings.general.searchActions.modelToggle',
        defaultShortcut: 'Mod+M',
        allowDisable: true,
    },
    {
        id: 'search.window.pin',
        labelKey: 'settings.general.searchActions.windowPin',
        defaultShortcut: 'Mod+P',
        allowDisable: true,
    },
    {
        id: 'search.window.maximize',
        labelKey: 'settings.general.searchActions.windowMaximize',
        defaultShortcut: 'F11',
        allowDisable: true,
        allowModifierlessFunctionKey: true,
    },
    {
        id: 'search.request.cancel',
        labelKey: 'settings.general.searchActions.cancelRequest',
        defaultShortcut: 'Mod+.',
        allowDisable: true,
    },
    {
        id: 'search.draft.clearAll',
        labelKey: 'settings.general.searchActions.clearAll',
        defaultShortcut: 'Mod+Backspace',
        allowDisable: true,
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
    const normalized = createDefaultSearchKeybindings();
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return normalized;
    }

    for (const definition of SEARCH_KEYBINDING_DEFINITIONS) {
        const candidate = (value as Record<string, unknown>)[definition.id];
        if (candidate === null && definition.allowDisable) {
            normalized[definition.id] = null;
            continue;
        }

        if (typeof candidate !== 'string') {
            continue;
        }

        const shortcut = normalizeLocalShortcutString(candidate);
        if (shortcut) {
            normalized[definition.id] = shortcut;
        }
    }

    return normalized;
}
