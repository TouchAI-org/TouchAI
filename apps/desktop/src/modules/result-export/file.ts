// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import {
    buildResultExportDocument,
    containsHighConfidenceCredential,
    containsHighConfidenceCredentialText,
} from './document';
import {
    MAX_RESULT_EXPORT_BYTES,
    RESULT_EXPORT_WARNING_BYTES,
    type ResultExportDocument,
    ResultExportError,
    type ResultExportErrorCode,
    type ResultExportMessage,
    type ResultExportResourceFetcher,
    type ResultExportWidgetPresentation,
} from './types';

const RESULT_EXPORT_WRAPPER_MARGIN_BYTES = 64 * 1024;

export interface PrepareResultExportOptions {
    message: ResultExportMessage;
    presentation: ResultExportWidgetPresentation;
    fetchResource?: ResultExportResourceFetcher;
}

function pad(value: number): string {
    return String(value).padStart(2, '0');
}

export function formatResultExportFilename(now: Date): string {
    return `TouchAI-result-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(
        now.getDate()
    )}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.html`;
}

function exportError(code: ResultExportErrorCode, message: string): ResultExportError {
    return new ResultExportError(code, message);
}

function visibleTextBytes(message: ResultExportMessage): number {
    const encoder = new TextEncoder();
    return message.parts.reduce(
        (bytes, part) =>
            part.type === 'text' ? bytes + encoder.encode(part.content).byteLength : bytes,
        message.parts.some((part) => part.type === 'text') || !message.content?.trim()
            ? 0
            : encoder.encode(message.content).byteLength
    );
}

export async function prepareResultExport({
    message,
    presentation,
    fetchResource,
}: PrepareResultExportOptions): Promise<ResultExportDocument> {
    if (containsHighConfidenceCredential(message)) {
        throw exportError('sensitive-content', 'Sensitive credentials cannot be exported.');
    }
    // The document wrapper alone exceeds this margin, so an oversized text body
    // cannot fit under the hard limit. Block before spending work on Markdown.
    if (visibleTextBytes(message) > MAX_RESULT_EXPORT_BYTES - RESULT_EXPORT_WRAPPER_MARGIN_BYTES) {
        throw exportError('result-too-large', 'The result exceeds the 8 MiB export limit.');
    }

    let document: Awaited<ReturnType<typeof buildResultExportDocument>>;
    try {
        document = await buildResultExportDocument({ message, presentation, fetchResource });
    } catch (error) {
        if (error instanceof ResultExportError) throw error;
        throw exportError(
            'build-failed',
            error instanceof Error ? error.message : 'Could not build the result document.'
        );
    }
    if (containsHighConfidenceCredentialText(document.html)) {
        throw exportError('sensitive-content', 'Sensitive credentials cannot be exported.');
    }
    if (document.bytes > MAX_RESULT_EXPORT_BYTES) {
        throw exportError('result-too-large', 'The result exceeds the 8 MiB export limit.');
    }

    const warnings = [...document.warnings];
    if (document.bytes > RESULT_EXPORT_WARNING_BYTES && !warnings.includes('large-file')) {
        warnings.push('large-file');
    }
    return { ...document, warnings };
}
