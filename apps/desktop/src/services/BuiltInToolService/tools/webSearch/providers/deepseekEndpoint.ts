/** DeepSeek 官方 API 根地址，用作兜底 base。 */
export const DEEPSEEK_API_ROOT = 'https://api.deepseek.com';

/** DeepSeek Search / Fetch 的稳定路径前缀。 */
export const DEEPSEEK_API_VERSION_PREFIX = '/v1';

/**
 * 把服务商 `api_endpoint` 归一化为 DeepSeek API 根地址。
 *
 * 官方同时接受 `https://api.deepseek.com` 与 `https://api.deepseek.com/v1`，
 * 因此先剥掉尾部 `/v1` 再统一拼接版本前缀，避免出现 `/v1/v1/...`。
 */
export function toDeepSeekApiRoot(endpoint: string | null | undefined): string {
    const trimmed = (endpoint ?? '').trim().replace(/\/+$/, '');
    if (!trimmed) {
        return DEEPSEEK_API_ROOT;
    }
    return trimmed.replace(/\/v1$/i, '');
}

/** 拼接 DeepSeek 工具接口地址，例如 `buildDeepSeekToolsUrl(base, 'search')`。 */
export function buildDeepSeekToolsUrl(
    endpoint: string | null | undefined,
    tool: 'search' | 'fetch'
): string {
    return `${toDeepSeekApiRoot(endpoint)}${DEEPSEEK_API_VERSION_PREFIX}/tools/${tool}`;
}
