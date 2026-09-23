import { getMarkdown } from 'markstream-vue';

import { getLocale, tt } from '@/i18n';
import type { SessionTaskSnapshot } from '@/services/AgentService/task/types';
import type { PendingToolApproval, SessionMessage } from '@/types/session';
import { getSessionStatusReminderContent } from '@/utils/session';
import { collapseWhitespace } from '@/utils/text';

const MAX_BODY_CHARS = 220;
const MAX_COMMAND_CHARS = 160;
const MAX_SUMMARY_CLAUSES = 4;
const MAX_MARKDOWN_SOURCE_CHARS = 4096;
const COMMAND_FENCE = /^\s*(```|~~~)[^\r\n`~]*\r?\n([\s\S]*?)\r?\n\1\s*$/;

type MarkdownToken = {
    type: string;
    content?: string;
    text?: string;
    children?: MarkdownToken[] | null;
};

// Notifications are plain text. Raw HTML stays literal, including diagnostic tags.
// Paths and glob syntax in Markdown should use code spans; escapes follow Markdown semantics.
const markdownParser = getMarkdown('touchai-reminder-preview', {
    enableContainers: false,
    markdownItOptions: { html: false, breaks: true },
});

function separators() {
    return /^en(?:-|$)/i.test(getLocale())
        ? { clause: '; ', cell: ', ', sentence: '. ', colon: ': ' }
        : { clause: '；', cell: '、', sentence: '。', colon: '：' };
}

/** Budgets use UTF-16 units, without cutting a surrogate pair in half. */
function sliceText(value: string, maxChars: number): string {
    let end = Math.max(0, maxChars);
    const last = value.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
    return value.slice(0, end);
}

function truncateText(value: string, maxChars: number): string {
    if (value.length <= maxChars) return value;
    if (maxChars <= 3) return '.'.repeat(Math.max(0, maxChars));
    return `${sliceText(value, maxChars - 3).trimEnd()}...`;
}

/** Errors and commands retain their syntax; only whitespace and length change. */
export function previewNotificationText(
    value: string | null | undefined,
    maxChars = MAX_BODY_CHARS
): string | null {
    const text = collapseWhitespace(value ?? '');
    return text ? truncateText(text, maxChars) : null;
}

function inlineText(tokens: MarkdownToken[]): string {
    return tokens
        .map((token) => {
            if (token.type === 'softbreak' || token.type === 'hardbreak') return '\n';
            if (token.children?.length) return inlineText(token.children);
            return token.content ?? token.text ?? '';
        })
        .join('');
}

function markdownClauses(source: string): string[] {
    const clauses: string[] = [];
    let tableRow: string[] | null = null;
    const pushClause = (text: string) => {
        const normalized = collapseWhitespace(text);
        if (normalized) clauses.push(normalized);
    };

    // Parse once, including reference definitions; do not rewrite or reparse inline source.
    const tokens = markdownParser.parse(source, {}) as MarkdownToken[];
    for (const token of tokens) {
        switch (token.type) {
            case 'tr_open':
                tableRow = [];
                break;
            case 'tr_close':
                pushClause((tableRow ?? []).join(separators().cell));
                tableRow = null;
                break;
            case 'inline': {
                const text = inlineText(token.children ?? []);
                if (tableRow) tableRow.push(collapseWhitespace(text));
                else text.split('\n').forEach(pushClause);
                break;
            }
            case 'fence':
            case 'code_block':
                pushClause(token.content ?? '');
                break;
        }
    }
    return clauses;
}

/** Standard Markdown to a text preview, with a fixed separator between clauses. */
export function summarizeNotificationText(
    value: string | null | undefined,
    maxChars = MAX_BODY_CHARS,
    mode: 'natural' | 'summary' = 'natural'
): string | null {
    const source = sliceText(value ?? '', MAX_MARKDOWN_SOURCE_CHARS).replace(/\r\n?/g, '\n');
    if (!source.trim()) return null;

    try {
        const clauses = markdownClauses(source);
        const selected = mode === 'summary' ? clauses.slice(0, MAX_SUMMARY_CLAUSES) : clauses;
        return previewNotificationText(selected.join(separators().clause), maxChars);
    } catch {
        // A preview failure must not prevent the notification from being delivered.
        return previewNotificationText(source, maxChars);
    }
}

export function summarizeLatestAssistantResponse(history: SessionMessage[]): string | null {
    for (let index = history.length - 1; index >= 0; index -= 1) {
        const message = history[index];
        if (message?.role !== 'assistant') continue;
        const summary = summarizeNotificationText(message.content, MAX_BODY_CHARS, 'summary');
        if (summary) return summary;
    }
    return null;
}

/** Reserve space for the command so a long approval reason cannot hide it. */
export function buildWaitingApprovalBody(approval: PendingToolApproval): string {
    const summary =
        summarizeNotificationText(approval.reason) ??
        summarizeNotificationText(approval.description) ??
        summarizeNotificationText(approval.title) ??
        getSessionStatusReminderContent('waiting_approval');
    const command = previewNotificationText(
        approval.command?.replace(COMMAND_FENCE, '$2'),
        MAX_COMMAND_CHARS
    );
    if (!command || command === summary) return summary;

    const punctuation = separators();
    const commandClause = `${tt('命令')}${punctuation.colon}${command}`;
    const joiner = /[.!?。！？;；:：]$/.test(summary) ? ' ' : punctuation.sentence;
    const summaryBudget = MAX_BODY_CHARS - joiner.length - commandClause.length;
    if (summaryBudget <= 0) return truncateText(commandClause, MAX_BODY_CHARS);
    return `${truncateText(summary, summaryBudget)}${joiner}${commandClause}`;
}

export function buildWaitingUserQuestionBody(
    question: NonNullable<SessionTaskSnapshot['pendingUserQuestion']>
): string {
    return summarizeNotificationText(question.questions[0]?.question) ?? tt('任务正在等待用户回复');
}
