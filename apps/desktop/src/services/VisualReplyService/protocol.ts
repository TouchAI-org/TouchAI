// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

export const MAX_ARTIFACT_HTML_CHARS = 150_000;
export const LEGACY_SHOW_WIDGET_TOOL_NAME = 'builtin__show_widget';

export type VisualReplySegment =
    | { id: string; type: 'markdown'; content: string }
    | { id: string; type: 'openui'; content: string }
    | { id: string; type: 'artifact'; content: string };

const VISUAL_BLOCK_PATTERN =
    /(^|\n)```(openui-lang|touchai-artifact)[ \t]*\r?\n([\s\S]*?)(?:\r?\n```|$)/gi;

export function parseVisualReplySegments(content: string): VisualReplySegment[] {
    const segments: VisualReplySegment[] = [];
    let cursor = 0;
    let match: RegExpExecArray | null;

    while ((match = VISUAL_BLOCK_PATTERN.exec(content))) {
        const blockStart = match.index + (match[1]?.length ?? 0);
        if (blockStart > cursor) {
            segments.push({
                id: `markdown-${cursor}`,
                type: 'markdown',
                content: content.slice(cursor, blockStart),
            });
        }

        const type = match[2]!.toLowerCase() === 'openui-lang' ? 'openui' : 'artifact';
        segments.push({
            id: `${type}-${blockStart}`,
            type,
            content: match[3] ?? '',
        });
        cursor = VISUAL_BLOCK_PATTERN.lastIndex;
    }

    if (cursor < content.length) {
        segments.push({
            id: `markdown-${cursor}`,
            type: 'markdown',
            content: content.slice(cursor),
        });
    }

    return segments.filter((segment) => segment.type !== 'markdown' || segment.content.length > 0);
}

export function parseLegacyArtifactContent(content: string): string {
    const codeBlock = content.match(/^\s*```(?:html)?\s*\r?\n([\s\S]*?)\r?\n```\s*$/i);
    return codeBlock?.[1] ?? content;
}
