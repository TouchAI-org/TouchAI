import { describe, expect, it } from 'vitest';

import { searchConversationTool } from '@/services/BuiltInToolService/tools/searchConversation';
import type { BuiltInTool } from '@/services/BuiltInToolService/types';

const tool = searchConversationTool as BuiltInTool<Record<string, never>>;

describe('searchConversationTool', () => {
    it('does not request approval because the tool is read-only', () => {
        expect(
            tool.buildApprovalRequest({ query: 'memory' }, {}, 'builtin__search_conversation', {
                callId: 'call-1',
                iteration: 0,
                hasExecutedBuiltInTool: () => false,
            })
        ).toBeNull();
    });

    it('builds search conversation semantics from query or keywords', () => {
        expect(searchConversationTool.buildConversationSemantic({ query: 'memory' })).toEqual({
            action: 'search',
            target: 'memory',
        });
        expect(
            searchConversationTool.buildConversationSemantic({
                keywords: ['clipboard', 'screenshot'],
            })
        ).toEqual({
            action: 'search',
            target: 'clipboard, screenshot',
        });
    });

    it('falls back to history target for invalid arguments', () => {
        expect(searchConversationTool.buildConversationSemantic({ keywords: [] })).toEqual({
            action: 'search',
            target: '历史会话',
        });
    });
});
