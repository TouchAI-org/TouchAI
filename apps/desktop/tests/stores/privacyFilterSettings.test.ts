import { describe, expect, it } from 'vitest';

import {
    DEFAULT_PRIVACY_FILTER_SETTINGS,
    parsePrivacyFilterSettings,
    PRIVACY_DATA_TYPES,
    serializePrivacyFilterSettings,
} from '@services/SettingsService/domain';

describe('given privacy filter preferences have not been configured', () => {
    it('user sees filtering disabled and local detection selected when settings are opened', () => {
        expect(parsePrivacyFilterSettings(null)).toEqual(DEFAULT_PRIVACY_FILTER_SETTINGS);
        expect(DEFAULT_PRIVACY_FILTER_SETTINGS.enabled).toBe(false);
        expect(DEFAULT_PRIVACY_FILTER_SETTINGS.useLocalModel).toBe(true);
    });

    it('user keeps valid choices when saved lists and thresholds need normalization', () => {
        const parsed = parsePrivacyFilterSettings(
            JSON.stringify({
                enabled: true,
                maskSecrets: true,
                maskPersonalData: true,
                useLocalModel: false,
                confidenceThreshold: 7,
                maskedWords: ['  TouchAI ', '', 'TouchAI', 'Team Name'],
                neverMask: ['alice@example.test', 'alice@example.test', '  '],
            })
        );

        expect(parsed).toMatchObject({
            enabled: true,
            categories: {
                secrets: true,
                email: true,
            },
            useLocalModel: false,
            confidenceThreshold: 1,
            maskedWords: ['TouchAI', 'Team Name'],
            neverMask: ['alice@example.test'],
        });
    });

    it('user keeps selected rules when saved settings are reloaded', () => {
        const serialized = serializePrivacyFilterSettings({
            ...DEFAULT_PRIVACY_FILTER_SETTINGS,
            enabled: true,
            categories: {
                ...DEFAULT_PRIVACY_FILTER_SETTINGS.categories,
                email: true,
            },
            maskedWords: ['Nightjar'],
        });

        expect(parsePrivacyFilterSettings(serialized)).toMatchObject({
            enabled: true,
            categories: { email: true },
            maskedWords: ['Nightjar'],
        });
    });

    it('user upgrades old privacy preferences then keeps every selected category', () => {
        const parsed = parsePrivacyFilterSettings(
            JSON.stringify({
                version: 1,
                enabled: true,
                maskSecrets: false,
                maskPersonalData: true,
                personalDataTypes: {
                    email: true,
                    phone: false,
                    privatePerson: true,
                },
            })
        );

        expect(parsed.version).toBe(2);
        expect(parsed.categories).toMatchObject({
            secrets: false,
            email: true,
            phone: false,
            privatePerson: true,
        });
        expect(parsed).not.toHaveProperty('maskSecrets');
        expect(parsed).not.toHaveProperty('maskPersonalData');
        expect(parsed).not.toHaveProperty('personalDataTypes');
    });

    it('user upgrades the former personal-data switch without dropping personal categories', () => {
        const parsed = parsePrivacyFilterSettings(
            JSON.stringify({
                version: 1,
                enabled: true,
                maskSecrets: false,
                maskPersonalData: false,
            })
        );

        expect(parsed.categories.secrets).toBe(false);
        expect(PRIVACY_DATA_TYPES.every((type) => parsed.categories[type] === false)).toBe(true);
    });
});
