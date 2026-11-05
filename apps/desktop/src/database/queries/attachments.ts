// Copyright (c) 2026. 千诚. Licensed under GPL v3

import type { AttachmentEntity } from '../types';

export interface MessageAttachmentRow extends AttachmentEntity {
    message_id: number;
    sort_order: number;
    /** 工具结果附件会带上所属工具调用；用户附件为 null。 */
    tool_call_id: string | null;
    tool_kind: string | null;
}
