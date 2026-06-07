// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import {
    type AttachmentCapabilities,
    type AttachmentIndex,
    getUnsupportedAttachmentTypes,
} from '@/services/AttachmentService';

import type { AiContentPart, AiMessage } from '../contracts/protocol';
import { buildAttachmentParts } from '../infrastructure/attachments';
import { loadSessionTransportMessages } from '../session/transport';
import type { PromptSnapshot } from './types';

interface BuildPromptTransportMessagesOptions {
    sessionId?: number;
    snapshot: PromptSnapshot;
    attachments?: AttachmentIndex[];
    supportsAttachments?: boolean;
    attachmentCapabilities?: AttachmentCapabilities;
}

export type PromptAttachmentSlot =
    | {
          type: 'text';
          text: string;
      }
    | {
          type: 'attachment';
          attachment: AttachmentIndex;
      };

/**
 * 按草稿插入位置生成 prompt 文本和附件槽位。
 */
export function buildPromptAttachmentSlots(
    prompt: string,
    attachments: AttachmentIndex[]
): PromptAttachmentSlot[] {
    const slots: PromptAttachmentSlot[] = [];
    //1. 有 draftInsertionOffset 的附件按原 HTML 位置排序；普通附件仍落在 prompt 末尾。
    const orderedAttachments = attachments
        .map((attachment, order) => ({
            attachment,
            order,
            offset:
                typeof attachment.draftInsertionOffset === 'number'
                    ? Math.min(
                          prompt.length,
                          Math.max(0, Math.floor(attachment.draftInsertionOffset))
                      )
                    : prompt.length,
        }))
        .sort((left, right) => left.offset - right.offset || left.order - right.order);
    let cursor = 0;

    //2. 用 cursor 切分 prompt，生成 text/attachment/text 的模型输入顺序。
    for (const item of orderedAttachments) {
        if (item.offset > cursor) {
            slots.push({
                type: 'text',
                text: prompt.slice(cursor, item.offset),
            });
            cursor = item.offset;
        }

        slots.push({
            type: 'attachment',
            attachment: item.attachment,
        });
    }

    if (cursor < prompt.length) {
        slots.push({
            type: 'text',
            text: prompt.slice(cursor),
        });
    }

    return slots;
}

/**
 * 构建按草稿顺序交错排列的 prompt 内容。
 */
async function buildInterleavedPromptContent(
    prompt: string,
    attachments: AttachmentIndex[]
): Promise<AiContentPart[]> {
    const content: AiContentPart[] = [];

    for (const slot of buildPromptAttachmentSlots(prompt, attachments)) {
        if (slot.type === 'text') {
            if (slot.text) {
                content.push({ type: 'text', text: slot.text });
            }
            continue;
        }

        content.push(...(await buildAttachmentParts([slot.attachment])));
    }

    return content;
}

/**
 * 构建当前用户输入的传输消息。
 */
async function buildUserPromptMessage(options: {
    prompt: string;
    attachments?: AttachmentIndex[];
    supportsAttachments?: boolean;
    attachmentCapabilities?: AttachmentCapabilities;
}): Promise<AiMessage> {
    const attachmentCapabilities =
        options.attachmentCapabilities ??
        (() => {
            const supportsAttachments = options.supportsAttachments ?? true;
            return {
                supportsImages: supportsAttachments,
                supportsFiles: supportsAttachments,
            };
        })();
    const attachments = (options.attachments ?? []).filter(
        (attachment) =>
            getUnsupportedAttachmentTypes([attachment], attachmentCapabilities).length === 0
    );
    const hasDraftInsertionOffsets = attachments.some(
        (attachment) => typeof attachment.draftInsertionOffset === 'number'
    );
    const attachmentParts = hasDraftInsertionOffsets
        ? await buildInterleavedPromptContent(options.prompt, attachments)
        : await buildAttachmentParts(attachments);

    const hasText = options.prompt.trim().length > 0;
    const hasAttachments = attachmentParts.length > 0;

    let content: string | AiContentPart[];

    if (hasAttachments && !hasDraftInsertionOffsets) {
        if (hasText) {
            content = [
                { type: 'text', text: options.prompt },
                ...attachmentParts,
            ] as AiContentPart[];
        } else {
            content = attachmentParts;
        }
    } else if (hasAttachments) {
        content = attachmentParts;
    } else {
        content = options.prompt || 'no prompt';
    }

    return {
        role: 'user',
        content,
    };
}

/**
 * 将统一 prompt 快照映射成当前 provider 可消费的消息序列。
 *
 * 现在统一折叠为 `system + history + current user`，
 * 后续若 provider 支持更细的通道语义，只需改这里。
 */
export async function buildPromptTransportMessages(
    options: BuildPromptTransportMessagesOptions
): Promise<AiMessage[]> {
    const historyMessages = await loadSessionTransportMessages({
        sessionId: options.sessionId,
        supportsAttachments: options.supportsAttachments,
        attachmentCapabilities: options.attachmentCapabilities,
    });
    const messages: AiMessage[] = [];

    if (options.snapshot.systemPrompt) {
        messages.push({
            role: 'system',
            content: options.snapshot.systemPrompt,
        });
    }

    messages.push(...historyMessages);
    messages.push(
        await buildUserPromptMessage({
            prompt: options.snapshot.userPrompt,
            attachments: options.attachments,
            supportsAttachments: options.supportsAttachments,
            attachmentCapabilities: options.attachmentCapabilities,
        })
    );

    return messages;
}
