// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { t } from '@/i18n';
import { AiError, AiErrorCode } from '@/services/AgentService/contracts/errors';
import type { AskUserAnswer, AskUserQuestion } from '@/services/AgentService/contracts/tooling';

import {
    type BaseBuiltInToolExecutionContext,
    BuiltInTool,
    type BuiltInToolConversationSemantic,
    type BuiltInToolExecutionResult,
    type BuiltInToolGroup,
} from '../../types';
import {
    ASK_USER_TOOL_DESCRIPTION,
    ASK_USER_TOOL_INPUT_SCHEMA,
    ASK_USER_TOOL_NAME,
} from './constants';

interface ParsedAskUserArgs {
    questions: AskUserQuestion[];
}

function parseAskUserArgs(args: Record<string, unknown>): ParsedAskUserArgs | string {
    const raw = args.questions;
    if (!Array.isArray(raw) || raw.length === 0) {
        return 'questions must be a non-empty array';
    }
    if (raw.length > 4) {
        return 'questions array must have at most 4 items';
    }

    const questions: AskUserQuestion[] = [];
    for (let i = 0; i < raw.length; i++) {
        const q = raw[i];
        if (!q || typeof q !== 'object') {
            return `questions[${i}] must be an object`;
        }
        const item = q as Record<string, unknown>;
        const question = String(item.question ?? '').trim();
        const header = String(item.header ?? '').trim();
        if (!question) {
            return `questions[${i}].question is required`;
        }
        if (!header) {
            return `questions[${i}].header is required`;
        }

        const options = item.options;
        if (!Array.isArray(options) || options.length < 2 || options.length > 4) {
            return `questions[${i}].options must have 2-4 items`;
        }

        questions.push({
            question,
            header,
            multiSelect: Boolean(item.multiSelect),
            allowOther: Boolean(item.allowOther),
            options: options.map((opt: unknown) => {
                if (!opt || typeof opt !== 'object') {
                    return { label: String(opt ?? '') };
                }
                const o = opt as Record<string, unknown>;
                return {
                    label: String(o.label ?? '').trim(),
                    description: o.description ? String(o.description).trim() : undefined,
                };
            }),
        });
    }

    return { questions };
}

function formatAnswersForModel(questions: AskUserQuestion[], answers: AskUserAnswer[]): string {
    const lines: string[] = [];
    for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        const a = answers[i];
        if (!q) continue;
        const prefix = `Q${i + 1} [${q.question}]`;
        if (!a || a.skipped) {
            lines.push(`${prefix} -> skipped by user`);
        } else {
            const parts: string[] = [];
            if (a.selectedLabels.length > 0) {
                parts.push(a.selectedLabels.join('; '));
            }
            if (a.otherText) {
                parts.push(`Other: "${a.otherText}"`);
            }
            lines.push(`${prefix} -> answered: ${parts.join(' | ')}`);
        }
    }
    return lines.join('\n');
}

class AskUserTool extends BuiltInTool {
    readonly id = 'ask_user_question' as const;
    readonly displayName = ASK_USER_TOOL_NAME;
    readonly description = ASK_USER_TOOL_DESCRIPTION;
    readonly inputSchema = ASK_USER_TOOL_INPUT_SCHEMA;
    readonly defaultConfig = {};

    override buildConversationSemantic(
        args: Record<string, unknown>
    ): BuiltInToolConversationSemantic {
        const parsed = parseAskUserArgs(args);
        if (typeof parsed === 'string') {
            return { action: 'ask', target: t('askUser.semantic.fallbackTarget') };
        }
        const count = parsed.questions.length;
        if (count === 1) {
            const q = parsed.questions[0]!.question;
            return {
                action: 'ask',
                target: q.length > 60 ? q.slice(0, 57) + '...' : q,
            };
        }
        return {
            action: 'ask',
            target: t('askUser.semantic.questionsCount', { count }),
        };
    }

    override buildConversationSemanticFromResult(
        result: string,
        args: Record<string, unknown>
    ): BuiltInToolConversationSemantic | null {
        void args;
        const lines = result.split('\n').filter((l) => l.startsWith('Q'));
        if (lines.length === 0) return null;
        const summary = lines
            .map((line) => {
                const match = line.match(/^Q\d+\s+\[.*?\]\s*->\s*(.+)$/);
                return match?.[1] ?? line;
            })
            .join('; ');
        return {
            action: 'ask',
            target: summary.length > 80 ? summary.slice(0, 77) + '...' : summary,
        };
    }

    override async execute(
        args: Record<string, unknown>,
        _config: unknown,
        context: BaseBuiltInToolExecutionContext
    ): Promise<BuiltInToolExecutionResult> {
        const parsed = parseAskUserArgs(args);
        if (typeof parsed === 'string') {
            return {
                result: `Error: ${parsed}`,
                isError: true,
                status: 'error',
                errorMessage: parsed,
            };
        }

        const { questions } = parsed;

        if (!context.requestUserQuestions) {
            return {
                result: 'Error: ask_user_question is not available in this context',
                isError: true,
                status: 'error',
                errorMessage: 'ask_user_question is not available in this context',
            };
        }

        if (context.signal?.aborted) {
            throw new AiError(AiErrorCode.REQUEST_CANCELLED);
        }

        const answers = await context.requestUserQuestions(context.callId, questions);

        if (context.signal?.aborted) {
            throw new AiError(AiErrorCode.REQUEST_CANCELLED);
        }

        if (answers === null) {
            throw new AiError(AiErrorCode.REQUEST_CANCELLED, 'User cancelled the question');
        }

        const result = formatAnswersForModel(questions, answers);

        return {
            result,
            isError: false,
            status: 'success',
        };
    }
}

export const askUserTool = new AskUserTool();
export const builtInTools: BuiltInToolGroup = [askUserTool];
