import { describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';
import { syncBuiltInToolCallPresentation } from '@/services/AgentService/task/projection/toolCalls';
import type { ToolCallInfo } from '@/types/session';

describe('syncBuiltInToolCallPresentation memory output', () => {
    it('rebuilds read memory presentation from returned titles', () => {
        setLocale('zh-CN');
        const toolCall: ToolCallInfo = {
            id: 'call-memory',
            name: 'Memory',
            namespacedName: 'builtin__memory',
            source: 'builtin',
            sourceLabel: '内置工具',
            arguments: { action: 'read', ids: [3] },
            builtinConversationSemantic: {
                action: 'read',
                target: '3',
                presentationHint: {
                    kind: 'memory',
                    items: ['3'],
                },
            },
            result: [
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
            ].join('\n'),
            status: 'completed',
        };

        syncBuiltInToolCallPresentation(toolCall);

        expect(toolCall.builtinPresentation).toEqual({
            verb: '已读取',
            content: '记忆(桌面 Agent 工作方式)',
        });
        expect(toolCall.builtinConversationSemantic).toEqual({
            action: 'read',
            target: '桌面 Agent 工作方式',
            presentationHint: {
                kind: 'memory',
                items: ['桌面 Agent 工作方式'],
            },
        });
    });

    it('localizes legacy memory summaries rebuilt from persisted semantics', () => {
        setLocale('en-US');
        const toolCall: ToolCallInfo = {
            id: 'call-memory-legacy',
            name: 'Memory',
            namespacedName: 'builtin__memory',
            source: 'builtin',
            sourceLabel: '内置工具',
            arguments: { action: 'read', ids: [3] },
            builtinConversationSemantic: {
                action: 'read',
                target: '记忆(桌面 Agent 工作方式)',
            },
            status: 'completed',
        };

        syncBuiltInToolCallPresentation(toolCall);

        expect(toolCall.builtinPresentation).toEqual({
            verb: 'Read',
            content: 'Memory (桌面 Agent 工作方式)',
        });
    });

    it('keeps existing semantic when result has no result-derived semantic', () => {
        setLocale('zh-CN');
        const toolCall: ToolCallInfo = {
            id: 'call-upgrade',
            name: 'UpgradeModel',
            namespacedName: 'builtin__upgrade_model',
            source: 'builtin',
            sourceLabel: '内置工具',
            arguments: {},
            builtinConversationSemantic: {
                action: 'switch',
                target: 'OpenAI / GPT-5.5',
            },
            result: '模型升级失败\n原因: 当前模型已经位于升级链末尾',
            status: 'error',
        };

        syncBuiltInToolCallPresentation(toolCall);

        expect(toolCall.builtinConversationSemantic).toEqual({
            action: 'switch',
            target: 'OpenAI / GPT-5.5',
        });
        expect(toolCall.builtinPresentation).toEqual({
            verb: '切换失败',
            content: 'OpenAI / GPT-5.5',
        });
    });
});
