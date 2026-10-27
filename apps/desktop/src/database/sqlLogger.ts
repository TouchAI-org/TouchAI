// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { Logger } from 'drizzle-orm/logger';

/**
 * 开发期 SQL 日志。
 *
 * Drizzle 自带的 `DefaultLogger` 会把整条 SQL 的**全部参数**序列化后打到控制台，
 * 而 webview 的 console 会被转发到 Rust 日志文件。长会话一次读取就有上百万字符的
 * tool 输出参数，光是格式化 + 写盘就能把打开会话卡住。
 *
 * 这里默认只输出 SQL 主体（截断）与参数个数；需要看真实参数时在控制台执行
 * `window.__TOUCHAI_SQL_LOG__ = true` 再复现。
 */
const MAX_SQL_LENGTH = 400;
/** 单条参数序列化的字符上限；超过即判定为“大载荷”，默认不打。 */
const MAX_PARAM_PREVIEW_LENGTH = 2000;

interface SqlLogWindow {
    __TOUCHAI_SQL_LOG__?: boolean;
}

function shouldLogParams(): boolean {
    if (typeof window === 'undefined') {
        return false;
    }

    return (window as Window & SqlLogWindow).__TOUCHAI_SQL_LOG__ === true;
}

export function createSqlLogger(): Logger {
    return {
        logQuery(query, params) {
            const sql =
                query.length > MAX_SQL_LENGTH ? `${query.slice(0, MAX_SQL_LENGTH)}…` : query;

            if (shouldLogParams()) {
                const serialized = JSON.stringify(params);
                const preview =
                    serialized.length > MAX_PARAM_PREVIEW_LENGTH
                        ? `${serialized.slice(0, MAX_PARAM_PREVIEW_LENGTH)}…(${serialized.length} chars)`
                        : serialized;
                console.log(`Query: ${sql} -- params: ${preview}`);
                return;
            }

            console.log(`Query: ${sql} -- params: ${params.length}`);
        },
    };
}
