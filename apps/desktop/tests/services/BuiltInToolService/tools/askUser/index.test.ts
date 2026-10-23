// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { AiErrorCode } from '@services/AgentService/contracts/errors';
import type { AskUserAnswer, AskUserQuestion } from '@services/AgentService/contracts/tooling';
import { askUserTool } from '@services/BuiltInToolService/tools/askUser';
import type { BaseBuiltInToolExecutionContext } from '@services/BuiltInToolService/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';

function question(overrides: Partial<AskUserQuestion> = {}): AskUserQuestion {
    return {
        question: 'Which database should I use?',
        header: 'Database',
        multiSelect: false,
        allowOther: false,
        options: [{ label: 'SQLite' }, { label: 'Postgres' }],
        ...overrides,
    };
}

function context(
    requestUserQuestions?: (
        callId: string,
        questions: AskUserQuestion[]
    ) => Promise<AskUserAnswer[] | null>,
    overrides: Partial<BaseBuiltInToolExecutionContext> = {}
): BaseBuiltInToolExecutionContext {
    return {
        callId: 'call-1',
        iteration: 0,
        hasExecutedBuiltInTool: () => false,
        ...(requestUserQuestions ? { requestUserQuestions } : {}),
        ...overrides,
    };
}

function run(args: Record<string, unknown>, executionContext: BaseBuiltInToolExecutionContext) {
    return askUserTool.execute(args, {}, executionContext);
}

beforeEach(() => {
    setLocale('en-US');
});

describe('user is asked a question by the assistant', () => {
    it('user sees the answers reported back to the model in question order', async () => {
        const answers: AskUserAnswer[] = [
            { questionIndex: 0, selectedLabels: ['SQLite'], skipped: false },
            { questionIndex: 1, selectedLabels: ['Fast'], otherText: 'and cheap', skipped: false },
        ];

        const result = await run(
            {
                questions: [
                    question(),
                    question({
                        question: 'What matters most?',
                        options: [{ label: 'Fast' }, { label: 'Safe' }],
                    }),
                ],
            },
            context(async () => answers)
        );

        expect(result.isError).toBe(false);
        expect(result.status).toBe('success');
        expect(result.result).toBe(
            [
                'Q1 [Which database should I use?] -> answered: SQLite',
                'Q2 [What matters most?] -> answered: Fast | Other: "and cheap"',
            ].join('\n')
        );
    });

    it('user sees a skipped question reported as skipped instead of answered', async () => {
        const result = await run(
            { questions: [question()] },
            context(
                async () =>
                    [{ questionIndex: 0, selectedLabels: [], skipped: true }] as AskUserAnswer[]
            )
        );

        expect(result.result).toBe('Q1 [Which database should I use?] -> skipped by user');
    });

    it('user sees multiple selections reported together', async () => {
        const result = await run(
            { questions: [question({ multiSelect: true })] },
            context(
                async () =>
                    [
                        {
                            questionIndex: 0,
                            selectedLabels: ['SQLite', 'Postgres'],
                            skipped: false,
                        },
                    ] as AskUserAnswer[]
            )
        );

        expect(result.result).toBe(
            'Q1 [Which database should I use?] -> answered: SQLite; Postgres'
        );
    });

    it('user is told what is wrong when the model sends a malformed question', async () => {
        const cases: Array<[Record<string, unknown>, string]> = [
            [{}, 'questions must be a non-empty array'],
            [{ questions: [] }, 'questions must be a non-empty array'],
            [{ questions: 'nope' }, 'questions must be a non-empty array'],
            [{ questions: Array(5).fill(question()) }, 'questions array must have at most 4 items'],
            [{ questions: ['nope'] }, 'questions[0] must be an object'],
            [
                { questions: [{ header: 'H', options: [{ label: 'a' }, { label: 'b' }] }] },
                'questions[0].question is required',
            ],
            [
                { questions: [{ question: 'Q', options: [{ label: 'a' }, { label: 'b' }] }] },
                'questions[0].header is required',
            ],
            [
                { questions: [{ question: 'Q', header: 'H', options: [{ label: 'a' }] }] },
                'questions[0].options must have 2-4 items',
            ],
            [
                {
                    questions: [
                        { question: 'Q', header: 'H', options: Array(5).fill({ label: 'a' }) },
                    ],
                },
                'questions[0].options must have 2-4 items',
            ],
        ];

        for (const [args, expected] of cases) {
            const request = vi.fn();
            const result = await run(args, context(request));

            expect(result.isError).toBe(true);
            expect(result.status).toBe('error');
            expect(result.errorMessage).toBe(expected);
            expect(request).not.toHaveBeenCalled();
        }
    });

    it('user is told the question tool is unavailable instead of being left waiting', async () => {
        const result = await run({ questions: [question()] }, context());

        expect(result.isError).toBe(true);
        expect(result.errorMessage).toBe('ask_user_question is not available in this context');
    });

    it('user sees the request cancelled when they stop the turn while answering', async () => {
        const controller = new AbortController();

        await expect(
            run(
                { questions: [question()] },
                context(
                    async () => {
                        controller.abort();
                        return [{ questionIndex: 0, selectedLabels: [], skipped: true }];
                    },
                    { signal: controller.signal }
                )
            )
        ).rejects.toMatchObject({ code: AiErrorCode.REQUEST_CANCELLED });
    });

    it('user sees the request cancelled when they dismiss the question panel', async () => {
        await expect(
            run(
                { questions: [question()] },
                context(async () => null)
            )
        ).rejects.toMatchObject({ code: AiErrorCode.REQUEST_CANCELLED });
    });

    it('user reads a one-question prompt summarized by the question text itself', () => {
        expect(askUserTool.buildConversationSemantic({ questions: [question()] })).toEqual({
            action: 'ask',
            target: 'Which database should I use?',
        });
    });

    it('user sees a long question shortened in the conversation summary', () => {
        const long = 'A'.repeat(80);

        const semantic = askUserTool.buildConversationSemantic({
            questions: [question({ question: long })],
        });

        expect(semantic.target).toBe(`${'A'.repeat(57)}...`);
    });

    it('user sees the number of questions summarized for a multi-question prompt', () => {
        const semantic = askUserTool.buildConversationSemantic({
            questions: [question(), question()],
        });

        expect(semantic.target).toContain('2');
    });

    it('user sees a generic summary when the question prompt is malformed', () => {
        const semantic = askUserTool.buildConversationSemantic({ questions: [] });

        expect(semantic.action).toBe('ask');
        expect(semantic.target).toBeTruthy();
    });
});
