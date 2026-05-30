// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { tt } from '@/i18n';
import { collapseWhitespace, truncateText } from '@/utils/text';

/**
 * 根据用户输入生成会话标题。
 */
export function buildSessionTitle(prompt: string): string {
    const normalized = collapseWhitespace(prompt);
    if (!normalized) {
        return tt('新会话');
    }

    return truncateText(normalized, 40);
}
