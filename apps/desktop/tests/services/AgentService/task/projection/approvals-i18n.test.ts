import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import { ProjectionUserPrompts } from '@/services/AgentService/task/projection/userPrompts';
import type { SessionMessage } from '@/types/session';

function createAssistantMessage(): SessionMessage {
    return {
        id: 'message-1',
        role: 'assistant',
        content: '',
        parts: [],
        timestamp: 1,
    };
}

describe('ProjectionUserPrompts i18n defaults', () => {
    beforeEach(() => {
        setLocale('zh-CN');
        vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000001');
    });

    it('keeps default approval fields as source text when the active locale is English', () => {
        setLocale('en-US');
        const approvals = new ProjectionUserPrompts();
        const history = [createAssistantMessage()];

        const approval = approvals.presentApproval(history, 'message-1', {
            callId: 'call-1',
            description: '',
            command: 'Remove-Item file.txt',
            riskLabel: '',
            reason: '',
            commandLabel: '',
            approveLabel: '',
            rejectLabel: '',
            enterHint: '',
            escHint: '',
            title: undefined as never,
        });

        expect(approval).toMatchObject({
            title: '命令执行需要确认',
            description: '',
            riskLabel: '',
            reason: '',
            commandLabel: '',
            approveLabel: '',
            rejectLabel: '',
            enterHint: '',
            escHint: '',
        });
    });

    it('keeps omitted default approval labels as source text for live locale rendering', () => {
        setLocale('en-US');
        const approvals = new ProjectionUserPrompts();
        const history = [createAssistantMessage()];

        const approval = approvals.presentApproval(history, 'message-1', {
            callId: 'call-1',
            command: 'Remove-Item file.txt',
        } as never);

        expect(approval).toMatchObject({
            title: '命令执行需要确认',
            description: '这是一个高风险命令，请确认后再继续执行。',
            riskLabel: '高风险',
            reason: '命令可能修改文件或系统状态。',
            commandLabel: '命令预览',
            approveLabel: '批准执行',
            rejectLabel: '拒绝执行',
            enterHint: 'Enter 批准',
            escHint: 'Esc 拒绝',
        });
        expect(history[0]?.parts).toMatchObject([{ type: 'approval', callId: 'call-1' }]);
    });

    it('canonicalizes translated app-owned payload labels back to source text', () => {
        setLocale('en-US');
        const approvals = new ProjectionUserPrompts();
        const history = [createAssistantMessage()];

        const approval = approvals.presentApproval(history, 'message-1', {
            callId: 'call-1',
            title: 'Confirm command execution',
            description: '',
            command: 'Remove-Item file.txt',
            riskLabel: '',
            reason: 'The command may delete files or directories.',
            commandLabel: '',
            approveLabel: 'Approve',
            rejectLabel: 'Reject',
            enterHint: 'Enter',
            escHint: 'Esc',
        });

        expect(approval).toMatchObject({
            title: '命令执行确认',
            reason: '命令可能删除文件或目录。',
            approveLabel: '批准',
            rejectLabel: '拒绝',
            enterHint: 'Enter',
            escHint: 'Esc',
        });
    });

    it('canonicalizes translated setting approval text back to source text', () => {
        setLocale('en-US');
        const approvals = new ProjectionUserPrompts();
        const history = [createAssistantMessage()];

        const approval = approvals.presentApproval(history, 'message-1', {
            callId: 'call-1',
            title: 'Confirm setting change',
            description: 'Update language to English',
            command: 'Language: zh-CN -> en-US',
            riskLabel: '',
            reason: 'This operation changes TouchAI application settings and affects future behavior immediately.',
            commandLabel: '',
            approveLabel: 'Approve',
            rejectLabel: 'Reject',
            enterHint: 'Enter',
            escHint: 'Esc',
        });

        expect(approval).toMatchObject({
            title: '设置修改确认',
            description: 'Update language to English',
            reason: '此操作会修改 TouchAI 的应用设置，并立即影响后续行为。',
            approveLabel: '批准',
            rejectLabel: '拒绝',
        });
    });

    it('settles approval with source-key default resolution text', async () => {
        setLocale('en-US');
        const approvals = new ProjectionUserPrompts();
        const history = [createAssistantMessage()];

        const decision = approvals.requestApproval(history, 'message-1', {
            callId: 'call-1',
            command: 'Remove-Item file.txt',
        } as never);

        const settlement = approvals.settleApproval('call-1', true);

        await expect(decision).resolves.toBe(true);
        expect(settlement).toMatchObject({
            approved: true,
            resolutionText: '已批准执行此命令',
            isCancellationResolution: false,
        });
    });
});
