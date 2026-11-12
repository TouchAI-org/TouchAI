import { describe, expect, it } from 'vitest';

import instructions from '@/prompts/skills/skill-creator/SKILL.md?raw';
import { AiErrorCode } from '@/services/AgentService/contracts/errors';
import type { AskUserAnswer, AskUserQuestion } from '@/services/AgentService/contracts/tooling';
import { askUserTool } from '@/services/BuiltInToolService/tools/askUser';

function destinationQuestion(): Record<string, unknown> {
    const examples = [...instructions.matchAll(/```json\s*\n([\s\S]*?)\n```/g)].map(
        ([, source]) => JSON.parse(source!) as Record<string, unknown>
    );
    const question = examples.find((example) => Array.isArray(example.questions));
    expect(question, 'The creation guide provides an executable destination choice').toBeDefined();
    return question!;
}

describe('given a new skill needs a destination', () => {
    it.each(['应用', '全局'])(
        'user selects %s when asked where to save and the assistant receives that choice',
        async (label) => {
            const args = destinationQuestion();
            let shown: AskUserQuestion[] = [];
            let answer!: (answers: AskUserAnswer[]) => void;
            const pending = new Promise<AskUserAnswer[]>((resolve) => {
                answer = resolve;
            });
            let completed = false;
            const execution = askUserTool
                .execute(
                    args,
                    {},
                    {
                        callId: 'skill-destination',
                        iteration: 0,
                        requestUserQuestions: async (_callId, questions) => {
                            shown = questions;
                            return pending;
                        },
                    }
                )
                .then((result) => {
                    completed = true;
                    return result;
                });

            await Promise.resolve();
            expect(shown).toHaveLength(1);
            expect(shown[0]).toMatchObject({
                multiSelect: false,
                allowOther: true,
                options: [{ label: '应用' }, { label: '全局' }],
            });
            expect(completed).toBe(false);

            answer([{ questionIndex: 0, selectedLabels: [label], skipped: false }]);
            const result = await execution;
            expect(result.isError).toBe(false);
            expect(result.result).toContain(`answered: ${label}`);
        }
    );

    it('user skips the destination question and the assistant receives no default choice', async () => {
        const result = await askUserTool.execute(
            destinationQuestion(),
            {},
            {
                callId: 'skill-destination-skipped',
                iteration: 0,
                requestUserQuestions: async () => [
                    { questionIndex: 0, selectedLabels: [], skipped: true },
                ],
            }
        );

        expect(result.result).toContain('skipped by user');
        expect(result.result).not.toContain('answered:');
    });

    it('user cancels the destination question and the creation turn is cancelled', async () => {
        await expect(
            askUserTool.execute(
                destinationQuestion(),
                {},
                {
                    callId: 'skill-destination-cancelled',
                    iteration: 0,
                    requestUserQuestions: async () => null,
                }
            )
        ).rejects.toMatchObject({ code: AiErrorCode.REQUEST_CANCELLED });
    });
});
