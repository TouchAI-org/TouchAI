import { AiError, AiErrorCode } from '@touchai/models/contracts';

import { ModelConfigurationError } from '@/modules/models';

/** SDK normalization may retain a host refusal inside its causal wrappers. */
export function findModelConfigurationError(error: unknown): ModelConfigurationError | undefined {
    if (error instanceof AiError && error.code === AiErrorCode.REQUEST_CANCELLED) return;
    const pending = [error];
    const visited = new Set<unknown>();
    while (pending.length) {
        const current = pending.pop();
        if (current instanceof ModelConfigurationError) return current;
        if (!current || typeof current !== 'object' || visited.has(current)) continue;
        visited.add(current);
        if ('cause' in current) pending.push(current.cause);
        if ('lastError' in current) pending.push(current.lastError);
    }
}
