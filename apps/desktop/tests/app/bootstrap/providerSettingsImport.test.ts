import { mockTauriCommand } from '@tests/utils/tauri';
import { describe, expect, it } from 'vitest';

import { providerSettingsImportApi } from '@/app/bootstrap/providerSettingsImport';

describe('user requests a local provider settings preview', () => {
    it('user receives separate source statuses when the read-only scan completes', async () => {
        mockTauriCommand('scan_provider_settings_import', {
            claudeCode: { status: 'missing', candidate: null },
            codex: { status: 'malformed', candidate: null },
        });

        expect(await providerSettingsImportApi.scan()).toEqual({
            claudeCode: { status: 'missing', candidate: null },
            codex: { status: 'malformed', candidate: null },
        });
    });

    it('user can retry when the native scan fails', async () => {
        mockTauriCommand('scan_provider_settings_import', () => {
            throw new Error('provider_settings_import_unavailable');
        });
        await expect(providerSettingsImportApi.scan()).rejects.toThrow(
            'provider_settings_import_unavailable'
        );
        mockTauriCommand('scan_provider_settings_import', {
            claudeCode: { status: 'missing', candidate: null },
            codex: { status: 'missing', candidate: null },
        });
        expect((await providerSettingsImportApi.scan()).codex.status).toBe('missing');
    });

    it('user gets a contract error instead of an unsafe native payload', async () => {
        mockTauriCommand('scan_provider_settings_import', {
            claudeCode: {
                status: 'available',
                candidate: {
                    providerName: 'Unsafe',
                    driver: 'unknown',
                    apiEndpoint: 'https://example.test',
                    modelId: null,
                    apiKey: null,
                },
            },
            codex: { status: 'missing', candidate: null },
        });

        await expect(providerSettingsImportApi.scan()).rejects.toThrow();
    });
});
