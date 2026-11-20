import type {
    ImportedProvider,
    ModelAdministration,
    ProviderImportEntry,
} from '@/app/api/models/administration';
import { getProviderDriverDefinition } from '@/app/api/models/catalog';
import type { ProviderImportCandidate } from '@/app/api/models/providerSettingsImport';

export function createProviderImportEntries(
    candidates: readonly ProviderImportCandidate[]
): ProviderImportEntry[] {
    return candidates.map((candidate) => ({
        provider: {
            name: candidate.providerName,
            driver: candidate.driver,
            api_endpoint: candidate.apiEndpoint,
            api_key: candidate.apiKey,
            logo: getProviderDriverDefinition(candidate.driver).logo,
            enabled: candidate.apiKey ? 1 : 0,
            is_builtin: 0,
        },
        model: candidate.modelId
            ? {
                  name: candidate.modelId,
                  model_id: candidate.modelId,
              }
            : null,
    }));
}

export function importProviderSettings(
    candidates: readonly ProviderImportCandidate[],
    importProviders: ModelAdministration['importProviders']
): Promise<ImportedProvider[]> {
    if (candidates.length === 0) return Promise.resolve([]);
    return importProviders({ entries: createProviderImportEntries(candidates) });
}
