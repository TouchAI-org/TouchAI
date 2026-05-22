import type { SessionMessage, TextMessagePart } from '@/types/session';

export type SessionStatusReminderKind = 'completed' | 'failed' | 'waiting_approval';

/**
 * 创建带唯一 ID 的文本消息片段。
 */
export function createTextPart(content: string): TextMessagePart {
    return {
        id: crypto.randomUUID(),
        type: 'text',
        content,
    };
}

export function createSystemMessage(
    content: string,
    options: {
        id?: string;
        timestamp?: number;
    } = {}
): SessionMessage {
    return {
        id: options.id ?? crypto.randomUUID(),
        role: 'system',
        content,
        parts: [createTextPart(content)],
        timestamp: options.timestamp ?? Date.now(),
    };
}

export function getSessionStatusReminderContent(
    status: SessionStatusReminderKind,
    options: {
        errorMessage?: string | null;
    } = {}
): string {
    switch (status) {
        case 'completed':
            return '任务已完成';
        case 'failed':
            return options.errorMessage?.trim() ? `任务失败：${options.errorMessage}` : '任务失败';
        case 'waiting_approval':
            return '任务正在等待批准';
    }
}

export function getSessionStatusReminderKindFromContent(
    content: string
): SessionStatusReminderKind | null {
    const normalized = content.trim();

    if (normalized === getSessionStatusReminderContent('completed')) {
        return 'completed';
    }

    if (normalized === getSessionStatusReminderContent('waiting_approval')) {
        return 'waiting_approval';
    }

    if (
        normalized === getSessionStatusReminderContent('failed') ||
        normalized.startsWith(`${getSessionStatusReminderContent('failed')}：`)
    ) {
        return 'failed';
    }

    return null;
}

export function isSessionStatusReminderMessage(
    message: Pick<SessionMessage, 'role' | 'content'>
): boolean {
    return (
        message.role === 'system' &&
        getSessionStatusReminderKindFromContent(message.content) !== null
    );
}
