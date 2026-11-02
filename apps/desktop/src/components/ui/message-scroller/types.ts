export interface MessageScrollerItem {
    id: string;
    label: string;
    description?: string;
    role?: string;
    ariaLabel?: string;
}

export interface MessageScrollerState {
    atEnd: boolean;
    overflowing: boolean;
    following: boolean;
    scrollTop: number;
    scrollHeight: number;
    clientHeight: number;
}

export type MessageScrollerAlignment = 'start' | 'center' | 'end';
export type MessageScrollerScrollBehavior = 'auto' | 'smooth';

export interface MessageScrollerScrollOptions {
    align?: MessageScrollerAlignment;
    offset?: number;
    behavior?: MessageScrollerScrollBehavior;
}

export interface MessageScrollerHandle {
    focus: () => void;
    getState: () => MessageScrollerState;
    isAtEnd: () => boolean;
    recalculate: () => void;
    scrollBy: (deltaY: number) => void;
    scrollToEnd: (behavior?: MessageScrollerScrollBehavior) => void;
    scrollToItem: (id: string, options?: MessageScrollerScrollOptions) => boolean;
}
