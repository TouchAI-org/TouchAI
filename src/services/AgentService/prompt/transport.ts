// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { AttachmentIndex } from '@/services/AgentService/infrastructure/attachments';

import type { AiContentPart, AiMessage } from '../contracts/protocol';
import { buildAttachmentParts } from '../infrastructure/attachments';
import { loadSessionTransportMessages } from '../session/transport';
import type { PromptSnapshot } from './types';

interface BuildPromptTransportMessagesOptions {
    sessionId?: number;
    snapshot: PromptSnapshot;
    attachments?: AttachmentIndex[];
    supportsAttachments?: boolean;
}

async function buildUserPromptMessage(options: {
    prompt: string;
    attachments?: AttachmentIndex[];
    supportsAttachments?: boolean;
}): Promise<AiMessage> {
    const supportsAttachments = options.supportsAttachments ?? true;
    const attachmentParts = supportsAttachments
        ? await buildAttachmentParts(options.attachments ?? [])
        : [];

    return {
        role: 'user',
        content:
            attachmentParts.length > 0
                ? ([{ type: 'text', text: options.prompt }, ...attachmentParts] as AiContentPart[])
                : options.prompt,
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
        })
    );

    return messages;
}
