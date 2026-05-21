import type { TextMessagePart } from '@/types/session';

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
