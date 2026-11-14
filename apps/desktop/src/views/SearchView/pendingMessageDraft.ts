import type { PendingUserMessage } from '@/services/AgentService/task/types';

import type { SearchModelOverride } from './types';

/**
 * A queued message always owns the composer's model choice while it is being
 * edited. Missing ids mean the default model, not "keep the previous draft's
 * override".
 */
export function resolvePendingMessageModelOverride(
    message: Pick<PendingUserMessage, 'modelId' | 'providerId'>
): SearchModelOverride {
    return {
        modelId: message.modelId ?? null,
        providerId: message.providerId ?? null,
    };
}
