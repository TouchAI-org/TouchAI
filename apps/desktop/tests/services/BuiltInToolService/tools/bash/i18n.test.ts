import { beforeEach, describe, expect, it } from 'vitest';

import { setLocale } from '@/i18n';
import { createBashApprovalRequest } from '@/services/BuiltInToolService/tools/bash';
import { DEFAULT_BASH_TOOL_CONFIG } from '@/services/BuiltInToolService/tools/bash/constants';
import { formatBashToolResult } from '@/services/BuiltInToolService/tools/bash/helper';
import type { BuiltInBashExecutionResponse } from '@/services/NativeService';

describe('user approves a shell command in their own language', () => {
    beforeEach(() => {
        setLocale('zh-CN');
    });

    it('user reads the shell approval request in English', async () => {
        setLocale('en-US');

        const approval = await createBashApprovalRequest(
            {
                command: 'Write-Output hello',
                reason: 'Show the current greeting.',
            },
            {
                ...DEFAULT_BASH_TOOL_CONFIG,
                approvalMode: 'always',
                defaultWorkingDirectory: 'E:\\codex-worktrees\\TouchAI',
            }
        );

        expect(approval).toMatchObject({
            title: 'Confirm command execution',
            description: 'Show the current greeting.',
            command: 'Write-Output hello',
            reason: 'Current configuration requires approval before every Bash command.',
            approveLabel: 'Approve',
            rejectLabel: 'Reject',
        });
    });

    it('user reads empty command output in English', () => {
        setLocale('en-US');

        const result = formatBashToolResult(
            {
                command: 'Write-Output ""',
                shell: 'powershell',
                workingDirectory: 'E:\\codex-worktrees\\TouchAI',
                exitCode: 0,
                success: true,
                timedOut: false,
                cancelled: false,
                durationMs: 32,
                stdout: '',
                stderr: '',
                combinedOutput: '',
            } satisfies BuiltInBashExecutionResponse,
            {
                command: 'Write-Output ""',
                workingDirectory: 'E:\\codex-worktrees\\TouchAI',
                rawOutput: false,
            },
            1000
        );

        expect(result).toContain('[No command output]');
        expect(result).not.toContain('[命令无输出]');
    });
});
