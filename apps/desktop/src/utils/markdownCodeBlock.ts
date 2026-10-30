// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * 长代码块检测。
 *
 * 流式阶段对超长代码块使用纯文本 `pre` 渲染，避免为仍在增长的代码块
 * 初始化高亮/编辑器 renderer；消息结束后再交给正常 renderer。
 */

const FENCE_PATTERN = /^(\s{0,3})(`{3,}|~{3,})/;

export function containsLongCodeBlock(markdown: string, threshold: number): boolean {
    let index = 0;

    while (index < markdown.length) {
        const start = markdown.indexOf('```', index);
        const tilde = markdown.indexOf('~~~', index);
        const fenceStart = start === -1 ? tilde : tilde === -1 ? start : Math.min(start, tilde);
        if (fenceStart === -1) {
            return false;
        }

        const lineEnd = markdown.indexOf('\n', fenceStart);
        if (lineEnd === -1) {
            return false;
        }

        const openerLine = markdown.slice(markdown.lastIndexOf('\n', fenceStart) + 1, lineEnd);
        const fenceMatch = FENCE_PATTERN.exec(openerLine);
        if (!fenceMatch) {
            index = fenceStart + 3;
            continue;
        }

        const fenceMarker = fenceMatch[2]!;
        const closing = markdown.indexOf(fenceMarker, lineEnd);
        const bodyEnd = closing === -1 ? markdown.length : closing;
        if (bodyEnd - lineEnd > threshold) {
            return true;
        }

        index = closing === -1 ? markdown.length : closing + fenceMarker.length;
    }

    return false;
}
