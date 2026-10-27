// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * 未挂载消息的高度估算。
 *
 * 窗口化只测量视口附近的项，未挂载项用估算值参与累计高度：
 * 估算太粗会让滚动条长度明显失真。这里按文本量做线性估算，
 * 让长会话在尚未滚过的区域也有接近真实的滚动条。
 */

import type { SessionMessage } from '@/types/session';

/** 单行正文的估算高度（含行距）。 */
const LINE_HEIGHT = 24;
/** 一行的估算字符数（中文按等宽近似，中文占两格）。 */
const CHARS_PER_LINE = 56;
/** 消息容器的基础高度（头像、间距、元信息）。 */
const BASE_HEIGHT = 56;
const MIN_HEIGHT = 64;
const MAX_HEIGHT = 2400;
/** 部件高度差异太大，统一给一个偏大的估值，由测量修正。 */
const WIDGET_HEIGHT = 360;

/** 把文本折算成等效宽度字符数：中文/全角按 2 计。 */
function measureCharacters(text: string): number {
    let count = 0;
    for (const character of text) {
        count += character.charCodeAt(0) > 0x2e7f ? 2 : 1;
    }

    return count;
}

/**
 * 估算一条消息的渲染高度。
 *
 * @param message 会话消息。
 * @returns 估算像素高度。
 */
export function estimateMessageHeight(message: SessionMessage): number {
    let characters = measureCharacters(message.content ?? '');

    for (const part of message.parts ?? []) {
        if (part.type === 'widget') {
            return WIDGET_HEIGHT;
        }

        if (part.type === 'text') {
            characters += measureCharacters(part.content ?? '');
        }
    }

    const lines = Math.max(1, Math.ceil(characters / CHARS_PER_LINE));
    const estimated = BASE_HEIGHT + lines * LINE_HEIGHT;

    return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, estimated));
}
