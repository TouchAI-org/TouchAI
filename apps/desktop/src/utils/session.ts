import type { TextMessagePart } from '@/types/session';

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

export function getSessionStatusReminderContent(status: SessionStatusReminderKind): string {
    switch (status) {
        case 'completed':
            return '任务已完成';
        case 'failed':
            return '任务失败';
        case 'waiting_approval':
            return '任务正在等待批准';
    }
}
