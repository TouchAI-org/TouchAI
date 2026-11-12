export interface ResultPanelState {
    kind: 'loading' | 'empty' | 'error';
    message: string;
}

export interface ResultPanelShortcut {
    keys: readonly string[];
    label: string;
    separator?: '/' | '+';
}
