import { findProviderById } from '@database/queries/providers';
import { parseProviderConfigJson, parseProviderDriver } from '@touchai/models/catalog';

import type { ModelsModuleHost } from './contracts';

export const readConnectionState: ModelsModuleHost['readConnectionState'] = async (providerId) => {
    const provider = await findProviderById({ id: providerId });
    return provider
        ? {
              providerId: provider.id,
              enabled: provider.enabled === 1,
              driver: parseProviderDriver(provider.driver),
              apiEndpoint: provider.api_endpoint,
              apiKey: provider.api_key || undefined,
              config: parseProviderConfigJson(provider.config_json),
              updatedAt: provider.updated_at,
          }
        : null;
};
