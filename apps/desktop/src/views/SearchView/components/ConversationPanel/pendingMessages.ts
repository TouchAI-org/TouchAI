import type { PendingUserMessage } from '@/services/AgentService/task/types';
import type { SessionMessage } from '@/types/session';

/**
 * 待发消息是运行中的临时状态，只在会话尾部显示。
 * 交付后由投影层用同一个 id 生成正式的 user 消息，因此这里保持 id 一致，
 * 让待发气泡和实心气泡在投递瞬间原位替换，而不是多出一条重复消息。
 */
export function toPendingSessionMessage(message: PendingUserMessage): SessionMessage {
    return {
        id: message.id,
        role: 'user',
        content: message.prompt,
        attachments: message.attachments.length
            ? message.attachments.map((attachment) => ({ ...attachment }))
            : undefined,
        inputSnapshot: message.inputSnapshot,
        parts: [],
        timestamp: message.createdAt,
        pendingDelivery: message.delivery,
    };
}

/**
 * Build the conversation tail shown by the panel.
 *
 * Persisted history, including the streaming assistant reply and its loading
 * row, comes first. Pending steer messages follow it: they are already
 * committed to the steer channel but not yet sent, so they sit below the
 * loading row until the tool boundary moves them into history, which flips the
 * loading row below them. Queued messages always stay at the very bottom
 * because they wait for the next turn.
 */
export function buildConversationDisplayMessages(
    messages: SessionMessage[],
    pendingMessages: PendingUserMessage[] = []
): SessionMessage[] {
    if (pendingMessages.length === 0) {
        return messages;
    }

    const steered = pendingMessages.filter((message) => message.delivery === 'priority');
    const queued = pendingMessages.filter((message) => message.delivery === 'queue');
    return [
        ...messages,
        ...steered.map(toPendingSessionMessage),
        ...queued.map(toPendingSessionMessage),
    ];
}
