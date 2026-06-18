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
const REMINDER_PATH_LIKE_TOKEN_PATTERN = /\S*[\\/]\S*/g;
const REMINDER_PATH_WRAPPER_TRIM_PATTERN = /^[("'[{]+|[)"'\],.;:!?}]+$/g;
const REMINDER_PATH_SEGMENT_PATTERN = '(?:[A-Za-z0-9._@-]+|\\*{1,2})';
const REMINDER_POSIX_RELATIVE_PATH_PATTERN = new RegExp(
    `^(?:${REMINDER_PATH_SEGMENT_PATTERN}/)+${REMINDER_PATH_SEGMENT_PATTERN}$`
);
const REMINDER_WINDOWS_RELATIVE_PATH_PATTERN = new RegExp(
    `^(?:${REMINDER_PATH_SEGMENT_PATTERN}\\\\)+${REMINDER_PATH_SEGMENT_PATTERN}$`
);
const REMINDER_POSIX_ABSOLUTE_PATH_PATTERN = new RegExp(
    `^(?:/|\\.{1,2}/|~/)(?:${REMINDER_PATH_SEGMENT_PATTERN}/)*${REMINDER_PATH_SEGMENT_PATTERN}$`
);
const REMINDER_WINDOWS_ABSOLUTE_PATH_PATTERN = new RegExp(
    `^(?:[A-Za-z]:\\\\|\\.{1,2}\\\\|~\\\\)(?:${REMINDER_PATH_SEGMENT_PATTERN}\\\\)*${REMINDER_PATH_SEGMENT_PATTERN}$`
);
const REMINDER_WINDOWS_UNC_PATH_PATTERN = new RegExp(
    `^\\\\\\\\${REMINDER_PATH_SEGMENT_PATTERN}(?:\\\\${REMINDER_PATH_SEGMENT_PATTERN})+$`
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

const REMINDER_INLINE_LINE_BREAK_HTML_TAGS = new Set(['br', 'hr']);
const REMINDER_INLINE_ZERO_WIDTH_HTML_TAGS = new Set(['wbr']);

const reminderMarkdownParser = getMarkdown('touchai-reminder-markdown', {
    enableContainers: false,
    markdownItOptions: {
        breaks: true,
    },
});

function truncateNotificationText(value: string, maxChars: number): string {
    if (value.length <= maxChars) {
        return value;
    }

    return `${value.slice(0, maxChars - 3).trimEnd()}...`;
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
    return value.length <= REMINDER_MARKDOWN_SCAN_MAX_CHARS
        ? value
        : value.slice(0, REMINDER_MARKDOWN_SCAN_MAX_CHARS);
}

function unescapeReminderMarkdown(value: string): string {
    return value.replace(REMINDER_MARKDOWN_ESCAPE_PATTERN, '$1');
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
    if (!isReminderPathLikeToken(token)) {
        return token;
    }

    if (!/[`*_]/.test(token)) {
        return token;
    }

    if (/^!?\[[^\]]*]\([^)]+\)$/.test(token)) {
        return token;
    }

    return token.replace(/([\\`*_])/g, '\\$1');
}

/**
 * Bound regex work to a small prefix and preserve path-like markdown fragments
 * so emphasis markers inside file paths survive plain-text conversion.
 */
function prepareReminderMarkdownSource(value: string): string {
    const normalized = limitReminderMarkdownSource(value.replace(/\r\n?/g, '\n'));
    const protectedPaths: string[] = [];
    const withPlaceholders = normalized.replace(REMINDER_PATH_LIKE_TOKEN_PATTERN, (token) => {
        if (!isReminderPathLikeToken(token)) {
            return token;
        }

        const placeholder = `%%TOUCHAI_REMINDER_PATH_${protectedPaths.length}%%`;
        protectedPaths.push(protectPathLikeMarkdownToken(token));
        return placeholder;
    });
    const unescaped = unescapeReminderMarkdown(withPlaceholders);
    return protectedPaths.reduce(
        (text, token, index) => text.replace(`%%TOUCHAI_REMINDER_PATH_${index}%%`, token),
        unescaped
    );
}

/** Keep fallback HTML cleanup conservative so diagnostics like `<title>` survive. */
function stripHtmlToText(value: string): string {
    if (!value) {
        return '';
    }

    if (typeof DOMParser !== 'undefined') {
        try {
            return new DOMParser().parseFromString(value, 'text/html').body.textContent ?? '';
        } catch {
            // Fall back to a conservative tag strip when DOM parsing is unavailable.
        }
    }

    return value.replace(/<[^>]+>/g, ' ');
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

/**
 * Reverse-scan inline HTML tokens once so opening tags can be stripped in O(n)
 * when a matching closing tag appears later in the same inline fragment.
 */
function collectPairedReminderInlineHtmlOpenings(tokens: ReminderMarkdownToken[]): Set<number> {
    const pairedOpeningIndexes = new Set<number>();
    const closingCounts = new Map<string, number>();

    for (let index = tokens.length - 1; index >= 0; index -= 1) {
        const token = tokens[index];
        if (token?.type !== 'html_inline') {
            continue;
        }

        const parsedTag = parseReminderInlineHtmlTag(token.content ?? '');
        if (!parsedTag || parsedTag.isSelfClosing) {
            continue;
        }

        if (parsedTag.isClosing) {
            closingCounts.set(parsedTag.tagName, (closingCounts.get(parsedTag.tagName) ?? 0) + 1);
            continue;
        }

        const closingCount = closingCounts.get(parsedTag.tagName) ?? 0;
        if (closingCount <= 0) {
            continue;
        }

        pairedOpeningIndexes.add(index);
        if (closingCount === 1) {
            closingCounts.delete(parsedTag.tagName);
        } else {
            closingCounts.set(parsedTag.tagName, closingCount - 1);
        }
    }

    return pairedOpeningIndexes;
}

/** Strip only obvious HTML markup in the fallback path and keep literal angle-bracket text. */
function normalizeReminderFallbackHtml(value: string): string {
    let normalized = value
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<hr\s*\/?>/gi, '\n')
        .replace(/<wbr\s*\/?>/gi, '');

    normalized = normalized.replace(/<([A-Za-z][A-Za-z0-9:-]*)\s*>(?=[\s\S]*<\/\1\s*>)/g, '');
    normalized = normalized.replace(/<\/[A-Za-z][A-Za-z0-9:-]*\s*>/g, '');
    normalized = normalized.replace(/<[A-Za-z][A-Za-z0-9:-]*\b[^>]*\/>/g, '');
    normalized = normalized.replace(/<[A-Za-z][A-Za-z0-9:-]*\b[^>]*\s+[^>]*>/g, '');

    return normalized;
}

function normalizeReminderInlineHtmlToken(
    tokenContent: string,
    index: number,
    pairedOpeningIndexes: Set<number>,
    openTags: Map<string, number>
): string {
    const parsedTag = parseReminderInlineHtmlTag(tokenContent);
    if (!parsedTag) {
        return tokenContent;
    }

    if (REMINDER_INLINE_LINE_BREAK_HTML_TAGS.has(parsedTag.tagName)) {
        return '\n';
    }

    if (REMINDER_INLINE_ZERO_WIDTH_HTML_TAGS.has(parsedTag.tagName)) {
        return '';
    }

    if (parsedTag.isClosing) {
        const openCount = openTags.get(parsedTag.tagName) ?? 0;
        if (openCount <= 0) {
            return tokenContent;
        }

        if (openCount === 1) {
            openTags.delete(parsedTag.tagName);
        } else {
            openTags.set(parsedTag.tagName, openCount - 1);
        }
        return '';
    }

    if (parsedTag.isSelfClosing) {
        return parsedTag.hasAttributes ? '' : tokenContent;
    }

    const shouldStripOpening = parsedTag.hasAttributes || pairedOpeningIndexes.has(index);
    if (!shouldStripOpening) {
        return tokenContent;
    }

    openTags.set(parsedTag.tagName, (openTags.get(parsedTag.tagName) ?? 0) + 1);
    return '';
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
    const openInlineHtmlTags = new Map<string, number>();
    const pairedOpeningIndexes = collectPairedReminderInlineHtmlOpenings(tokens);

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
            case 'html_inline':
                text += normalizeReminderInlineHtmlToken(
                    token.content ?? '',
                    index,
                    pairedOpeningIndexes,
                    openInlineHtmlTags
                );
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

    return text || fallback;
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
    pushReminderClauses(clauses, normalizeReminderFallbackHtml(value));
    return clauses;
}

function collectReminderClauses(
    value: string,
    mode: Extract<ReminderTextMode, 'natural' | 'summary'>
): string[] {
    const source = prepareReminderMarkdownSource(value);
    if (!source.trim()) {
        return [];
    }

    try {
        const tokens = reminderMarkdownParser.parse(source, {}) as ReminderMarkdownToken[];
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
                    pushReminderClauses(clauses, stripHtmlToText(token.content ?? ''));
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
