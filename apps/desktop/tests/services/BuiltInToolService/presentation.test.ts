import { describe, expect, it } from 'vitest';

import { resolveBuiltInToolConversationSemantic } from '@/services/BuiltInToolService/presentation';

describe('built-in tool presentation semantics', () => {
    it('returns null in result-only mode when the result has no derived semantic', () => {
        expect(
            resolveBuiltInToolConversationSemantic(
                'builtin__upgrade_model',
                {},
                {
                    result: '模型升级失败\n原因: 当前模型已经位于升级链末尾',
                    resultOnly: true,
                }
            )
        ).toBeNull();
    });

    it('still falls back to argument semantics outside result-only mode', () => {
        expect(
            resolveBuiltInToolConversationSemantic(
                'builtin__upgrade_model',
                {},
                {
                    result: '模型升级失败\n原因: 当前模型已经位于升级链末尾',
                }
            )
        ).toEqual({
            action: 'switch',
            target: '高一级模型',
        });
    });
});
