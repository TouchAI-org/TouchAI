export type ModelConfigurationErrorCode =
    | 'NO_ACTIVE_MODEL'
    | 'MODEL_NOT_FOUND'
    | 'PROVIDER_DISABLED'
    | 'PROVIDER_BINDING_REVOKED';

export class ModelConfigurationError extends Error {
    constructor(
        readonly code: ModelConfigurationErrorCode,
        readonly details?: unknown
    ) {
        super(code);
        this.name = 'ModelConfigurationError';
    }
}
