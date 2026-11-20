import { z } from 'zod';

import type { ProviderSettingsImportApi } from '@/app/api/models/providerSettingsImport';
import { invoke } from '@/platform/native/invoke';

const driver = z.enum(['openai', 'openai-compatible', 'anthropic', 'anthropic-compatible']);
const candidate = z.strictObject({
    providerName: z.string(),
    driver,
    apiEndpoint: z.string(),
    modelId: z.string().nullable(),
    apiKey: z.string().nullable(),
});
const source = z.strictObject({
    status: z.enum(['available', 'partial', 'missing', 'malformed', 'unsupported', 'unavailable']),
    candidate: candidate.nullable(),
});
const scanSchema = z.strictObject({
    claudeCode: source,
    codex: source,
});

export const providerSettingsImportApi: ProviderSettingsImportApi = {
    async scan() {
        return scanSchema.parse(await invoke('scan_provider_settings_import'));
    },
};
