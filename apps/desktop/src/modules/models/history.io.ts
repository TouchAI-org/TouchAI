import { findLatestModelBySessionId } from '@/database/queries/sessionTurns';

import type { ModelSummary } from './contracts';

/** History metadata never returns connection configuration or credentials to a view. */
export async function readSessionModelSummary(sessionId: number): Promise<ModelSummary | null> {
    const model = await findLatestModelBySessionId({ sessionId });
    return model
        ? {
              modelDbId: model.id,
              providerId: model.provider_id,
              providerName: model.provider_name,
              modelId: model.model_id,
              modelName: model.name,
          }
        : null;
}
