import { tt } from '@/i18n';
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
