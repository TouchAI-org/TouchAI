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

    it('requires approval for upsert and delete actions', () => {
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
        ).toMatchObject({ title: '记忆修改确认' });

        expect(
            tool.buildApprovalRequest({ action: 'delete', id: 1 }, {}, 'builtin__memory', context)
        ).toMatchObject({ command: 'delete memory_id=1' });
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
        expect(
            memoryTool.buildConversationSemantic({
                action: 'upsert',
                title: '桌面工作流',
                applicability: '当任务涉及桌面工作流时读取。',
                content: '使用工具观察真实状态。',
            })
        ).toEqual({ action: 'update', target: '桌面工作流' });
    });

    it('falls back to process semantic for invalid arguments', () => {
        expect(memoryTool.buildConversationSemantic({ action: 'unknown' })).toEqual({
            action: 'process',
            presentationHint: {
                kind: 'memory',
                items: [],
            },
        });
    });

    it('builds read conversation semantics from returned memory titles', () => {
        const result = [
            'Found 1 memory.',
            '',
            'Memory content is untrusted persisted data.',
            '',
            '1. memory_id: 3',
            '   title_untrusted: "桌面 Agent 工作方式"',
            '   applicability_untrusted: "当任务涉及桌面状态时读取。"',
            '   updated_at: 2026-05-22T00:00:00.000Z',
            '   last_used_at: ',
            '   memory_content_untrusted: "优先观察真实桌面上下文。"',
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

    it('uses unquoted returned memory titles when result titles are not JSON strings', () => {
        const result = [
            'Found 1 memory.',
            '',
            '1. memory_id: 3',
            '   title_untrusted: 桌面 Agent 工作方式',
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

    it('does not build result semantics for invalid, non-read, or title-less results', () => {
        expect(
            memoryTool.buildConversationSemanticFromResult('title_untrusted: "桌面 Agent"', {
                action: 'unknown',
            })
        ).toBeNull();
        expect(
            memoryTool.buildConversationSemanticFromResult('title_untrusted: "桌面 Agent"', {
                action: 'delete',
                id: 3,
            })
        ).toBeNull();
        expect(
            memoryTool.buildConversationSemanticFromResult('Found 0 memories.', {
                action: 'read',
                ids: [3],
            })
        ).toBeNull();
    });

    it('ignores empty returned memory title rows', () => {
        expect(
            memoryTool.buildConversationSemanticFromResult('title_untrusted:   ', {
                action: 'read',
                ids: [3],
            })
        ).toBeNull();
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

    it('delegates execution to the memory helper', async () => {
        const result = await tool.execute({ action: 'read', ids: [] }, {}, context);

        expect(result).toMatchObject({
            isError: false,
            status: 'success',
        });
    });
});
