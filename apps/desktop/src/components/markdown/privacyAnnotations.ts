import type { ParsedNode } from 'markstream-vue';

import type { PrivacyReviewAnnotation } from '@/app/api/privacy';

/** Keep restored values literal while the installed parser owns Markdown structure. */
export function preparePrivacyMarkdown(
    content: string,
    annotations: PrivacyReviewAnnotation[],
    prefix: string
) {
    while (content.includes(prefix) || content.includes(encodeURI(prefix))) prefix += '\uE000';
    const encodedPrefix = encodeURI(prefix);
    const replacements = new Map<string, PrivacyReviewAnnotation>();
    let cursor = 0;
    let source = '';
    for (const annotation of [...annotations].sort((a, b) => a.start - b.start)) {
        if (
            annotation.start < cursor ||
            content.slice(annotation.start, annotation.end) !== annotation.original
        )
            continue;
        const token = `${prefix}${replacements.size}\uE001`;
        replacements.set(token, annotation);
        source += content.slice(cursor, annotation.start) + token;
        cursor = annotation.end;
    }
    source += content.slice(cursor);

    function restore(value: string, reveal = true) {
        const spans: PrivacyReviewAnnotation[] = [];
        let text = '';
        let cursor = 0;
        while (cursor < value.length) {
            const literalIndex = value.indexOf(prefix, cursor);
            const encodedIndex = value.indexOf(encodedPrefix, cursor);
            const encoded = encodedIndex >= 0 && (literalIndex < 0 || encodedIndex < literalIndex);
            const index = encoded ? encodedIndex : literalIndex;
            if (index < 0) break;
            const suffix = encoded ? '%EE%80%81' : '\uE001';
            const suffixIndex = value.indexOf(
                suffix,
                index + (encoded ? encodedPrefix.length : prefix.length)
            );
            if (suffixIndex < 0) break;
            const end = suffixIndex + suffix.length;
            const token = value.slice(index, end);
            const annotation = replacements.get(encoded ? decodeURI(token) : token);
            if (!annotation) {
                text += value.slice(cursor, end);
                cursor = end;
                continue;
            }
            const replacement = reveal ? annotation.original : annotation.placeholder;
            const original = encoded ? encodeURI(replacement) : replacement;
            text += value.slice(cursor, index);
            spans.push({
                ...annotation,
                original,
                start: text.length,
                end: text.length + original.length,
            });
            text += original;
            cursor = end;
        }
        return { text: text + value.slice(cursor), spans };
    }

    function restoreValue(value: unknown): unknown {
        if (typeof value === 'string') return restore(value).text;
        if (Array.isArray(value)) {
            const restored = value.map(restoreValue);
            return restored.every((item, index) => item === value[index]) ? value : restored;
        }
        if (!value || typeof value !== 'object') return value;
        const node = value as Record<string, unknown>;
        const result = Object.fromEntries(
            Object.entries(node).map(([key, item]) => [
                key,
                typeof item === 'string' && ['src', 'srcset', 'poster', 'data'].includes(key)
                    ? restore(item, false).text
                    : restoreValue(item),
            ])
        );
        const text =
            node.type === 'text'
                ? node.content
                : node.type === 'inline_code' || node.type === 'code_block'
                  ? node.code
                  : undefined;
        if (typeof text === 'string') {
            const { spans } = restore(text);
            if (spans.length) result.privacyAnnotations = spans;
        }
        return Object.entries(result).every(([key, item]) => item === node[key]) ? value : result;
    }

    return {
        content: source,
        hasAnnotations: replacements.size > 0,
        restoreNodes: (nodes: ParsedNode[]) =>
            replacements.size ? (restoreValue(nodes) as ParsedNode[]) : nodes,
    };
}
