export function truncateText(text: string, maxLength: number, ellipsis = '...'): string {
    return text.length > maxLength ? text.substring(0, maxLength) + ellipsis : text;
}

/**
 * 把输入值标准化为字符串；如果不是字符串则返回空字符串。
 * 返回前会去掉首尾空白字符。
 */
export function normalizeString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

/**
 * 把输入值标准化为字符串或 `undefined`。
 * 如果输入不是字符串，或去掉首尾空白后为空，则返回 `undefined`。
 */
export function normalizeOptionalString(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed || undefined;
}
