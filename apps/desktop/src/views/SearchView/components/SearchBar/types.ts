import type { AutocompleteCompletion } from './utils/autocomplete';

export interface SearchCursorContext {
    isMultiLine: boolean;
    cursorAtStart: boolean;
    cursorAtTextStart: boolean;
    cursorAtEnd: boolean;
}

export interface FilePickerContext {
    listId: string;
    activeItemId?: string;
    completion?: (AutocompleteCompletion & { query: string }) | null;
}

export interface SearchModelOverride {
    modelId: string | null;
    providerId: number | null;
}

export interface SearchModelDropdownState {
    isOpen: boolean;
}
