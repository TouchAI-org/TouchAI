import { tt } from '@/i18n';
import type { ReasoningMessagePart, TextMessagePart } from '@/types/session';

export type SessionStatusReminderKind = 'completed' | 'failed' | 'waiting_approval';

export function createTextPart(content: string): TextMessagePart {
    return {
        id: crypto.randomUUID(),
        type: 'text',
        content,
    };
}

export function createReasoningPart(content: string): ReasoningMessagePart {
    return {
        id: crypto.randomUUID(),
        type: 'reasoning',
        content,
        startedAt: Date.now(),
    };
}

/**
 * 根据状态类型返回对应的本地化提醒文本。
 */
export function getSessionStatusReminderContent(status: SessionStatusReminderKind): string {
    switch (status) {
        case 'completed':
            return tt('任务已完成');
        case 'failed':
            return tt('任务失败');
        case 'waiting_approval':
            return tt('任务正在等待批准');
    }
}
