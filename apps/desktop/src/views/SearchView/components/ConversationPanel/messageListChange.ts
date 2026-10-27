// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * 消息列表变更类型。
 *
 * 区分「尾部追加」与「顶部插入历史」很关键：两者都会让列表变长，
 * 但只有尾部追加代表新一轮用户提问。把前置插入误当成追加，
 * 会把刚上滚的视图重新拉到最底部。
 */
export type MessageListChangeKind = 'none' | 'clear' | 'append' | 'prepend' | 'replace';

function sameIds(
    previousIds: readonly string[],
    nextIds: readonly string[],
    start: number
): boolean {
    for (let index = 0; index < previousIds.length; index += 1) {
        if (previousIds[index] !== nextIds[start + index]) {
            return false;
        }
    }

    return true;
}

/**
 * 判断消息列表本次变更属于追加、前置插入、整体替换还是清空。
 *
 * @param previousIds 变更前的消息 id 序列。
 * @param nextIds 变更后的消息 id 序列。
 * @returns 变更类型。
 */
export function classifyMessageListChange(
    previousIds: readonly string[],
    nextIds: readonly string[]
): MessageListChangeKind {
    if (nextIds.length === 0) {
        return previousIds.length > 0 ? 'clear' : 'none';
    }

    if (previousIds.length === 0) {
        return 'replace';
    }

    if (nextIds.length === previousIds.length) {
        return sameIds(previousIds, nextIds, 0) ? 'none' : 'replace';
    }

    if (nextIds.length < previousIds.length) {
        return 'replace';
    }

    if (sameIds(previousIds, nextIds, 0)) {
        return 'append';
    }

    if (sameIds(previousIds, nextIds, nextIds.length - previousIds.length)) {
        return 'prepend';
    }

    return 'replace';
}
