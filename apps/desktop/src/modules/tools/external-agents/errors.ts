import type { ExternalAgentErrorCode } from './contracts';

export class ExternalAgentError extends Error {
    constructor(
        readonly code: ExternalAgentErrorCode,
        options?: ErrorOptions
    ) {
        super(code, options);
        this.name = 'ExternalAgentError';
    }
}

export function externalAgentError(error: unknown, fallback: ExternalAgentErrorCode) {
    return error instanceof ExternalAgentError
        ? error
        : new ExternalAgentError(fallback, { cause: error });
}
