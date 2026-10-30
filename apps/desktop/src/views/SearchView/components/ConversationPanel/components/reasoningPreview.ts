// Copyright (c) 2026. 千诚. Licensed under GPL v3

/** 收起状态预览的最大字符数。 */
export const REASONING_PREVIEW_MAX_CHARS = 160;

/**
 * 预览只扫描有限前缀，避免在流式输出期间对整段思考文本做归一化。
 * 扫描上限留出余量，保证空白折叠后仍能填满预览长度。
 */
const PREVIEW_SCAN_MULTIPLIER = 4;

export function buildReasoningPreview(
    content: string,
    maxChars: number = REASONING_PREVIEW_MAX_CHARS
): string {
    const scanLimit = Math.max(maxChars, maxChars * PREVIEW_SCAN_MULTIPLIER);
    const scanned = content.length > scanLimit ? content.slice(0, scanLimit) : content;
    const normalized = scanned.replace(/\s+/g, ' ').trim();

    if (normalized.length <= maxChars) {
        return normalized;
    }

    return `${normalized.slice(0, maxChars)}…`;
}
