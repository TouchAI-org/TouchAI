// Copyright (c) 2026. 千诚. Licensed under GPL v3

import type { SessionMessage } from '@/types/session';

/**
 * 消息列表的轻量 revision。
 *
 * 自动滚动只需要感知"列表末尾是否变化"：消息数量、尾消息的内容长度、
 * parts 数量与流式状态。用它替代全历史 deep watch，避免每逢流式快照
 * 触发对整段会话的深度遍历；更早消息的内容变化不影响是否跟随输出
 * （高度变化仍由 ResizeObserver 处理）。
 */
export function buildMessageListRevision(messages: readonly SessionMessage[]): string {
    const tail = messages[messages.length - 1];
    if (!tail) {
        return '0';
    }

    return [
        messages.length,
        tail.id,
        tail.content.length,
        tail.reasoning?.length ?? 0,
        tail.parts.length,
        tail.statusText?.length ?? 0,
        tail.isStreaming ? 1 : 0,
    ].join(':');
}
