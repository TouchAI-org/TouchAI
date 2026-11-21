import type { PrivacySettingsApi } from '@/app/api/privacy';
import {
    DEFAULT_PRIVACY_MODEL_ID,
    normalizePrivacyFilterFailureAction,
    normalizePrivacyFilterModelId,
    parsePrivacyFilterSettings,
    PRIVACY_FILTER_FAILURE_ACTION_KEY,
    PRIVACY_FILTER_MODEL_KEY,
    PRIVACY_FILTER_SETTINGS_KEY,
    type PrivacyFilterSettings,
    serializePrivacyFilterSettings,
} from '@/modules/privacy/public';
import {
    SettingsErrorCode,
    type SettingsSection,
    type SettingsService,
    SettingsServiceError,
} from '@/modules/settings';

export function privacySettingsSections(): SettingsSection[] {
    return [
        {
            key: PRIVACY_FILTER_SETTINGS_KEY,
            stateKey: 'privacyFilterSettings',
            parse: parsePrivacyFilterSettings,
            serialize: (value) => serializePrivacyFilterSettings(value as PrivacyFilterSettings),
        },
        {
            key: PRIVACY_FILTER_MODEL_KEY,
            stateKey: 'privacyFilterModelId',
            parse: (value) => normalizePrivacyFilterModelId(value ?? DEFAULT_PRIVACY_MODEL_ID),
            serialize: (value) => normalizePrivacyFilterModelId(value),
        },
        {
            key: PRIVACY_FILTER_FAILURE_ACTION_KEY,
            stateKey: 'privacyFilterFailureAction',
            parse: normalizePrivacyFilterFailureAction,
            serialize: normalizePrivacyFilterFailureAction,
        },
    ];
}

export function createPrivacySettingsApi(
    settings: Pick<
        SettingsService,
        'getSectionSnapshot' | 'initialize' | 'refresh' | 'mutate' | 'subscribe'
    >
): PrivacySettingsApi {
    async function update(key: string, value: string) {
        await settings.initialize();
        const result = await settings.mutate(key, value);
        if (result.status !== 'committed')
            throw new SettingsServiceError(
                result.code ?? SettingsErrorCode.PersistenceFailed,
                result.message
            );
    }
    return Object.freeze<PrivacySettingsApi>({
        initialize: settings.initialize.bind(settings),
        refresh: settings.refresh.bind(settings),
        getPrivacyFilterSettings: () =>
            settings.getSectionSnapshot(PRIVACY_FILTER_SETTINGS_KEY) as PrivacyFilterSettings,
        getPrivacyFilterModelId: () =>
            normalizePrivacyFilterModelId(settings.getSectionSnapshot(PRIVACY_FILTER_MODEL_KEY)),
        getPrivacyFilterFailureAction: () =>
            normalizePrivacyFilterFailureAction(
                settings.getSectionSnapshot(PRIVACY_FILTER_FAILURE_ACTION_KEY)
            ),
        updatePrivacyFilterSettings: (value: PrivacyFilterSettings) =>
            update(PRIVACY_FILTER_SETTINGS_KEY, serializePrivacyFilterSettings(value)),
        updatePrivacyFilterModelId: (value) =>
            update(PRIVACY_FILTER_MODEL_KEY, normalizePrivacyFilterModelId(value)),
        updatePrivacyFilterFailureAction: (value) =>
            update(PRIVACY_FILTER_FAILURE_ACTION_KEY, normalizePrivacyFilterFailureAction(value)),
        subscribeSettings: (listener) =>
            settings.subscribe((notice) => {
                if (
                    !notice.changedKeys.length ||
                    notice.changedKeys.some(
                        (key) =>
                            key === PRIVACY_FILTER_SETTINGS_KEY ||
                            key === PRIVACY_FILTER_MODEL_KEY ||
                            key === PRIVACY_FILTER_FAILURE_ACTION_KEY
                    )
                )
                    listener();
            }),
    });
}
