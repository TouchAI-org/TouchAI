/**
 * 消息高度的粗略估算。
 *
 * 虚拟滚动对未测量条目只能用估算值。固定按 320px 估算时，一条几千像素的长回答
 * 会被严重低估，virtua 每次测量都会大幅补偿滚动位置，表现为滚动条来回跳。
 * 这里按文本量与部件数给一个量级正确的估算，把补偿幅度压到无害范围。
 */

import type { SessionMessage } from '@/types/session';

/** 正文每行大约容纳的全角字符数（窄窗口下偏保守）。 */
const CHARS_PER_LINE = 40;
/** 单行高度（正文 15px、行高 2.05 的近似值）。 */
const LINE_HEIGHT = 31;
/** 消息容器的固定开销（头像行、气泡内边距、操作条）。 */
const MESSAGE_CHROME = 72;
/** 单个非文本部件的平均高度（工具卡、审批卡、来源卡）。 */
const PART_HEIGHT = 96;
/** widget 高度差异极大，给一个偏大的常数，其余由测量修正。 */
const WIDGET_HEIGHT = 480;
const MIN_HEIGHT = 96;
const MAX_HEIGHT = 20000;

/** 把文本折算成等效字符数：中日韩字符按两格计。 */
function measureCharacters(text: string): number {
    let count = 0;
    for (const character of text) {
        count += character.charCodeAt(0) > 0x2e7f ? 2 : 1;
    }

    return count;
}

/**
 * 估算单条消息的渲染高度。
 *
 * @param message 会话消息。
 * @returns 估算像素高度。
 */
export function estimateMessageHeight(message: SessionMessage): number {
    let characters = measureCharacters(message.content ?? '');
    let parts = 0;
    let hasWidget = false;

    for (const part of message.parts ?? []) {
        if (part.type === 'text') {
            characters += measureCharacters(part.content ?? '');
            continue;
        }

        if (part.type === 'widget') {
            hasWidget = true;
            continue;
        }

        parts += 1;
    }

    const lines = Math.ceil(characters / CHARS_PER_LINE);
    const estimated =
        MESSAGE_CHROME +
        lines * LINE_HEIGHT +
        parts * PART_HEIGHT +
        (hasWidget ? WIDGET_HEIGHT : 0);

    return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, estimated));
}

/**
 * 为一组消息取一个代表值，作为虚拟滚动的条目高度提示。
 *
 * 用中位数而不是平均值：单条超长回答会把平均值拉得很高，反而让短消息的估算失真。
 *
 * @param messages 会话消息列表。
 * @returns 估算像素高度；列表为空时返回最小值。
 */
export function estimateMessageListItemSize(messages: readonly SessionMessage[]): number {
    if (messages.length === 0) {
        return MIN_HEIGHT;
    }

    const heights = messages.map(estimateMessageHeight).sort((left, right) => left - right);
    const middle = Math.floor(heights.length / 2);

    return heights[middle] ?? MIN_HEIGHT;
}
