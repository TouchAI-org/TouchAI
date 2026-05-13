export interface SearchCursorContext {
    isMultiLine: boolean;
    cursorAtStart: boolean;
    cursorAtEnd: boolean;
}

export interface SearchModelOverride {
    modelId: string | null;
    providerId: number | null;
}

export interface SearchModelDropdownState {
    isOpen: boolean;
}
