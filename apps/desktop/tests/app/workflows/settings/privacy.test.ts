import { createSettingsWindowFixture } from '@tests/utils/settingsWindow';
import { afterEach, describe, expect, it } from 'vitest';

let fixture: ReturnType<typeof createSettingsWindowFixture> | undefined;
afterEach(() => fixture?.dispose());

describe('given main owns serialized settings and secondary windows edit privacy preferences', () => {
    it('user opens privacy settings without a saved failure action then sees rules fallback', async () => {
        fixture = createSettingsWindowFixture();
        await fixture.initialize();

        expect(fixture.owner.privacySettings.getPrivacyFilterFailureAction()).toBe(
            'fallback-rules'
        );
    });

    it('user opens privacy settings with an unrecognized saved failure action then sending is blocked on masking failure', async () => {
        fixture = createSettingsWindowFixture({
            values: { privacy_filter_failure_action: 'unrecognized' },
        });
        await fixture.initialize();

        expect(fixture.owner.privacySettings.getPrivacyFilterFailureAction()).toBe('block');
    });

    it('user picks a masking failure action in settings then main and a reopened settings window both use the saved choice', async () => {
        const preferences = JSON.stringify({ version: 2, enabled: true, useLocalModel: true });
        fixture = createSettingsWindowFixture({
            values: { privacy_filter_settings: preferences },
        });
        await fixture.initialize();
        const client = fixture.createClient();
        await client.privacySettings.initialize();

        await client.privacySettings.updatePrivacyFilterFailureAction('block');
        client.dispose();
        const reopened = fixture.createClient();
        await reopened.privacySettings.initialize();

        expect(fixture.owner.privacySettings.getPrivacyFilterFailureAction()).toBe('block');
        expect(reopened.privacySettings.getPrivacyFilterFailureAction()).toBe('block');
        expect(fixture.values.get('privacy_filter_failure_action')).toBe('block');
        expect(fixture.values.get('privacy_filter_settings')).toBe(preferences);
    });

    it('user changes privacy mode and model in settings then main uses the committed values while general preferences keep their own shape', async () => {
        fixture = createSettingsWindowFixture();
        await fixture.initialize();
        const client = fixture.createClient();
        await client.privacySettings.initialize();
        const settings = client.privacySettings.getPrivacyFilterSettings();
        await client.privacySettings.updatePrivacyFilterSettings({
            ...settings,
            enabled: true,
            useLocalModel: false,
            maskedWords: ['Project Nightfall'],
        });
        await client.privacySettings.updatePrivacyFilterModelId('openmed-privacy-filter');
        await fixture.owner.api.refresh();
        expect(fixture.owner.privacySettings.getPrivacyFilterSettings()).toMatchObject({
            enabled: true,
            useLocalModel: false,
            maskedWords: ['Project Nightfall'],
        });
        expect(fixture.owner.privacySettings.getPrivacyFilterModelId()).toBe(
            'openmed-privacy-filter'
        );
        expect(fixture.values.get('privacy_filter_model_id')).toBe('openmed-privacy-filter');
        expect(JSON.parse(fixture.values.get('privacy_filter_settings')!)).toEqual({
            ...settings,
            enabled: true,
            useLocalModel: false,
            maskedWords: ['Project Nightfall'],
        });
        expect(fixture.owner.api.getSnapshot()).not.toHaveProperty('privacyFilterSettings');
        expect(fixture.owner.api.getSnapshot()).not.toHaveProperty('privacyFilterModelId');
    });

    it('user reopens settings with an older privacy section then existing categories normalize without changing the saved wire shape', async () => {
        const saved = JSON.stringify({
            version: 1,
            enabled: true,
            maskSecrets: false,
            maskPersonalData: true,
            useLocalModel: false,
            maskedWords: ['Project Nightfall'],
        });
        fixture = createSettingsWindowFixture({
            values: {
                privacy_filter_settings: saved,
                privacy_filter_model_id: 'openai-privacy-filter',
            },
        });
        await fixture.initialize();
        const client = fixture.createClient();
        await client.privacySettings.initialize();
        expect(client.privacySettings.getPrivacyFilterSettings()).toMatchObject({
            version: 2,
            enabled: true,
            useLocalModel: false,
            categories: { secrets: false, email: true },
            maskedWords: ['Project Nightfall'],
        });
        expect(client.privacySettings.getPrivacyFilterModelId()).toBe('openai-privacy-filter');
        expect(fixture.values.get('privacy_filter_settings')).toBe(saved);
    });
});
