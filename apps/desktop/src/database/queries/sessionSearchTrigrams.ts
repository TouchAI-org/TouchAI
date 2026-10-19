// Copyright (c) 2026. 千诚. Licensed under GPL v3

/**
 * 为 message_search_fts 生成候选筛选表达式。
 *
 * `detail=none` 的 trigram 索引只接受单个三元组，不能使用带引号的短语查询。
 * 因此这里把搜索词拆成多个"必须出现"的三元组，用 AND 连接来缩小候选集；
 * 候选仍会被完整 LIKE 复核，所以增加三元组不会改变搜索语义。
 *
 * 返回 null 表示无法安全使用索引候选（词太短或含 NUL），调用方应回退到全文扫描。
 */
export function buildSessionSearchTrigramExpression(
    query: string,
    options: { maxTrigrams?: number } = {}
): string | null {
    const maxTrigrams = Math.max(1, Math.floor(options.maxTrigrams ?? 3));
    if (query.includes('\0')) {
        return null;
    }

    const characters = Array.from(query);
    if (characters.length < 3) {
        return null;
    }

    // 分散取样：首、尾、中，避免只命中前缀导致候选过宽。
    const starts = new Set<number>([0, characters.length - 3]);
    if (characters.length >= 9) {
        starts.add(Math.floor((characters.length - 3) / 2));
    }

    const tokens: string[] = [];
    const seen = new Set<string>();

    for (const start of Array.from(starts).sort((left, right) => left - right)) {
        if (tokens.length >= maxTrigrams) {
            break;
        }

        const token = characters.slice(start, start + 3).join('');
        if (token.length !== 3 || seen.has(token)) {
            continue;
        }

        seen.add(token);
        tokens.push(token);
    }

    if (tokens.length === 0) {
        return null;
    }

    return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(' AND ');
}
