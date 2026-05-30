import type { BuiltInApplyPatchExecutionResponse } from '@services/NativeService';
import { describe, expect, it } from 'vitest';

import {
    formatApplyPatchToolResult,
    parseApplyPatchToolResult,
} from '@/services/BuiltInToolService/tools/applyPatch/helper';

const RESPONSE: BuiltInApplyPatchExecutionResponse = {
    success: true,
    workingDirectory: 'D:/project',
    changedFiles: [
        {
            path: 'src/example.ts',
            newPath: null,
            operation: 'update',
            preview: {
                beforeContent: 'before\n',
                afterContent: 'after\n',
                beforeTruncated: false,
                afterTruncated: true,
                isBinary: false,
                omitted: false,
            },
        },
    ],
    summary: '已在 D:/project 应用补丁\n- 修改 src/example.ts',
};

describe('applyPatch helper', () => {
    it('formats and parses a structured tool result', () => {
        const result = formatApplyPatchToolResult(RESPONSE);
        const parsed = parseApplyPatchToolResult(result);

        expect(parsed.summary).toBe(RESPONSE.summary);
        expect(parsed.workingDirectory).toBe(RESPONSE.workingDirectory);
        expect(parsed.changedFiles).toEqual(RESPONSE.changedFiles);
    });

    it('falls back to plain text when no structured payload exists', () => {
        expect(parseApplyPatchToolResult('plain result')).toEqual({
            summary: 'plain result',
            workingDirectory: null,
            changedFiles: [],
        });
    });
});
