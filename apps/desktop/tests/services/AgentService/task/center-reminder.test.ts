import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as i18n from '@/i18n';
import { buildSessionStatusReminder } from '@/services/AgentService/task/center';
import type { SessionTaskSnapshot } from '@/services/AgentService/task/types';

function createSnapshot(overrides: Partial<SessionTaskSnapshot> = {}): SessionTaskSnapshot {
    return {
        taskId: 'task-1',
        sessionId: 1,
        turnId: null,
        status: 'running',
        executionMode: 'background',
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
        ...overrides,
    };
}

describe('SessionTaskCenter status reminders', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        i18n.setLocale('en-US');
    });

    it('treats non-US english locales as english for reminder separators', () => {
        vi.spyOn(i18n, 'getLocale').mockReturnValue('en-GB');

        const reminder = buildSessionStatusReminder(
            createSnapshot({
                status: 'completed',
                sessionHistory: [
                    {
                        id: 'assistant-en-gb',
                        role: 'assistant',
                        content:
                            '| Step | Result |\n| --- | --- |\n| lint | passed |\n| test | passed |',
                        parts: [],
                        timestamp: 1,
                    },
                ],
            })
        );

        expect(reminder?.body).toBe('Step, Result: lint, passed; test, passed');
    });

    it('creates an open reminder when a background task waits for a user question', () => {
        const reminder = buildSessionStatusReminder(
            createSnapshot({
                status: 'waiting_approval',
                pendingUserQuestion: {
                    callId: 'question-call',
                    sourceMessageId: 'assistant-1',
                    createdAt: 1,
                    questions: [
                        {
                            question: 'Pick the deployment target',
                            header: 'Deploy',
                            options: [{ label: 'Staging' }, { label: 'Production' }],
                        },
                    ],
                },
            })
        );

        expect(reminder).toEqual({
            kind: 'waiting_approval',
            title: 'Waiting for response',
            body: 'Pick the deployment target',
            approval: null,
        });
    });

    it('sanitizes markdown from completed assistant summaries before notifying', () => {
        const reminder = buildSessionStatusReminder(
            createSnapshot({
                status: 'completed',
                sessionHistory: [
                    {
                        id: 'assistant-1',
                        role: 'assistant',
                        content:
                            '# Done\n- Fixed **alert** flow\n- Review [diff](https://example.com)\n`pnpm test`',
                        parts: [],
                        timestamp: 1,
                    },
                ],
            })
        );

        expect(reminder).toEqual({
            kind: 'completed',
            title: 'Task completed',
            body: 'Done: Fixed alert flow, Review diff, pnpm test',
            approval: null,
            replyPlaceholder: 'Reply to TouchAI',
            replyLabel: 'Reply',
        });
    });

    it('sanitizes escaped markdown from completed assistant summaries before notifying', () => {
        const reminder = buildSessionStatusReminder(
            createSnapshot({
                status: 'completed',
                sessionHistory: [
                    {
                        id: 'assistant-escaped',
                        role: 'assistant',
                        content:
                            '\\#\\#\\# \\*\\*🎯 10. 关键实现要点（续）\\*\\* 1. \\*\\*数据预处理\\*\\*：统一图像尺寸（建议224x224）',
                        parts: [],
                        timestamp: 2,
                    },
                ],
            })
        );

        expect(reminder).toEqual({
            kind: 'completed',
            title: 'Task completed',
            body: '🎯 10. 关键实现要点（续） 1. 数据预处理：统一图像尺寸（建议224x224）',
            approval: null,
            replyPlaceholder: 'Reply to TouchAI',
            replyLabel: 'Reply',
        });
    });

    it('prefers sanitized failure text over raw markdown error output', () => {
        const reminder = buildSessionStatusReminder(
            createSnapshot({
                status: 'failed',
                error: '```bash\nnpm run lint\n```\n[logs](https://example.com) failed',
            })
        );

        expect(reminder).toEqual({
            kind: 'failed',
            title: 'Task failed',
            body: 'npm run lint; logs failed',
            approval: null,
            replyPlaceholder: 'Reply to TouchAI',
            replyLabel: 'Reply',
        });
    });

    it('keeps inline angle-bracket diagnostics in failure notifications', () => {
        const reminder = buildSessionStatusReminder(
            createSnapshot({
                status: 'failed',
                error: 'Assertion failed: expected <title> to equal <h1>',
            })
        );

        expect(reminder).toEqual({
            kind: 'failed',
            title: 'Task failed',
            body: 'Assertion failed: expected <title> to equal <h1>',
            approval: null,
            replyPlaceholder: 'Reply to TouchAI',
            replyLabel: 'Reply',
        });
    });

    it('strips real inline html tags while preserving readable failure text', () => {
        const reminder = buildSessionStatusReminder(
            createSnapshot({
                status: 'failed',
                error: 'Failure: <strong>prod</strong><br>See <a href="https://example.com">logs</a>',
            })
        );

        expect(reminder).toEqual({
            kind: 'failed',
            title: 'Task failed',
            body: 'Failure: prod; See logs',
            approval: null,
            replyPlaceholder: 'Reply to TouchAI',
            replyLabel: 'Reply',
        });
    });

    it('drops script-like html blocks from failure notifications', () => {
        const reminder = buildSessionStatusReminder(
            createSnapshot({
                status: 'failed',
                error: 'Failure<script>alert(1)</script><style>body{display:none}</style>See logs',
            })
        );

        expect(reminder).toEqual({
            kind: 'failed',
            title: 'Task failed',
            body: 'Failure See logs',
            approval: null,
            replyPlaceholder: 'Reply to TouchAI',
            replyLabel: 'Reply',
        });
    });

    it('drops standalone dangerous html tags from failure notifications', () => {
        const reminder = buildSessionStatusReminder(
            createSnapshot({
                status: 'failed',
                error: 'Failure<script>alert(1)</script></script><iframe>See logs',
            })
        );

        expect(reminder).toEqual({
            kind: 'failed',
            title: 'Task failed',
            body: 'Failure See logs',
            approval: null,
            replyPlaceholder: 'Reply to TouchAI',
            replyLabel: 'Reply',
        });
    });

    it('sanitizes approval reminders while keeping a literal command preview', () => {
        const reminder = buildSessionStatusReminder(
            createSnapshot({
                status: 'waiting_approval',
                pendingToolApproval: {
                    callId: 'call-1',
                    messageId: 'assistant-1',
                    title: 'Need approval',
                    description: 'Run deployment',
                    command: '```bash\nnpm run deploy -- --env prod\n```',
                    riskLabel: 'High risk',
                    reason: '- Deploy **production** build',
                    approveLabel: 'Approve',
                    rejectLabel: 'Reject',
                    enterHint: 'Enter to approve',
                    escHint: 'Esc to reject',
                    keyboardApproveAt: 1,
                },
            })
        );

        expect(reminder).toEqual({
            kind: 'waiting_approval',
            title: 'Pending',
            body: 'Deploy production build. Command: npm run deploy -- --env prod',
            approval: {
                callId: 'call-1',
                approveLabel: 'Approve',
                rejectLabel: 'Reject',
            },
        });
    });

    it('keeps command previews visible when approval reasons are long', () => {
        const reminder = buildSessionStatusReminder(
            createSnapshot({
                status: 'waiting_approval',
                pendingToolApproval: {
                    callId: 'call-1a',
                    messageId: 'assistant-1a',
                    title: 'Need approval',
                    description: 'Run deployment',
                    command: 'npm run deploy -- --env prod',
                    riskLabel: 'High risk',
                    reason: 'Deploy production build after validating migrations, smoke tests, asset upload checks, rollout annotations, and environment-specific configuration values for the release candidate branch.',
                    approveLabel: 'Approve',
                    rejectLabel: 'Reject',
                    enterHint: 'Enter to approve',
                    escHint: 'Esc to reject',
                    keyboardApproveAt: 1,
                },
            })
        );

        expect(reminder?.body).toContain('Command: npm run deploy -- --env prod');
        expect(reminder?.body?.length).toBeLessThanOrEqual(220);
    });

    it('keeps bracketed log prefixes that are not markdown reference links', () => {
        const reminder = buildSessionStatusReminder(
            createSnapshot({
                status: 'failed',
                error: '[ERROR]: deployment failed',
            })
        );

        expect(reminder).toEqual({
            kind: 'failed',
            title: 'Task failed',
            body: '[ERROR]: deployment failed',
            approval: null,
            replyPlaceholder: 'Reply to TouchAI',
            replyLabel: 'Reply',
        });
    });

    it('does not strip non-markdown path and glob characters from approval content', () => {
        const reminder = buildSessionStatusReminder(
            createSnapshot({
                status: 'waiting_approval',
                pendingToolApproval: {
                    callId: 'call-2',
                    messageId: 'assistant-2',
                    title: 'Need approval',
                    description: 'Inspect __tests__/center.test.ts and packages/**/src',
                    command: 'rg "__tests__/center.test.ts" packages/**/src',
                    riskLabel: 'Medium risk',
                    reason: 'Check __tests__/center.test.ts before touching packages/**/src',
                    approveLabel: 'Approve',
                    rejectLabel: 'Reject',
                    enterHint: 'Enter to approve',
                    escHint: 'Esc to reject',
                    keyboardApproveAt: 1,
                },
            })
        );

        expect(reminder).toEqual({
            kind: 'waiting_approval',
            title: 'Pending',
            body: 'Check __tests__/center.test.ts before touching packages/**/src. Command: rg "__tests__/center.test.ts" packages/**/src',
            approval: {
                callId: 'call-2',
                approveLabel: 'Approve',
                rejectLabel: 'Reject',
            },
        });
    });

    it('preserves markdown markers inside scoped package paths in approval content', () => {
        const reminder = buildSessionStatusReminder(
            createSnapshot({
                status: 'waiting_approval',
                pendingToolApproval: {
                    callId: 'call-2a',
                    messageId: 'assistant-2a',
                    title: 'Need approval',
                    description: 'Inspect packages/@touchai/core/__tests__/center.test.ts',
                    command: 'rg "center" packages/@touchai/core/__tests__/center.test.ts',
                    riskLabel: 'Medium risk',
                    reason: 'Check packages/@touchai/core/__tests__/center.test.ts before editing',
                    approveLabel: 'Approve',
                    rejectLabel: 'Reject',
                    enterHint: 'Enter to approve',
                    escHint: 'Esc to reject',
                    keyboardApproveAt: 1,
                },
            })
        );

        expect(reminder).toEqual({
            kind: 'waiting_approval',
            title: 'Pending',
            body: 'Check packages/@touchai/core/__tests__/center.test.ts before editing. Command: rg "center" packages/@touchai/core/__tests__/center.test.ts',
            approval: {
                callId: 'call-2a',
                approveLabel: 'Approve',
                rejectLabel: 'Reject',
            },
        });
    });

    it('preserves windows paths and escaped markdown markers in approval content', () => {
        const reminder = buildSessionStatusReminder(
            createSnapshot({
                status: 'waiting_approval',
                pendingToolApproval: {
                    callId: 'call-2b',
                    messageId: 'assistant-2b',
                    title: 'Need approval',
                    description: 'Inspect C:\\Users\\admin\\__tests__\\center.test.ts',
                    command:
                        'rg "C:\\Users\\admin\\__tests__\\center.test.ts" D:\\work\\packages\\**\\src',
                    riskLabel: 'Medium risk',
                    reason: 'Check C:\\Users\\admin\\__tests__\\center.test.ts before touching D:\\work\\packages\\**\\src',
                    approveLabel: 'Approve',
                    rejectLabel: 'Reject',
                    enterHint: 'Enter to approve',
                    escHint: 'Esc to reject',
                    keyboardApproveAt: 1,
                },
            })
        );

        expect(reminder).toEqual({
            kind: 'waiting_approval',
            title: 'Pending',
            body: 'Check C:\\Users\\admin\\__tests__\\center.test.ts before touching D:\\work\\packages\\**\\src. Command: rg "C:\\Users\\admin\\__tests__\\center.test.ts" D:\\work\\packages\\**\\src',
            approval: {
                callId: 'call-2b',
                approveLabel: 'Approve',
                rejectLabel: 'Reject',
            },
        });
    });

    it('keeps shell pipelines intact in command previews', () => {
        const reminder = buildSessionStatusReminder(
            createSnapshot({
                status: 'waiting_approval',
                pendingToolApproval: {
                    callId: 'call-3',
                    messageId: 'assistant-3',
                    title: 'Need approval',
                    description: 'Inspect logs',
                    command: 'cat app.log | grep ERROR | head -n 20',
                    riskLabel: 'Low risk',
                    reason: 'Inspect logs quickly',
                    approveLabel: 'Approve',
                    rejectLabel: 'Reject',
                    enterHint: 'Enter to approve',
                    escHint: 'Esc to reject',
                    keyboardApproveAt: 1,
                },
            })
        );

        expect(reminder).toEqual({
            kind: 'waiting_approval',
            title: 'Pending',
            body: 'Inspect logs quickly. Command: cat app.log | grep ERROR | head -n 20',
            approval: {
                callId: 'call-3',
                approveLabel: 'Approve',
                rejectLabel: 'Reject',
            },
        });
    });

    it('preserves markdown-looking shell syntax in command previews', () => {
        const reminder = buildSessionStatusReminder(
            createSnapshot({
                status: 'waiting_approval',
                pendingToolApproval: {
                    callId: 'call-3a',
                    messageId: 'assistant-3a',
                    title: 'Need approval',
                    description: 'Review shell redirection',
                    command: 'cat <<EOF>out.txt\necho \u201c<tag>\u201d\n>out.txt',
                    riskLabel: 'Medium risk',
                    reason: 'Review shell redirection',
                    approveLabel: 'Approve',
                    rejectLabel: 'Reject',
                    enterHint: 'Enter to approve',
                    escHint: 'Esc to reject',
                    keyboardApproveAt: 1,
                },
            })
        );

        expect(reminder).toEqual({
            kind: 'waiting_approval',
            title: 'Pending',
            body: 'Review shell redirection. Command: cat <<EOF>out.txt echo "<tag>" >out.txt',
            approval: {
                callId: 'call-3a',
                approveLabel: 'Approve',
                rejectLabel: 'Reject',
            },
        });
    });

    it('still flattens markdown table rows into readable notification text', () => {
        const reminder = buildSessionStatusReminder(
            createSnapshot({
                status: 'completed',
                sessionHistory: [
                    {
                        id: 'assistant-2',
                        role: 'assistant',
                        content:
                            '| Step | Result |\n| --- | --- |\n| lint | passed |\n| test | passed |',
                        parts: [],
                        timestamp: 2,
                    },
                ],
            })
        );

        expect(reminder).toEqual({
            kind: 'completed',
            title: 'Task completed',
            body: 'Step, Result: lint, passed; test, passed',
            approval: null,
            replyPlaceholder: 'Reply to TouchAI',
            replyLabel: 'Reply',
        });
    });

    it('turns markdown-heavy completion output into plain-text notification content', () => {
        const reminder = buildSessionStatusReminder(
            createSnapshot({
                status: 'completed',
                sessionHistory: [
                    {
                        id: 'assistant-markdown-heavy',
                        role: 'assistant',
                        content: `## 🧠 LangChain Memory（记忆管理）详细实现

### **📋 1. Memory 核心概念**
Memory 是 LangChain 中管理对话历史和上下文的组件，负责在多轮对话中保持状态。

Memory类型 | 作用 | 适用场景
--- | --- | ---
BufferMemory | 短期记忆 | 简单聊天`,
                        parts: [],
                        timestamp: 3,
                    },
                ],
            })
        );

        expect(reminder).toEqual({
            kind: 'completed',
            title: 'Task completed',
            body: '🧠 LangChain Memory（记忆管理）详细实现: 📋 1. Memory 核心概念; Memory 是 LangChain 中管理对话历史和上下文的组件，负责在多轮对话中保持状态。 Memory类型, 作用, 适用场景',
            approval: null,
            replyPlaceholder: 'Reply to TouchAI',
            replyLabel: 'Reply',
        });
    });
});
