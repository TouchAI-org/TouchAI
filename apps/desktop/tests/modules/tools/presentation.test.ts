import { afterEach, describe, expect, it } from 'vitest';

import { setLocale, t, tt } from '@/i18n';
import { createAskUserTools, createToolPresentation } from '@/modules/tools';

afterEach(() => setLocale('zh-CN'));

describe('given an instance-created builtin catalog and active language', () => {
    it('user reads the same question for namespaced and display-name activity without constructing another registry', () => {
        setLocale('en-US');
        const presentation = createToolPresentation(createAskUserTools({ t, tt }), { t, tt });
        const args = {
            questions: [
                {
                    question: 'Choose a direction',
                    header: 'Direction',
                    options: [{ label: 'Left' }, { label: 'Right' }],
                },
            ],
        };
        expect(presentation.resolveSemantic('builtin__ask_user_question', args)).toEqual({
            action: 'ask',
            target: 'Choose a direction',
        });
        expect(presentation.presentation('AskUserQuestion', args, 'completed')).toEqual({
            verb: 'Asked',
            content: 'Choose a direction',
        });
    });

    it('user sees committed semantic hints and current translated status while unregistered or MCP names stay unknown', () => {
        setLocale('en-US');
        const presentation = createToolPresentation(createAskUserTools({ t, tt }), { t, tt });
        expect(
            presentation.presentation('builtin__ask_user_question', {}, 'rejected', {
                semantic: { action: 'ask', target: 'Committed question' },
            })
        ).toEqual({ verb: 'Rejected', content: 'Committed question' });
        expect(presentation.presentation('mcp__1__ask_user_question', {}, 'completed')).toBeNull();
        expect(presentation.resolveSemantic('unknown', {})).toBeNull();
        setLocale('zh-CN');
        expect(
            presentation.presentation('ask_user_question', {}, 'cancelled', {
                semantic: { action: 'ask', target: 'Committed question' },
            })
        ).toEqual({ verb: '已取消', content: 'Committed question' });
    });

    it('user receives a clear collision failure before an ambiguous presentation catalog can be used', () => {
        const descriptors = createAskUserTools({ t, tt });
        expect(() => createToolPresentation([...descriptors, ...descriptors], { t, tt })).toThrow(
            'Duplicate tool name: builtin__ask_user_question'
        );
        const valid = createToolPresentation(descriptors, { t, tt });
        expect(valid.resolveSemantic('  ', {})).toBeNull();
    });
});
