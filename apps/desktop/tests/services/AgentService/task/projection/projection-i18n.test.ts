import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import { SessionTaskProjection } from '@/services/AgentService/task/projection/projection';
import type { SessionTaskSnapshot } from '@/services/AgentService/task/types';
import { selectToolCalls } from '@/utils/session';

function createSnapshot(): SessionTaskSnapshot {
    return {
        taskId: 'task-1',
        sessionId: 1,
        turnId: null,
        status: 'running',
        executionMode: 'foreground',
        prompt: 'Prompt',
        sessionHistory: [],
        pendingToolApproval: null,
        pendingApprovals: [],
        pendingUserQuestion: null,
        error: null,
        currentModel: null,
        promptSnapshot: null,
        lastCheckpoint: null,
        startedAt: 1,
        updatedAt: 1,
        modelSwitchCount: 0,
    };
}

function createProjection(snapshot = createSnapshot()): SessionTaskProjection {
    return new SessionTaskProjection(snapshot, vi.fn());
}

describe('user reads live task statuses in their own language', () => {
    beforeEach(() => {
        setLocale('zh-CN');
        let uuidIndex = 0;
        vi.spyOn(crypto, 'randomUUID').mockImplementation(
            () => `00000000-0000-4000-8000-${String(++uuidIndex).padStart(12, '0')}`
        );
    });

    it('user reads the failed request status in English', () => {
        setLocale('en-US');
        const snapshot = createSnapshot();
        const projection = createProjection(snapshot);

        projection.bootstrap([], 'Hello', []);
        projection.markFailed('Provider exploded');

        const statusMessage = snapshot.sessionHistory[snapshot.sessionHistory.length - 1];
        expect(statusMessage).toMatchObject({
            role: 'assistant',
            content: 'Request failed: Provider exploded',
            isError: true,
        });
        expect(statusMessage?.parts).toMatchObject([
            { type: 'text', content: 'Request failed: Provider exploded' },
        ]);
    });

    it('user reads known app-generated failure text in the active language', () => {
        setLocale('en-US');
        const snapshot = createSnapshot();
        const projection = createProjection(snapshot);

        projection.bootstrap([], 'Hello', []);
        projection.syncTaskMetadata({
            type: 'task_failed',
            taskId: 'task-1',
            turnId: 1,
            error: '模型返回了空回复，请尝试重新提问或更换模型',
        });

        const statusMessage = snapshot.sessionHistory[snapshot.sessionHistory.length - 1];
        expect(statusMessage).toMatchObject({
            role: 'assistant',
            content:
                'Request failed: The model returned an empty response. Try asking again or switch models.',
            isError: true,
        });
        expect(snapshot.error).toBe(
            'The model returned an empty response. Try asking again or switch models.'
        );
    });

    it('user sees unsupported image endpoint errors replaced with a friendly capability message', () => {
        setLocale('zh-CN');
        const snapshot = createSnapshot();
        const projection = createProjection(snapshot);

        projection.bootstrap([], 'Hello', []);
        projection.syncTaskMetadata({
            type: 'task_failed',
            taskId: 'task-1',
            turnId: 1,
            error: 'No endpoints found that support image input',
        });

        const statusMessage = snapshot.sessionHistory[snapshot.sessionHistory.length - 1];
        expect(statusMessage).toMatchObject({
            role: 'assistant',
            content: '请求失败: 当前模型不支持图片/文件输入，请选择合适模型继续。',
            isError: true,
        });
        expect(snapshot.error).toBe('当前模型不支持图片/文件输入，请选择合适模型继续。');
    });

    it('user reads the cancelled request status in English', () => {
        setLocale('en-US');
        const snapshot = createSnapshot();
        const projection = createProjection(snapshot);

        projection.bootstrap([], 'Hello', []);
        projection.markCancelled();

        const statusMessage = snapshot.sessionHistory[snapshot.sessionHistory.length - 1];
        expect(statusMessage).toMatchObject({
            role: 'assistant',
            content: 'Request cancelled',
            isCancelled: true,
        });
        expect(statusMessage?.parts).toMatchObject([
            { type: 'text', content: 'Request cancelled' },
        ]);
    });

    it('user reads the pending approval cancellation text in English', async () => {
        setLocale('en-US');
        const snapshot = createSnapshot();
        const projection = createProjection(snapshot);

        projection.bootstrap([], 'Hello', []);
        const decision = projection.requestToolApproval({
            callId: 'call-1',
            command: 'Remove-Item file.txt',
        } as never);

        projection.clearPendingApprovals();

        await expect(decision).resolves.toBe(false);
        expect(snapshot.pendingApprovals).toEqual([]);
        expect(snapshot.sessionHistory[1]?.approvals?.[0]).toMatchObject({
            callId: 'call-1',
            status: 'cancelled',
            resolutionText: 'Request cancelled',
        });
    });

    it('user sees built-in tool presentation updated from a structured call end', () => {
        setLocale('zh-CN');
        const snapshot = createSnapshot();
        const projection = createProjection(snapshot);

        projection.bootstrap([], '查一下 OpenClaw', []);
        projection.handleChunk({
            content: '',
            done: false,
            toolEvent: {
                type: 'call_start',
                callId: 'call-1',
                toolName: 'WebSearch',
                namespacedName: 'builtin__web_search',
                source: 'builtin',
                arguments: {
                    query: 'OpenClaw latest updates',
                    description: '搜索 OpenClaw 项目信息',
                },
                builtinConversationSemantic: {
                    action: 'search',
                    target: 'OpenClaw 项目信息',
                },
            },
        });
        projection.handleChunk({
            content: '',
            done: false,
            toolEvent: {
                type: 'call_end',
                callId: 'call-1',
                result: 'Web search\nQuery: OpenClaw latest updates',
                isError: false,
                durationMs: 10,
                finalStatus: 'completed',
                builtinConversationSemantic: {
                    action: 'search',
                    target: 'OpenClaw 项目信息 · GitHub',
                },
            },
        });

        const projectedMessage = snapshot.sessionHistory[1];
        expect(projectedMessage ? selectToolCalls(projectedMessage)[0] : undefined).toMatchObject({
            status: 'completed',
            builtinConversationSemantic: {
                action: 'search',
                target: 'OpenClaw 项目信息 · GitHub',
            },
            builtinPresentation: {
                content: 'OpenClaw 项目信息 · GitHub',
            },
        });
    });
});
