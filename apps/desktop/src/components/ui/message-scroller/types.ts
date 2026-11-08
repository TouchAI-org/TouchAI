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
    /** 滚动视口元素；虚拟列表需要它作为 `scrollRef`。 */
    getViewportElement: () => HTMLElement | null;
    getState: () => MessageScrollerState;
    getContentHeight: () => number;
    isAtEnd: () => boolean;
    recalculate: () => void;
    scrollBy: (deltaY: number) => void;
    scrollToEnd: (behavior?: MessageScrollerScrollBehavior) => void;
    scrollToItem: (id: string, options?: MessageScrollerScrollOptions) => boolean;
    /** 显式设置跟随意图；跳转离开实时边缘时必须关掉，否则 resize 自动贴底会把视图拽走。 */
    setFollowing: (following: boolean) => void;
}
