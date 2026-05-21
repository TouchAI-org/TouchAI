export interface NameSegment {
    text: string;
    matched: boolean;
}

/**
 * 将查询文本标准化为去重 token 列表，按长度降序排列。
 *
 * @param query 原始查询文本。
 * @returns 去重后的匹配 token 列表。
 */
export function buildMatchTokens(query: string): string[] {
    const tokens = query
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .filter((token) => token.length > 0);
    return Array.from(new Set(tokens)).sort((a, b) => b.length - a.length);
}

/**
 * 将名称按 token 匹配结果拆分成高亮片段。
 *
 * @param name 原始名称文本。
 * @param tokens 查询 token 列表。
 * @returns 供模板渲染的高亮分段列表。
 */
export function splitNameByTokens(name: string, tokens: string[]): NameSegment[] {
    if (!name) return [{ text: '', matched: false }];
    if (tokens.length === 0) return [{ text: name, matched: false }];

    const lowerName = name.toLowerCase();
    // 每个字符位置是否命中任一 token，后续再据此合并连续区间。
    const matchedMask = new Array(name.length).fill(false);

    for (const token of tokens) {
        let searchFrom = 0;
        while (searchFrom < lowerName.length) {
            const index = lowerName.indexOf(token, searchFrom);
            if (index === -1) break;

            const end = Math.min(index + token.length, name.length);
            // 命中区间内的字符统一标记为 true，支持多个 token 叠加高亮。
            for (let i = index; i < end; i += 1) {
                matchedMask[i] = true;
            }
            // 从当前命中尾部继续搜索，避免同一 token 在同位置重复匹配。
            searchFrom = index + token.length;
        }
    }

    const segments: NameSegment[] = [];
    let currentMatched = matchedMask[0] ?? false;
    let currentText = '';

    for (let i = 0; i < name.length; i += 1) {
        const char = name[i] ?? '';
        const charMatched = matchedMask[i] ?? false;
        // 命中状态切换时，先提交上一段，再开启新段。
        if (charMatched !== currentMatched) {
            segments.push({ text: currentText, matched: currentMatched });
            currentText = char;
            currentMatched = charMatched;
            continue;
        }
        currentText += char;
    }

    if (currentText.length > 0) {
        segments.push({ text: currentText, matched: currentMatched });
    }

    return segments;
}
