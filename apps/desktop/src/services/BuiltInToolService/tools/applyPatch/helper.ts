// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type {
    BuiltInApplyPatchExecutionResponse,
    BuiltInApplyPatchFileChange,
    BuiltInApplyPatchFilePreview,
} from '@services/NativeService';

const APPLY_PATCH_RESULT_START = '<<<APPLY_PATCH_RESULT';
const APPLY_PATCH_RESULT_END = 'APPLY_PATCH_RESULT>>>';

interface ApplyPatchToolResultPayload {
    workingDirectory: string;
    changedFiles: BuiltInApplyPatchFileChange[];
}

export interface ParsedApplyPatchToolResult {
    summary: string | null;
    workingDirectory: string | null;
    changedFiles: BuiltInApplyPatchFileChange[];
}

export function formatApplyPatchToolResult(response: BuiltInApplyPatchExecutionResponse): string {
    const payload: ApplyPatchToolResultPayload = {
        workingDirectory: response.workingDirectory,
        changedFiles: response.changedFiles.map((change) => ({
            ...change,
            preview: normalizePreview(change.preview),
        })),
    };

    const payloadText = JSON.stringify(payload);
    const summary = response.summary.trim();
    if (!summary) {
        return [APPLY_PATCH_RESULT_START, payloadText, APPLY_PATCH_RESULT_END].join('\n');
    }

    return [summary, '', APPLY_PATCH_RESULT_START, payloadText, APPLY_PATCH_RESULT_END].join('\n');
}

export function parseApplyPatchToolResult(result?: string): ParsedApplyPatchToolResult {
    const raw = result?.trim();
    if (!raw) {
        return {
            summary: null,
            workingDirectory: null,
            changedFiles: [],
        };
    }

    const startIndex = raw.indexOf(APPLY_PATCH_RESULT_START);
    if (startIndex < 0) {
        return {
            summary: raw,
            workingDirectory: null,
            changedFiles: [],
        };
    }

    const endIndex = raw.indexOf(
        APPLY_PATCH_RESULT_END,
        startIndex + APPLY_PATCH_RESULT_START.length
    );
    if (endIndex < 0) {
        return {
            summary: raw,
            workingDirectory: null,
            changedFiles: [],
        };
    }

    const summary = raw.slice(0, startIndex).trim() || null;
    const payloadText = raw.slice(startIndex + APPLY_PATCH_RESULT_START.length, endIndex).trim();

    try {
        const payload = JSON.parse(payloadText) as unknown;
        if (!isApplyPatchToolResultPayload(payload)) {
            return {
                summary: raw,
                workingDirectory: null,
                changedFiles: [],
            };
        }

        return {
            summary,
            workingDirectory: payload.workingDirectory,
            changedFiles: payload.changedFiles.map((change) => ({
                ...change,
                preview: normalizePreview(change.preview),
            })),
        };
    } catch {
        return {
            summary: raw,
            workingDirectory: null,
            changedFiles: [],
        };
    }
}

function isApplyPatchToolResultPayload(value: unknown): value is ApplyPatchToolResultPayload {
    if (!value || typeof value !== 'object') {
        return false;
    }

    const candidate = value as Partial<ApplyPatchToolResultPayload>;
    return (
        typeof candidate.workingDirectory === 'string' &&
        Array.isArray(candidate.changedFiles) &&
        candidate.changedFiles.every(isApplyPatchFileChange)
    );
}

function isApplyPatchFileChange(value: unknown): value is BuiltInApplyPatchFileChange {
    if (!value || typeof value !== 'object') {
        return false;
    }

    const candidate = value as Partial<BuiltInApplyPatchFileChange>;
    return (
        typeof candidate.path === 'string' &&
        (candidate.newPath === null || typeof candidate.newPath === 'string') &&
        (candidate.operation === 'add' ||
            candidate.operation === 'update' ||
            candidate.operation === 'delete' ||
            candidate.operation === 'move')
    );
}

function normalizePreview(
    preview: BuiltInApplyPatchFilePreview | null | undefined
): BuiltInApplyPatchFilePreview | null {
    if (!preview) {
        return null;
    }

    return {
        beforeContent: preview.beforeContent ?? null,
        afterContent: preview.afterContent ?? null,
        beforeTruncated: preview.beforeTruncated === true,
        afterTruncated: preview.afterTruncated === true,
        isBinary: preview.isBinary === true,
        omitted: preview.omitted === true,
    };
}
