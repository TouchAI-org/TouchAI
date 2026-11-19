import { AiError } from '@touchai/models/contracts';

import { AgentError } from '../contracts/agent';

export const MAX_REQUEST_RETRIES = 5;
const RETRYABLE_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

export function classifyFailure(error: unknown, signal: AbortSignal): AgentError {
    const visited = new Set<unknown>();
    while (
        typeof error === 'object' &&
        error !== null &&
        'lastError' in error &&
        !visited.has(error)
    ) {
        visited.add(error);
        if (error.lastError === undefined) break;
        error = error.lastError;
    }
    if (signal.aborted) return new AgentError('REQUEST_CANCELLED', false, { cause: error });
    if (error instanceof AgentError) return error;
    if (error instanceof AiError) {
        const status =
            typeof error.details === 'object' &&
            error.details !== null &&
            'statusCode' in error.details
                ? error.details.statusCode
                : undefined;
        return new AgentError(
            error.code,
            error.isRetryable() || (typeof status === 'number' && RETRYABLE_STATUSES.has(status)),
            { cause: error }
        );
    }
    if (error instanceof Error && error.name === 'AbortError')
        return new AgentError('REQUEST_CANCELLED', false, { cause: error });
    if (typeof error === 'object' && error !== null) {
        const record = error as { code?: unknown; statusCode?: unknown };
        if (typeof record.statusCode === 'number')
            return new AgentError(
                typeof record.code === 'string' ? record.code : 'API_ERROR',
                RETRYABLE_STATUSES.has(record.statusCode),
                { cause: error }
            );
        if (typeof record.code === 'string')
            return new AgentError(record.code, false, { cause: error });
    }
    return new AgentError('UNKNOWN', false, { cause: error });
}

export function throwIfCancelled(signal: AbortSignal): void {
    if (signal.aborted) throw new AgentError('REQUEST_CANCELLED');
}

export function waitForRetry(attempt: number, signal: AbortSignal): Promise<void> {
    throwIfCancelled(signal);
    const capped = Math.min(16_000, 500 * 2 ** (attempt - 1));
    const delay = Math.round(capped + capped * 0.2 * Math.random());
    return new Promise((resolve, reject) => {
        const abort = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', abort);
            reject(new AgentError('REQUEST_CANCELLED'));
        };
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', abort);
            resolve();
        }, delay);
        signal.addEventListener('abort', abort, { once: true });
    });
}
