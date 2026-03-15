export interface SearchCursorContext {
    isMultiLine: boolean;
    cursorAtStart: boolean;
}

export interface SearchModelOverride {
    modelId: string | null;
    providerId: number | null;
}

export interface SearchModelDropdownState {
    isOpen: boolean;
    query: string;
}
