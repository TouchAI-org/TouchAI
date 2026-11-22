// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

export const RESULT_EXPORT_SCHEMA = 'touchai.result/v1';
export const MAX_RESULT_EXPORT_BYTES = 8 * 1024 * 1024;
export const RESULT_EXPORT_WARNING_BYTES = 4 * 1024 * 1024;
export const RESULT_EXPORT_RESOURCE_BUDGET_BYTES = 6 * 1024 * 1024;
export const RESULT_EXPORT_RESOURCE_TIMEOUT_MS = 8_000;

/**
 * Structural input from the presentation layer.
 *
 * Only text and widget parts are read. Extra session fields remain allowed here
 * so callers can pass their existing message model without widening this module
 * into the agent or UI layers.
 */
export interface ResultExportPart {
    readonly type: string;
    readonly id?: string;
    readonly content?: string;
    readonly widgetId?: string;
}

export interface ResultExportWidget {
    readonly widgetId: string;
    readonly title: string;
    readonly html: string;
    readonly phase: 'draft' | 'ready';
}

/** The small, presentation-only slice of a message that may be exported. */
export interface ResultExportMessage {
    role: 'assistant' | 'user';
    content?: string;
    parts: readonly ResultExportPart[];
    widgets?: readonly ResultExportWidget[];
}

export type ResultExportTheme = Readonly<Record<string, string>>;
export type ResultExportResourceFetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface ResultExportWidgetPresentation {
    theme: ResultExportTheme;
    themeFallbacks: ResultExportTheme;
    baseStyles: string;
    allowedResourceHosts: readonly string[];
}

export type ResultExportWarning = 'large-file' | 'online-resources';

export interface ResultExportDocument {
    html: string;
    bytes: number;
    warnings: ResultExportWarning[];
}

export type ResultExportErrorCode =
    | 'build-failed'
    | 'dialog-failed'
    | 'result-too-large'
    | 'sensitive-content'
    | 'write-failed';

export class ResultExportError extends Error {
    readonly code: ResultExportErrorCode;

    constructor(code: ResultExportErrorCode, message: string) {
        super(message);
        this.name = 'ResultExportError';
        this.code = code;
    }
}
