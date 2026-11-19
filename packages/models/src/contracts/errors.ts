export enum AiErrorCode {
    REQUEST_CANCELLED = 'REQUEST_CANCELLED',
    EMPTY_RESPONSE = 'EMPTY_RESPONSE',
    STREAM_ERROR = 'STREAM_ERROR',
    UNSUPPORTED_INPUT = 'UNSUPPORTED_INPUT',
    NETWORK_ERROR = 'NETWORK_ERROR',
    API_ERROR = 'API_ERROR',
    TIMEOUT = 'TIMEOUT',
    RATE_LIMIT = 'RATE_LIMIT',
    SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',
    BAD_GATEWAY = 'BAD_GATEWAY',
    GATEWAY_TIMEOUT = 'GATEWAY_TIMEOUT',
    INVALID_API_KEY = 'INVALID_API_KEY',
    UNAUTHORIZED = 'UNAUTHORIZED',
    INVALID_CONFIG = 'INVALID_CONFIG',
    MISSING_ENDPOINT = 'MISSING_ENDPOINT',
    UNKNOWN = 'UNKNOWN',
}

export class AiError extends Error {
    readonly usesDefaultMessage: boolean;
    constructor(
        readonly code: AiErrorCode,
        readonly details?: unknown,
        message?: string,
        readonly options: { cause?: unknown } = {}
    ) {
        super(message || code, options);
        this.name = 'AiError';
        this.usesDefaultMessage = !message;
    }
    is(code: AiErrorCode): boolean {
        return this.code === code;
    }
    isRetryable(): boolean {
        return [
            AiErrorCode.NETWORK_ERROR,
            AiErrorCode.TIMEOUT,
            AiErrorCode.STREAM_ERROR,
            AiErrorCode.RATE_LIMIT,
            AiErrorCode.SERVICE_UNAVAILABLE,
            AiErrorCode.BAD_GATEWAY,
            AiErrorCode.GATEWAY_TIMEOUT,
            AiErrorCode.EMPTY_RESPONSE,
        ].includes(this.code);
    }
    static fromError(error: unknown, defaultCode = AiErrorCode.UNKNOWN): AiError {
        return AiError.normalize(error, defaultCode, new Set());
    }
    private static normalize(
        error: unknown,
        defaultCode: AiErrorCode,
        visited: Set<unknown>
    ): AiError {
        if (error instanceof AiError && error.code !== AiErrorCode.UNKNOWN) return error;
        const original = error;
        while (error && typeof error === 'object' && 'lastError' in error && !visited.has(error)) {
            visited.add(error);
            if (error.lastError === undefined) break;
            error = error.lastError;
        }
        if (error instanceof Error || typeof error === 'string') {
            const originalMessage = error instanceof Error ? error.message : error;
            const message = originalMessage.toLowerCase();
            if (
                /no endpoints found that support\b(?=.*\b(?:image|file)s?\b).*\binputs?\b/i.test(
                    originalMessage
                )
            ) {
                return new AiError(AiErrorCode.UNSUPPORTED_INPUT, original, undefined, {
                    cause: original,
                });
            }
            if (
                message.includes('abort') ||
                message.includes('cancel') ||
                originalMessage.includes('\u53d6\u6d88') ||
                (error instanceof Error && error.name === 'AbortError')
            ) {
                return new AiError(AiErrorCode.REQUEST_CANCELLED, original, undefined, {
                    cause: original,
                });
            }
            if (
                message.includes('error sending request for url') ||
                message.includes('failed to fetch') ||
                message.includes('network') ||
                message.includes('fetch')
            ) {
                return new AiError(AiErrorCode.NETWORK_ERROR, original, undefined, {
                    cause: original,
                });
            }
            if (message.includes('timeout'))
                return new AiError(AiErrorCode.TIMEOUT, original, originalMessage, {
                    cause: original,
                });
            // SDK response readers wrap transport failures; malformed successful payloads remain non-retryable.
            if (error instanceof Error && error.cause !== undefined && !visited.has(error.cause)) {
                visited.add(error);
                const transport = AiError.normalize(error.cause, defaultCode, visited);
                if (
                    [
                        AiErrorCode.NETWORK_ERROR,
                        AiErrorCode.TIMEOUT,
                        AiErrorCode.REQUEST_CANCELLED,
                    ].includes(transport.code)
                ) {
                    return new AiError(
                        transport.code,
                        original,
                        transport.usesDefaultMessage ? undefined : transport.message,
                        { cause: original }
                    );
                }
            }
            return new AiError(defaultCode, original, originalMessage, { cause: original });
        }
        return new AiError(defaultCode, undefined, String(error), { cause: original });
    }
}
