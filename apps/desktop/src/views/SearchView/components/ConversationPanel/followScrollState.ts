// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * 会话自动跟随判定。
 *
 * 关键约束：**只有用户自己的滚动意图**才能改变跟随状态。
 *
 * 原因：长会话会窗口化，spacer 增删、高度测量补偿、自动跟随本身都会程序性改写
 * `scrollTop`；如果按“当前是否在底部”直接重开跟随，用户上滚后只要布局抖一下就会
 * 被判成回到底部，输出又开始自动往下走。
 */

export interface FollowScrollInput {
    /** 输出滚动行为：跟随输出 / 保持位置 / 跳转到顶部。 */
    mode: 'follow_output' | 'stay_position' | 'jump_to_top';
    /** 当前是否处于底部。 */
    atBottom: boolean;
    /** 内容是否超出容器。 */
    hasScrollbar: boolean;
    /** 本次滚动是否向上。 */
    scrolledUp: boolean;
    /** 本次滚动是否由程序（自动跟随、锚点补偿、时间轴跳转）发起。 */
    isProgrammatic: boolean;
    /** 用户最近的滚轮/拖拽/键盘意图。 */
    hasRecentUserIntent: boolean;
    /** 当前是否处于跟随状态。 */
    isFollowing: boolean;
}

export interface FollowScrollResult {
    isFollowing: boolean;
    showScrollToBottom: boolean;
}

export function resolveFollowScrollState(input: FollowScrollInput): FollowScrollResult {
    if (input.mode !== 'follow_output') {
        return {
            isFollowing: false,
            showScrollToBottom: input.hasScrollbar && !input.atBottom,
        };
    }

    if (input.atBottom) {
        return {
            // 程序性滚动（含跟随自身）不改变开关；只有用户意图才重开。
            isFollowing: input.isFollowing || (!input.isProgrammatic && input.hasRecentUserIntent),
            showScrollToBottom: false,
        };
    }

    if (!input.hasScrollbar) {
        return { isFollowing: input.isFollowing, showScrollToBottom: false };
    }

    if (input.scrolledUp && !input.isProgrammatic && input.hasRecentUserIntent) {
        return { isFollowing: false, showScrollToBottom: true };
    }

    return {
        isFollowing: input.isFollowing,
        showScrollToBottom: !input.isFollowing,
    };
}
