import { getMarkdown } from 'markstream-vue';

import { getLocale, tt } from '@/i18n';
import type { SessionTaskSnapshot } from '@/services/AgentService/task/types';
import type { PendingToolApproval, SessionMessage } from '@/types/session';
import { getSessionStatusReminderContent } from '@/utils/session';
import { collapseWhitespace } from '@/utils/text';

const STATUS_REMINDER_MAX_BODY_CHARS = 220;
const STATUS_REMINDER_MAX_COMMAND_CHARS = 160;
const STATUS_REMINDER_MAX_SUMMARY_LINES = 4;
const REMINDER_MARKDOWN_SCAN_MAX_CHARS = 4096;
const REMINDER_SUMMARY_FIRST_CLAUSE_MAX_CHARS_EN = 60;
const REMINDER_SUMMARY_FIRST_CLAUSE_MAX_CHARS_DEFAULT = 40;
const REMINDER_SHORT_CLAUSE_MAX_CHARS_EN = 32;
const REMINDER_SHORT_CLAUSE_MAX_CHARS_DEFAULT = 24;

const REMINDER_MARKDOWN_ESCAPE_PATTERN = /\\([\\`*_{}[\]()#+.!>-])/g;
const REMINDER_PATH_WRAPPER_TRIM_PATTERN = /^[('"[{<]+|[)"'\],.;:!?}>]+$/g;
const REMINDER_DANGEROUS_HTML_TAG_NAMES = [
    'script',
    'style',
    'iframe',
    'object',
    'embed',
    'template',
];
const REMINDER_PATH_SEGMENT_PATTERN = String.raw`[\p{L}\p{N}\p{M}._@*?\[\]{},-]+`;
const REMINDER_POSIX_RELATIVE_PATH_PATTERN = new RegExp(
    `^(?:${REMINDER_PATH_SEGMENT_PATTERN}/)+${REMINDER_PATH_SEGMENT_PATTERN}$`,
    'u'
);
const REMINDER_WINDOWS_RELATIVE_PATH_PATTERN = new RegExp(
    `^(?:${REMINDER_PATH_SEGMENT_PATTERN}\\\\)+${REMINDER_PATH_SEGMENT_PATTERN}$`,
    'u'
);
const REMINDER_POSIX_ABSOLUTE_PATH_PATTERN = new RegExp(
    `^(?:/|\\.{1,2}/|~/)(?:${REMINDER_PATH_SEGMENT_PATTERN}/)*${REMINDER_PATH_SEGMENT_PATTERN}$`,
    'u'
);
const REMINDER_WINDOWS_ABSOLUTE_PATH_PATTERN = new RegExp(
    `^(?:[A-Za-z]:\\\\|\\.{1,2}\\\\|~\\\\)(?:${REMINDER_PATH_SEGMENT_PATTERN}\\\\)*${REMINDER_PATH_SEGMENT_PATTERN}$`,
    'u'
);
const REMINDER_WINDOWS_UNC_PATH_PATTERN = new RegExp(
    `^\\\\\\\\${REMINDER_PATH_SEGMENT_PATTERN}(?:\\\\${REMINDER_PATH_SEGMENT_PATTERN})+$`,
    'u'
);
const REMINDER_COMMAND_FENCE_PATTERN = /^\s*(```|~~~)[^\r\n`~]*\r?\n([\s\S]*?)\r?\n\1\s*$/;

type ReminderTextMode = 'natural' | 'command' | 'summary';

type ReminderMarkdownBaseToken = {
    type: string;
    content?: string;
    children?: ReminderMarkdownToken[] | null;
};

type ReminderMarkdownLinkToken = ReminderMarkdownBaseToken & {
    type: 'link';
    text?: string;
};

type ReminderMarkdownToken = ReminderMarkdownBaseToken | ReminderMarkdownLinkToken;

type ReminderInlineHtmlTag = {
    hasAttributes: boolean;
    isClosing: boolean;
    isSelfClosing: boolean;
    tagName: string;
};

const REMINDER_LINE_BREAK_HTML_TAGS = new Set([
    'br',
    'hr',
    'div',
    'p',
    'section',
    'article',
    'header',
    'footer',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'li',
    'ul',
    'ol',
    'tr',
    'blockquote',
    'pre',
]);
const REMINDER_KNOWN_HTML_TAGS = new Set([
    ...REMINDER_LINE_BREAK_HTML_TAGS,
    'a',
    'b',
    'i',
    'u',
    's',
    'em',
    'strong',
    'span',
    'code',
    'del',
    'ins',
    'small',
    'sub',
    'sup',
    'mark',
    'kbd',
    'samp',
    'var',
    'abbr',
    'title',
    'img',
    'input',
    'link',
    'meta',
    'wbr',
    'table',
    'thead',
    'tbody',
    'tfoot',
    'th',
    'td',
    'dl',
    'dt',
    'dd',
    'details',
    'summary',
    'figure',
    'figcaption',
]);
const REMINDER_DANGEROUS_HTML_TAGS = new Set(REMINDER_DANGEROUS_HTML_TAG_NAMES);

const reminderMarkdownParser = getMarkdown('touchai-reminder-markdown', {
    enableContainers: false,
    markdownItOptions: {
        breaks: true,
    },
});

// markstream exposes markdown-it utilities as unknown values at this boundary.
const decodeReminderHtmlEntity = reminderMarkdownParser.utils.unescapeAll as (
    value: string
) => string;

function decodeReminderHtmlText(value: string): string {
    // Only entities are HTML syntax here; backslashes in paths remain literal.
    return value.replace(
        /&(?:#[xX][0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]+);/g,
        decodeReminderHtmlEntity
    );
}

function truncateNotificationText(value: string, maxChars: number): string {
    if (value.length <= maxChars) {
        return value;
    }

    if (maxChars <= 3) {
        return '.'.repeat(Math.max(0, maxChars));
    }
    let end = maxChars - 3;
    // A notification budget is measured in UTF-16 units, but must not split a code point.
    const lastCodeUnit = value.charCodeAt(end - 1);
    if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) {
        end -= 1;
    }
    return `${value.slice(0, end).trimEnd()}...`;
}

function isEnglishReminderLocale(): boolean {
    return /^en(?:-|$)/i.test(getLocale());
}

function getReminderListSeparator(): string {
    return isEnglishReminderLocale() ? ', ' : '\u3001';
}

function getReminderClauseSeparator(): string {
    return isEnglishReminderLocale() ? '; ' : '\uFF1B';
}

function getReminderSentenceSeparator(): string {
    return isEnglishReminderLocale() ? '. ' : '\u3002';
}

function getReminderColonSeparator(): string {
    return isEnglishReminderLocale() ? ': ' : '\uFF1A';
}

function getReminderSummaryFirstClauseMaxChars(): number {
    return isEnglishReminderLocale()
        ? REMINDER_SUMMARY_FIRST_CLAUSE_MAX_CHARS_EN
        : REMINDER_SUMMARY_FIRST_CLAUSE_MAX_CHARS_DEFAULT;
}

function getReminderShortClauseMaxChars(): number {
    return isEnglishReminderLocale()
        ? REMINDER_SHORT_CLAUSE_MAX_CHARS_EN
        : REMINDER_SHORT_CLAUSE_MAX_CHARS_DEFAULT;
}

/** Detect sentence-ending punctuation so reminder clauses can join naturally. */
function hasTerminalPunctuation(value: string): boolean {
    return /[.!?\u3002\uFF01\uFF1F;:\uFF1B\uFF1A]$/.test(value.trim());
}

function limitReminderMarkdownSource(value: string): string {
    if (value.length <= REMINDER_MARKDOWN_SCAN_MAX_CHARS) return value;
    let end = REMINDER_MARKDOWN_SCAN_MAX_CHARS;
    const lastCodeUnit = value.charCodeAt(end - 1);
    if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) end -= 1;
    return value.slice(0, end);
}

function unescapeReminderMarkdown(value: string): string {
    return value.replace(REMINDER_MARKDOWN_ESCAPE_PATTERN, (match, marker: string) =>
        marker === '[' || marker === ']' ? match : marker
    );
}

/** Find a complete HTML fragment without treating quoted `>` as its boundary. */
function findReminderHtmlEnd(value: string, start: number): number | null {
    if (value.startsWith('<!--', start)) {
        const end = value.indexOf('-->', start + 4);
        return end < 0 ? value.length : end + 3;
    }
    if (!/^<\/?[A-Za-z]/.test(value.slice(start, start + 3))) return null;
    let quote = '';
    for (let index = start + 1; index < value.length; index += 1) {
        const char = value[index];
        if (quote) {
            if (char === quote) quote = '';
        } else if (char === '"' || char === "'") {
            quote = char;
        } else if (char === '>') {
            return index + 1;
        }
    }
    return null;
}

/** Tokenize only HTML fragments, never code spans/fences. Input is already bounded. */
function tokenizeReminderHtml(value: string): ReminderMarkdownToken[] {
    const tokens: ReminderMarkdownToken[] = [];
    let textStart = 0;
    let index = 0;
    while (index < value.length) {
        const tagEnd = value[index] === '<' ? findReminderHtmlEnd(value, index) : null;
        if (tagEnd === null) {
            index += 1;
            continue;
        }
        tokens.push({
            type: 'text',
            content: decodeReminderHtmlText(value.slice(textStart, index)),
        });
        tokens.push({ type: 'html_inline', content: value.slice(index, tagEnd) });
        index = tagEnd;
        textStart = tagEnd;
    }
    tokens.push({ type: 'text', content: decodeReminderHtmlText(value.slice(textStart)) });
    return tokens;
}

function isReminderPathLikeToken(token: string): boolean {
    const core = token.replace(REMINDER_PATH_WRAPPER_TRIM_PATTERN, '');
    return (
        REMINDER_POSIX_RELATIVE_PATH_PATTERN.test(core) ||
        REMINDER_WINDOWS_RELATIVE_PATH_PATTERN.test(core) ||
        REMINDER_POSIX_ABSOLUTE_PATH_PATTERN.test(core) ||
        REMINDER_WINDOWS_ABSOLUTE_PATH_PATTERN.test(core) ||
        REMINDER_WINDOWS_UNC_PATH_PATTERN.test(core)
    );
}

function protectPathLikeMarkdownToken(token: string): string {
    // Keep surrounding emphasis as markup, not as part of a glob path.
    const wrapper = token.match(/^(\*{1,3}|_{1,3})([\s\S]+)\1$/);
    const firstSegment = token.split(/[\\/]/, 1)[0] ?? '';
    if (
        wrapper?.[1] &&
        wrapper[2] &&
        !firstSegment.endsWith(wrapper[1]) &&
        (wrapper[1] !== '*' || !/[*?[\]{}]/.test(wrapper[2])) &&
        isReminderPathLikeToken(wrapper[2])
    ) {
        return `${wrapper[1]}${protectPathLikeMarkdownToken(wrapper[2])}${wrapper[1]}`;
    }
    if (!isReminderPathLikeToken(token)) {
        return unescapeReminderMarkdown(token);
    }

    if (!/[`*_]/.test(token) || /^!?\[[^\]]*]\([^)]+\)$/.test(token)) {
        return token;
    }

    return token.replace(/([\\`*_<>])/g, '\\$1');
}

/** Find a code span's matching delimiter, so brackets inside it stay literal. */
function findReminderCodeSpanEnd(value: string, start: number): number | null {
    let openingEnd = start + 1;
    while (value[openingEnd] === '`') openingEnd += 1;
    let closingStart = value.indexOf('`', openingEnd);
    while (closingStart >= 0) {
        let closingEnd = closingStart + 1;
        while (value[closingEnd] === '`') closingEnd += 1;
        if (closingEnd - closingStart === openingEnd - start) return closingEnd;
        closingStart = value.indexOf('`', closingEnd);
    }
    return null;
}

/** Protect prose paths, leaving code spans and HTML tag attributes verbatim. */
function prepareReminderProse(value: string): string {
    let result = '';
    let start = 0;
    let index = 0;
    const prepareFragment = (end: number): string =>
        value
            .slice(start, end)
            .replace(
                /(^|\n) {0,3}(?:\\#){1,6}(?:[\t ]+|$)/g,
                (match: string, lineBreak: string, offset: number) =>
                    offset === 0 && start > 0 && value[start - 1] !== '\n' ? match : lineBreak
            )
            .replace(/\S+/g, protectPathLikeMarkdownToken);
    while (index < value.length) {
        let verbatimEnd: number | null = null;
        let preparedLabel: string | null = null;
        if (value[index] === '[') {
            let depth = 1;
            let labelEnd = index + 1;
            for (; labelEnd < value.length; labelEnd += 1) {
                if (value[labelEnd] === '\\') {
                    labelEnd += 1;
                } else if (value[labelEnd] === '`') {
                    const codeEnd = findReminderCodeSpanEnd(value, labelEnd);
                    if (codeEnd !== null) labelEnd = codeEnd - 1;
                } else if (value[labelEnd] === '<') {
                    const tagEnd = findReminderHtmlEnd(value, labelEnd);
                    if (tagEnd !== null) labelEnd = tagEnd - 1;
                } else if (value[labelEnd] === '[') {
                    depth += 1;
                } else if (value[labelEnd] === ']' && --depth === 0) {
                    break;
                }
            }
            const label = value.slice(index + 1, labelEnd);
            if (depth === 0 && /[/\\]/.test(label)) {
                // Prepare the complete label before whitespace separates its path tokens.
                preparedLabel = `[${prepareReminderProse(label)}]`;
                verbatimEnd = labelEnd + 1;
            }
        } else if (value[index] === '<') {
            const tagEnd = findReminderHtmlEnd(value, index);
            if (tagEnd !== null) {
                const fragment = value.slice(index, tagEnd);
                const tag = parseReminderInlineHtmlTag(fragment);
                if ((tag?.isClosing && !tag.hasAttributes) || !isReminderPathLikeToken(fragment)) {
                    verbatimEnd = tagEnd;
                }
            }
        } else if (value[index] === '`') {
            let backslashes = 0;
            for (let before = index - 1; before >= 0 && value[before] === '\\'; before -= 1) {
                backslashes += 1;
            }
            if (backslashes % 2 === 0) {
                verbatimEnd = findReminderCodeSpanEnd(value, index);
            }
            if (verbatimEnd === null) {
                index += 1;
                while (value[index] === '`') index += 1;
                continue;
            }
        }
        if (verbatimEnd === null) {
            index += 1;
            continue;
        }
        result += prepareFragment(index);
        result += preparedLabel ?? value.slice(index, verbatimEnd);
        index = verbatimEnd;
        start = verbatimEnd;
    }
    return result + prepareFragment(value.length);
}

/** Parse a single markdown-it html_inline token into tag metadata when it is real tag syntax. */
function parseReminderInlineHtmlTag(value: string): ReminderInlineHtmlTag | null {
    const match = value.match(/^<\s*(\/)?\s*([A-Za-z][A-Za-z0-9:-]*)([\s\S]*?)>$/);
    if (!match) {
        return null;
    }

    const suffix = match[3] ?? '';
    const normalizedSuffix = suffix.replace(/\/\s*$/, '');
    return {
        hasAttributes: /\S/.test(normalizedSuffix),
        isClosing: Boolean(match[1]),
        isSelfClosing: /\/\s*$/.test(suffix),
        tagName: match[2]?.toLowerCase() ?? '',
    };
}

/** Pair tags once so code and unmatched angle-bracket diagnostics remain literal. */
function pairReminderHtmlTags(tokens: ReminderMarkdownToken[]): Map<number, number> {
    const pairs = new Map<number, number>();
    const openings = new Map<string, number[]>();
    tokens.forEach((token, index) => {
        if (token.type !== 'html_inline') return;
        const tag = parseReminderInlineHtmlTag(token.content ?? '');
        if (!tag || tag.isSelfClosing) return;
        if (!tag.isClosing) {
            const stack = openings.get(tag.tagName) ?? [];
            stack.push(index);
            openings.set(tag.tagName, stack);
        } else {
            const opening = openings.get(tag.tagName)?.pop();
            if (opening !== undefined) pairs.set(opening, index);
        }
    });
    return pairs;
}

/** Join only blocks spanned by actual dangerous HTML pairs; code tokens stay literal. */
function mergeReminderDangerousHtmlBlocks(
    tokens: ReminderMarkdownToken[]
): ReminderMarkdownToken[] {
    const leaves: { token: ReminderMarkdownToken; block: number }[] = [];
    const visit = (token: ReminderMarkdownToken, block: number): void => {
        const children =
            token.type === 'html_block'
                ? tokenizeReminderHtml(token.content ?? '')
                : token.children;
        if (children?.length) {
            children.forEach((child) => visit(child, block));
        } else {
            leaves.push({ token, block });
        }
    };
    tokens.forEach(visit);
    const ranges: { start: number; end: number }[] = [];
    for (const [opening, closing] of pairReminderHtmlTags(leaves.map(({ token }) => token))) {
        const first = leaves[opening];
        const last = leaves[closing];
        const tag = parseReminderInlineHtmlTag(first?.token.content ?? '');
        if (
            first &&
            last &&
            first.block !== last.block &&
            tag &&
            REMINDER_DANGEROUS_HTML_TAGS.has(tag.tagName)
        ) {
            ranges.push({ start: first.block, end: last.block });
        }
    }
    ranges.sort((a, b) => a.start - b.start);
    const merged: typeof ranges = [];
    for (const range of ranges) {
        const previous = merged[merged.length - 1];
        if (previous && range.start <= previous.end) {
            previous.end = Math.max(previous.end, range.end);
        } else {
            merged.push({ ...range });
        }
    }
    const result: ReminderMarkdownToken[] = [];
    let cursor = 0;
    for (const { start, end } of merged) {
        result.push(...tokens.slice(cursor, start), {
            type: 'inline',
            children: leaves
                .filter(({ block }) => block >= start && block <= end)
                .map(({ token }) => token),
        });
        // The merged text may start inside a cell; retain row/cell boundaries for the collector.
        result.push(
            ...tokens
                .slice(start + 1, end + 1)
                .filter((token) => /_(?:open|close)$/.test(token.type))
        );
        cursor = end + 1;
    }
    return [...result, ...tokens.slice(cursor)];
}
function normalizeCommandTypography(value: string): string {
    return value.replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'");
}

function unwrapReminderCommandFence(value: string): string {
    const match = value.match(REMINDER_COMMAND_FENCE_PATTERN);
    return match?.[2] ?? value;
}

function summarizeCommandPreview(
    value: string | null | undefined,
    maxChars: number
): string | null {
    const normalized = collapseWhitespace(
        normalizeCommandTypography(
            unwrapReminderCommandFence((value ?? '').replace(/\r\n?/g, '\n'))
        )
    );
    if (!normalized) {
        return null;
    }

    return truncateNotificationText(normalized, maxChars);
}

function extractReminderInlineText(
    tokens: ReminderMarkdownToken[] | null | undefined,
    fallback: string
): string {
    if (!tokens?.length) {
        return fallback;
    }

    let text = '';
    const htmlPairs = pairReminderHtmlTags(tokens);
    const pairedClosings = new Set(htmlPairs.values());

    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (!token) {
            continue;
        }

        switch (token.type) {
            case 'text':
            case 'code_inline':
                text += token.content ?? '';
                break;
            case 'softbreak':
            case 'hardbreak':
                text += '\n';
                break;
            case 'html_inline': {
                const content = token.content ?? '';
                if (content.startsWith('<!--')) break;
                const tag = parseReminderInlineHtmlTag(content);
                if (!tag) {
                    text += content;
                    break;
                }
                if (REMINDER_DANGEROUS_HTML_TAGS.has(tag.tagName)) {
                    // Suppress a paired element's contents, but not text after an unmatched tag.
                    index = htmlPairs.get(index) ?? index;
                    text += ' ';
                    break;
                }
                const isMarkup =
                    (tag.hasAttributes &&
                        (REMINDER_KNOWN_HTML_TAGS.has(tag.tagName) || tag.tagName.includes('-'))) ||
                    htmlPairs.has(index) ||
                    pairedClosings.has(index);
                if (
                    tag.tagName === 'br' ||
                    tag.tagName === 'hr' ||
                    tag.tagName === 'wbr' ||
                    (isMarkup && REMINDER_LINE_BREAK_HTML_TAGS.has(tag.tagName))
                ) {
                    text += '\n';
                } else if (!isMarkup) {
                    text += content;
                }
                break;
            }
            case 'html_block':
                text += extractReminderInlineText(tokenizeReminderHtml(token.content ?? ''), '');
                break;
            case 'link':
                text += extractReminderInlineText(
                    token.children,
                    (token as ReminderMarkdownLinkToken).text ?? token.content ?? ''
                );
                break;
            case 'link_open':
            case 'link_close':
                break;
            default:
                if (token.children?.length) {
                    text += extractReminderInlineText(token.children, '');
                    break;
                }

                if (token.type.endsWith('_open') || token.type.endsWith('_close')) {
                    break;
                }

                text += token.content ?? '';
                break;
        }
    }

    return text;
}

function pushReminderClauses(target: string[], value: string): void {
    for (const line of value.split('\n')) {
        const clause = collapseWhitespace(line);
        if (clause) {
            target.push(clause);
        }
    }
}

function fallbackReminderClauses(value: string): string[] {
    const clauses: string[] = [];
    pushReminderClauses(clauses, extractReminderInlineText(tokenizeReminderHtml(value), ''));
    return clauses;
}

function collectReminderClauses(
    value: string,
    mode: Extract<ReminderTextMode, 'natural' | 'summary'>
): string[] {
    const source = limitReminderMarkdownSource(value).replace(/\r\n?/g, '\n');
    if (!source.trim()) {
        return [];
    }

    try {
        const environment = {};
        const parsed = reminderMarkdownParser.parse(source, environment) as ReminderMarkdownToken[];
        const tokens = mergeReminderDangerousHtmlBlocks(
            parsed.map((token) => {
                if (token.type !== 'inline') return token;
                const content = token.content ?? '';
                const prepared = prepareReminderProse(content);
                if (prepared === content) return token;
                // Copy references without the parser's non-enumerable document reset marker.
                const inline = reminderMarkdownParser.parseInline(prepared, { ...environment });
                return { ...token, content: prepared, children: inline[0]?.children ?? [] };
            })
        );
        const clauses: string[] = [];
        let currentTableRow: string[] | null = null;
        let insideTableCell = false;

        for (const token of tokens) {
            switch (token.type) {
                case 'tr_open':
                    currentTableRow = [];
                    break;
                case 'tr_close': {
                    const row = currentTableRow?.filter(Boolean).join(getReminderListSeparator());
                    if (row) {
                        clauses.push(row);
                    }
                    currentTableRow = null;
                    insideTableCell = false;
                    break;
                }
                case 'th_open':
                case 'td_open':
                    insideTableCell = true;
                    break;
                case 'th_close':
                case 'td_close':
                    insideTableCell = false;
                    break;
                case 'inline': {
                    const text = extractReminderInlineText(token.children, token.content ?? '');
                    if (!text) {
                        break;
                    }

                    if (insideTableCell && currentTableRow) {
                        const cell = collapseWhitespace(text);
                        if (cell) {
                            currentTableRow.push(cell);
                        }
                        break;
                    }

                    pushReminderClauses(clauses, text);
                    break;
                }
                case 'fence':
                case 'code_block':
                    pushReminderClauses(clauses, token.content ?? '');
                    break;
                case 'html_block':
                    pushReminderClauses(
                        clauses,
                        extractReminderInlineText(tokenizeReminderHtml(token.content ?? ''), '')
                    );
                    break;
                default:
                    break;
            }
        }

        if (mode === 'summary') {
            return clauses.slice(0, STATUS_REMINDER_MAX_SUMMARY_LINES);
        }

        return clauses;
    } catch {
        const clauses = fallbackReminderClauses(source);
        return mode === 'summary' ? clauses.slice(0, STATUS_REMINDER_MAX_SUMMARY_LINES) : clauses;
    }
}

/** Short clauses can be rendered with a lighter separator for more compact summaries. */
function isShortReminderClause(value: string): boolean {
    const trimmed = value.trim();
    if (!trimmed || hasTerminalPunctuation(trimmed)) {
        return false;
    }

    if (trimmed.includes(getReminderListSeparator().trim())) {
        return false;
    }

    return trimmed.length <= getReminderShortClauseMaxChars();
}

/** Reuse sentence punctuation instead of doubling separators after completed clauses. */
function joinReminderSequence(clauses: string[], separator: string): string {
    const [firstClause, ...restClauses] = clauses;
    if (!firstClause) {
        return '';
    }

    let result = firstClause;
    for (const clause of restClauses) {
        const joiner = hasTerminalPunctuation(result) ? ' ' : separator;
        result = `${result}${joiner}${clause}`;
    }

    return result;
}

function joinReminderClauses(clauses: string[], mode: ReminderTextMode): string {
    const uniqueClauses: string[] = [];
    for (const clause of clauses) {
        // Only collapse adjacent duplicates so repeated later details still survive intact.
        if (uniqueClauses[uniqueClauses.length - 1] === clause) {
            continue;
        }
        uniqueClauses.push(clause);
    }

    if (uniqueClauses.length === 0) {
        return '';
    }

    const [firstClause, ...restClauses] = uniqueClauses;
    if (!firstClause) {
        return '';
    }

    if (restClauses.length === 0) {
        return firstClause;
    }

    const useTitledSummary =
        mode === 'summary' &&
        !hasTerminalPunctuation(firstClause) &&
        firstClause.length <= getReminderSummaryFirstClauseMaxChars();
    const separator =
        mode === 'summary' && restClauses.every((clause) => isShortReminderClause(clause))
            ? getReminderListSeparator()
            : getReminderClauseSeparator();
    const restText = joinReminderSequence(restClauses, separator);

    if (!useTitledSummary) {
        return joinReminderSequence(uniqueClauses, separator);
    }

    return `${firstClause}${getReminderColonSeparator()}${restText}`;
}

function appendReminderClause(base: string, clause: string | null): string {
    if (!clause) {
        return base;
    }

    if (!base) {
        return clause;
    }

    const separator = hasTerminalPunctuation(base) ? ' ' : getReminderSentenceSeparator();
    return `${base}${separator}${clause}`;
}

function formatReminderLabelValue(label: string, value: string): string {
    return `${label}${getReminderColonSeparator()}${value}`;
}

export function summarizeNotificationText(
    value: string | null | undefined,
    maxChars = STATUS_REMINDER_MAX_BODY_CHARS,
    mode: ReminderTextMode = 'natural'
): string | null {
    if (mode === 'command') {
        return summarizeCommandPreview(value, maxChars);
    }

    const normalized = joinReminderClauses(collectReminderClauses(value ?? '', mode), mode);
    if (!normalized) {
        return null;
    }

    return truncateNotificationText(normalized, maxChars);
}

export function summarizeLatestAssistantResponse(history: SessionMessage[]): string | null {
    for (let index = history.length - 1; index >= 0; index -= 1) {
        const message = history[index];
        if (message?.role !== 'assistant') {
            continue;
        }

        const summary = summarizeNotificationText(
            message.content,
            STATUS_REMINDER_MAX_BODY_CHARS,
            'summary'
        );
        if (summary) {
            return summary;
        }
    }

    return null;
}

/** Reserve notification budget for the command preview so approval context stays visible. */
export function buildWaitingApprovalBody(approval: PendingToolApproval): string {
    const summary =
        summarizeNotificationText(approval.reason) ??
        summarizeNotificationText(approval.description) ??
        summarizeNotificationText(approval.title) ??
        getSessionStatusReminderContent('waiting_approval');
    const commandPreview = summarizeNotificationText(
        approval.command,
        STATUS_REMINDER_MAX_COMMAND_CHARS,
        'command'
    );

    if (!commandPreview || commandPreview === summary) {
        return summary;
    }

    const commandClause = formatReminderLabelValue(tt('命令'), commandPreview);
    const reservedSuffixBudget = getReminderSentenceSeparator().length + commandClause.length;
    const remainingSummaryBudget = STATUS_REMINDER_MAX_BODY_CHARS - reservedSuffixBudget;
    if (remainingSummaryBudget <= 0) {
        return truncateNotificationText(commandClause, STATUS_REMINDER_MAX_BODY_CHARS);
    }

    const summaryPreview = truncateNotificationText(summary, remainingSummaryBudget);
    return appendReminderClause(summaryPreview, commandClause);
}

/** Use the first pending question as the waiting reminder, with locale-aware fallback text. */
export function buildWaitingUserQuestionBody(
    question: NonNullable<SessionTaskSnapshot['pendingUserQuestion']>
): string {
    const summary = summarizeNotificationText(question.questions[0]?.question);
    if (summary) {
        return summary;
    }

    return tt('任务正在等待用户回复');
}
