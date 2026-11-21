/// <reference lib="es2022.intl" />

import type { PrivacyProtectionDetails } from '@/app/api/privacy';

export interface PrivacyContextPart {
    original: string;
    masked: string;
    marked: boolean;
}

interface PrivacyContext {
    excerpts: PrivacyContextPart[][];
}

const CONTEXT_CHARACTERS = 48;
const MINIMUM_OMISSION = 32;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const plain = (text: string): PrivacyContextPart => ({
    original: text,
    masked: text,
    marked: false,
});

function excerpt(paragraph: PrivacyContextPart[]): PrivacyContextPart[] {
    if (!paragraph.some((part) => part.marked)) return [plain('…')];
    return paragraph.map((part, index) => {
        if (part.marked) return part;
        const characters = Array.from(graphemes.segment(part.original), (item) => item.segment);
        const before = index > 0;
        const after = index < paragraph.length - 1;
        const budget = CONTEXT_CHARACTERS * Number(before) + CONTEXT_CHARACTERS * Number(after);
        if (characters.length <= budget + MINIMUM_OMISSION) return part;
        return plain(
            `${before ? characters.slice(0, CONTEXT_CHARACTERS).join('') : ''}…${after ? characters.slice(-CONTEXT_CHARACTERS).join('') : ''}`
        );
    });
}

export function privacyProtectionContexts(snapshot: PrivacyProtectionDetails): PrivacyContext[] {
    const values = new Map(snapshot.values.map((value) => [value.placeholder, value]));
    if (!values.size) return [];
    const pattern = new RegExp(
        [...values.keys()]
            .filter(Boolean)
            .sort((left, right) => right.length - left.length)
            .map((placeholder) => placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
            .join('|'),
        'g'
    );
    const seen = new Set<string>();
    const contexts: PrivacyContext[] = [];
    for (const text of snapshot.texts) {
        const paragraphs = text
            .split(/\r\n|[\n\r]/)
            .filter((paragraph) => paragraph.trim())
            .map((paragraph) => {
                const parts: PrivacyContextPart[] = [];
                let cursor = 0;
                for (const match of paragraph.matchAll(pattern)) {
                    const value = values.get(match[0]);
                    if (!value) continue;
                    if (match.index > cursor)
                        parts.push(plain(paragraph.slice(cursor, match.index)));
                    parts.push({
                        original: value.original,
                        masked: value.placeholder,
                        marked: true,
                    });
                    seen.add(value.placeholder);
                    cursor = match.index + match[0].length;
                }
                if (cursor < paragraph.length) parts.push(plain(paragraph.slice(cursor)));
                return parts;
            });
        if (!paragraphs.some((parts) => parts.some((part) => part.marked))) continue;
        const excerpts = paragraphs
            .map(excerpt)
            .filter(
                (parts, index, rows) =>
                    parts.some((part) => part.marked) ||
                    index === 0 ||
                    rows[index - 1]!.some((part) => part.marked)
            );
        contexts.push({ excerpts });
    }
    const remaining = snapshot.values
        .filter((value) => !seen.has(value.placeholder))
        .map((value) => [{ original: value.original, masked: value.placeholder, marked: true }]);
    if (remaining.length) contexts.push({ excerpts: remaining });
    return contexts;
}
