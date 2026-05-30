import type { BuiltInApplyPatchExecutionResponse } from '@services/NativeService';
import { getLastTauriInvokeCall, mockTauriCommand } from '@tests/utils/tauri';
import { beforeEach, describe, expect, it } from 'vitest';

import {
    createApplyPatchApprovalRequest,
    executeApplyPatchTool,
} from '@/services/BuiltInToolService/tools/applyPatch';
import { parseApplyPatchToolResult } from '@/services/BuiltInToolService/tools/applyPatch';
import type { BaseBuiltInToolExecutionContext } from '@/services/BuiltInToolService/types';

const PATCH = [
    '*** Begin Patch',
    '*** Update File: src/example.ts',
    '@@',
    ' const value = 1;',
    '-export const oldValue = value;',
    '+export const newValue = value;',
    '*** End Patch',
].join('\n');

const MOCK_RESPONSE: BuiltInApplyPatchExecutionResponse = {
    success: true,
    workingDirectory: 'D:/project',
    changedFiles: [
        {
            path: 'src/example.ts',
            newPath: null,
            operation: 'update',
            preview: {
                beforeContent: 'const value = 1;\nexport const oldValue = value;\n',
                afterContent: 'const value = 1;\nexport const newValue = value;\n',
                beforeTruncated: false,
                afterTruncated: false,
                isBinary: false,
                omitted: false,
            },
        },
    ],
    summary: '已在 D:/project 应用补丁\n- 修改 src/example.ts',
};

function fakeContext(): BaseBuiltInToolExecutionContext {
    return {
        callId: 'call-1',
        signal: undefined,
        iteration: 0,
        hasExecutedBuiltInTool: () => false,
    };
}

describe('executeApplyPatchTool', () => {
    beforeEach(() => {
        mockTauriCommand('built_in_tools_apply_patch', MOCK_RESPONSE);
    });

    it('passes patch and workingDirectory to the native request', async () => {
        const result = await executeApplyPatchTool(
            {
                patch: PATCH,
                workingDirectory: 'D:/project',
                reason: 'Update the exported value name.',
            },
            {},
            fakeContext()
        );

        expect(result.result).toBe(MOCK_RESPONSE.summary);
        expect(result.isError).toBe(false);
        expect(result.status).toBe('success');
        expect(result.displayResult).toBeTypeOf('string');
        expect(parseApplyPatchToolResult(result.displayResult ?? undefined).changedFiles).toEqual(
            MOCK_RESPONSE.changedFiles
        );
        expect(getLastTauriInvokeCall('built_in_tools_apply_patch')?.payload).toEqual({
            request: {
                patch: PATCH,
                workingDirectory: 'D:/project',
            },
        });
    });

    it('returns a structured error result when native apply fails', async () => {
        mockTauriCommand('built_in_tools_apply_patch', () => {
            throw new Error('Hunk context not found in src/example.ts');
        });

        await expect(
            executeApplyPatchTool(
                {
                    patch: PATCH,
                    workingDirectory: 'D:/project',
                    reason: 'Update the exported value name.',
                },
                {},
                fakeContext()
            )
        ).resolves.toEqual({
            result: '补丁应用失败：Hunk context not found in src/example.ts',
            isError: true,
            status: 'error',
            errorMessage: 'Hunk context not found in src/example.ts',
        });
    });
});

describe('createApplyPatchApprovalRequest', () => {
    it('summarizes the workspace and patch targets', () => {
        expect(
            createApplyPatchApprovalRequest({
                patch: PATCH,
                workingDirectory: 'D:/project',
                reason: 'Update the exported value name.',
            })
        ).toEqual(
            expect.objectContaining({
                title: '文件修改确认',
                description: 'Update the exported value name.',
                command: '工作目录: D:/project\n变更目标: 修改 src/example.ts',
            })
        );
    });

    it('shows move targets and normalizes backslashes', () => {
        expect(
            createApplyPatchApprovalRequest({
                patch: [
                    '*** Begin Patch',
                    '*** Update File: src\\old.ts',
                    '*** Move to: src\\new.ts',
                    '*** End Patch',
                ].join('\n'),
                workingDirectory: 'D:/project',
                reason: 'Rename the file.',
            })
        ).toEqual(
            expect.objectContaining({
                command: ['工作目录: D:/project', '变更目标: 移动 src/old.ts → src/new.ts'].join(
                    '\n'
                ),
            })
        );
    });

    it('returns null for invalid arguments', () => {
        expect(createApplyPatchApprovalRequest({ patch: PATCH })).toBeNull();
    });
});
