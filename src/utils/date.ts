/**
 * 将数据库格式的日期字符串规范化为 ISO 8601 格式并解析。
 *
 * SQLite 的 `datetime('now')` 返回 `YYYY-MM-DD HH:MM:SS` 格式（无 T、无时区），
 * 直接丢进 `Date.parse` 在部分引擎下会返回 NaN 或被当作本地时间。
 * 这里统一补上 `T` 分隔符和 `Z` 后缀。
 */
export function parseDbDateString(value: string): Date {
    const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
    return new Date(normalized);
}

export function parseDbDateTimestamp(value: string): number {
    const timestamp = parseDbDateString(value).getTime();
    return Number.isNaN(timestamp) ? Date.now() : timestamp;
}
