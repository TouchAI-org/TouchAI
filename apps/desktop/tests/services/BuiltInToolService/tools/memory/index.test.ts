import { describe, expect, it } from 'vitest';

import { memoryTool } from '@/services/BuiltInToolService/tools/memory';
import type { BuiltInTool } from '@/services/BuiltInToolService/types';

const tool = memoryTool as BuiltInTool<Record<string, never>>;
const context = {
    callId: 'call-1',
    iteration: 0,
    hasExecutedBuiltInTool: () => false,
};

describe('memoryTool', () => {
    it('does not require approval for reads', () => {
        expect(
            tool.buildApprovalRequest({ action: 'read', ids: [1] }, {}, 'builtin__memory', context)
        ).toBeNull();
    });

    it('requires approval for writes', () => {
        expect(
            tool.buildApprovalRequest(
                {
                    action: 'upsert',
                    title: '桌面工作流',
                    applicability: '当任务涉及桌面工作流时读取。',
                    content: '使用工具观察真实状态。',
                },
                {},
                'builtin__memory',
                context
            )
        ).toMatchObject({
            title: expect.stringMatching(/记忆修改确认|memoryChangeTitle/),
        });
    });

    it('builds conversation semantics for read and write operations', () => {
        expect(memoryTool.buildConversationSemantic({ action: 'read', ids: [1, 2] })).toEqual({
            action: 'read',
            target: '1, 2',
            presentationHint: {
                kind: 'memory',
                items: ['1', '2'],
            },
        });
        expect(memoryTool.buildConversationSemantic({ action: 'delete', id: 2 })).toEqual({
            action: 'remove',
            target: '2',
            presentationHint: {
                kind: 'memory',
                items: ['2'],
            },
        });
    });

    it('builds read semantics from returned memory titles', () => {
        const result = [
            'Found 1 memory.',
            '',
            '1. memory_id: 3',
            '   title_untrusted: "桌面 Agent 工作方式"',
        ].join('\n');

        expect(
            memoryTool.buildConversationSemanticFromResult(result, {
                action: 'read',
                ids: [3],
            })
        ).toEqual({
            action: 'read',
            target: '桌面 Agent 工作方式',
            presentationHint: {
                kind: 'memory',
                items: ['桌面 Agent 工作方式'],
            },
        });
    });

    it('delegates prepare and log sanitization to the memory helper', async () => {
        expect(
            await tool.prepareForExecution(
                {
                    action: 'read',
                    ids: [3, 3],
                },
                {},
                context
            )
        ).toEqual({
            action: 'read',
            ids: [3],
        });

        expect(
            tool.sanitizeLogInput(
                {
                    action: 'upsert',
                    title: '桌面工作流',
                    applicability: '当任务涉及桌面工作流时读取。',
                    content: '使用工具观察真实状态。',
                },
                {}
            )
        ).toMatchObject({
            action: 'upsert',
            title: '桌面工作流',
            content: '[REDACTED_MEMORY_CONTENT]',
        });
    });
});
