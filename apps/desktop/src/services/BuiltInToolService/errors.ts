// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { log } from '@services/ObservabilityService';

export type ToolFailureStatus = 'error' | 'timeout';

export interface ToolFailure {
    message: string;
    status: ToolFailureStatus;
}

/**
 * An error whose message is intentionally safe to show to the user and model.
 *
 * Keep this marker on errors raised by the owning tool for invalid input, policy
 * decisions, and configured API failures. Native, database, transport, and unknown
 * exceptions must stay unmarked so the service boundary can replace their text.
 */
export class ToolUserFacingError extends Error {
    readonly cause?: unknown;

    constructor(message: string, options: { cause?: unknown } = {}) {
        super(message);
        this.name = 'ToolUserFacingError';
        this.cause = options.cause;
    }
}

export function isToolTimeoutError(error: unknown): boolean {
    return error instanceof DOMException && error.name === 'TimeoutError';
}

/** Keep remote status text useful without allowing control characters or unbounded text. */
export function formatHttpStatus(status: number, statusText = ''): string {
    // `String.prototype.replace` with a control-character regex trips the project's
    // no-control-regex rule, so filter by code point instead.
    const safeText = [...statusText]
        .map((character) => {
            const code = character.codePointAt(0) ?? 0;
            return code < 0x20 || code === 0x7f ? ' ' : character;
        })
        .join('')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80);
    return `HTTP ${status}${safeText ? ` ${safeText}` : ''}`;
}

export function resolveToolFailure(
    error: unknown,
    options: {
        toolId: string;
        fallbackMessage: string;
        timeoutMessage?: string;
    }
): ToolFailure {
    if (error instanceof ToolUserFacingError) {
        return { message: error.message, status: 'error' };
    }

    if (isToolTimeoutError(error)) {
        log.warn(`[BuiltInTool:${options.toolId}] Tool timed out`, error);
        return {
            message: options.timeoutMessage ?? options.fallbackMessage,
            status: 'timeout',
        };
    }

    log.error(`[BuiltInTool:${options.toolId}] Tool failed`, error);
    return { message: options.fallbackMessage, status: 'error' };
}
