// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { getSettingValues, setSetting } from '@database/queries';
import { AppEvent, eventService } from '@services/EventService';
import { log } from '@services/ObservabilityService';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { defineStore } from 'pinia';
import { useStateMachine } from 'reka-ui';
import { computed, onScopeDispose, ref, shallowRef } from 'vue';

import {
    applyGeneralSettingValue,
    applyParsedGeneralSettingValue,
    applyPersistedGeneralSettingValue,
    cloneGeneralSettingsSnapshot,
    createDefaultGeneralSettings,
    createGeneralSettingsComputedRefs,
    createGeneralSettingUpdaters,
    GENERAL_SETTING_DEFINITIONS,
    type GeneralSettingKey,
    type GeneralSettingsData,
    type GeneralSettingValue,
    getGeneralSettingDefinition,
    getGeneralSettingEventValue,
    parseGeneralSettingUpdateValue,
    serializeGeneralSetting,
    serializeParsedGeneralSettingValue,
} from './setting';

export type { GeneralSettingsData, OutputScrollBehavior } from './setting';

const SETTINGS_LIFECYCLE = {
    pending: { ready: 'ready', dispose: 'disposed' },
    ready: { dispose: 'disposed' },
    disposed: {},
} as const;

type SettingsInitialization = ReturnType<typeof useStateMachine<typeof SETTINGS_LIFECYCLE>> & {
    promise: Promise<void> | null;
    unlisten: (() => void) | null;
};

export const useSettingsStore = defineStore('settings', () => {
    const settings = ref<GeneralSettingsData>(createDefaultGeneralSettings());
    const initialization = shallowRef<SettingsInitialization | null>(null);
    const initialized = computed(() => initialization.value?.state.value === 'ready');
    const pendingReads = ref(0);
    const loading = computed(() => pendingReads.value > 0);
    const windowLabel = ref('unknown');

    const instanceId = crypto.randomUUID();

    function cloneSettingsSnapshot(): GeneralSettingsData {
        return cloneGeneralSettingsSnapshot(settings.value);
    }

    function applySetting(key: GeneralSettingKey, value: GeneralSettingValue): void {
        applyGeneralSettingValue(settings.value, key, value);
    }

    function serializeSetting(key: GeneralSettingKey): string {
        return serializeGeneralSetting(settings.value, key);
    }

    function payloadValueForEvent(key: GeneralSettingKey): GeneralSettingValue {
        return getGeneralSettingEventValue(settings.value, key);
    }

    async function persistDefaultIfMissing(key: GeneralSettingKey, currentValue: string | null) {
        if (currentValue !== null) {
            return;
        }
        await setSetting({ key, value: serializeSetting(key) });
    }

    async function loadFromDatabase(canApply?: () => boolean) {
        pendingReads.value += 1;
        try {
            const settingValues = await getSettingValues({
                keys: GENERAL_SETTING_DEFINITIONS.map((definition) => definition.key),
            });
            if (canApply && !canApply()) return;
            const settingRows = GENERAL_SETTING_DEFINITIONS.map(
                (definition) => settingValues[definition.key] ?? null
            );

            GENERAL_SETTING_DEFINITIONS.forEach((definition, index) => {
                applyPersistedGeneralSettingValue(
                    settings.value,
                    definition.key,
                    settingRows[index] ?? null
                );
            });

            const persistenceResults = await Promise.allSettled(
                GENERAL_SETTING_DEFINITIONS.map((definition, index) => {
                    const persistedValue = settingRows[index] ?? null;
                    if (definition.shouldRewritePersisted?.(persistedValue)) {
                        return setSetting({
                            key: definition.key,
                            value: serializeSetting(definition.key),
                        });
                    }

                    return persistDefaultIfMissing(definition.key, persistedValue);
                })
            );
            const failedPersistenceKeys = persistenceResults.flatMap((result, index) =>
                result.status === 'rejected'
                    ? [GENERAL_SETTING_DEFINITIONS[index]?.key ?? `unknown:${index}`]
                    : []
            );
            if (failedPersistenceKeys.length > 0) {
                log.warn(
                    `[SettingsStore] Failed to persist general setting rewrite/default value(s): ${failedPersistenceKeys.join(
                        ', '
                    )}`
                );
            }
        } finally {
            pendingReads.value -= 1;
        }
    }

    async function broadcastUpdate(key: GeneralSettingKey): Promise<void> {
        await eventService.emit(AppEvent.SETTINGS_GENERAL_UPDATED, {
            sourceId: instanceId,
            windowLabel: windowLabel.value,
            key,
            value: payloadValueForEvent(key),
        });
    }

    async function updateSetting(
        key: GeneralSettingKey,
        value: GeneralSettingValue,
        options: { broadcast?: boolean } = {}
    ): Promise<void> {
        const { broadcast = true } = options;
        const definition = getGeneralSettingDefinition(key);
        if (!definition) {
            return;
        }

        const parsedValue = parseGeneralSettingUpdateValue(key, value);
        if (definition.persistBeforeApply) {
            await setSetting({
                key,
                value: serializeParsedGeneralSettingValue(key, parsedValue),
            });
            applyParsedGeneralSettingValue(settings.value, key, parsedValue);
            if (broadcast) {
                await broadcastUpdate(key);
            }
            return;
        }

        const previousSettings = cloneSettingsSnapshot();
        applyParsedGeneralSettingValue(settings.value, key, parsedValue);
        try {
            await setSetting({ key, value: serializeSetting(key) });
        } catch (error) {
            settings.value = previousSettings;
            throw error;
        }
        if (broadcast) {
            await broadcastUpdate(key);
        }
    }

    async function initialize() {
        const current = initialization.value;
        if (current?.state.value === 'ready') return;
        if (current?.state.value === 'pending') {
            await current.promise;
            return;
        }

        const attempt: SettingsInitialization = {
            ...useStateMachine('pending', SETTINGS_LIFECYCLE),
            promise: null,
            unlisten: null,
        };
        initialization.value = attempt;
        const isActive = () => attempt.state.value !== 'disposed';
        attempt.promise = (async () => {
            try {
                windowLabel.value = getCurrentWindow().label;
            } catch {
                windowLabel.value = 'unknown';
            }

            await loadFromDatabase(isActive);
            if (!isActive()) return;

            const unlisten = await eventService.on(AppEvent.SETTINGS_GENERAL_UPDATED, (payload) => {
                if (!isActive() || payload.sourceId === instanceId) {
                    return;
                }
                applySetting(payload.key, payload.value);
            });
            if (!isActive()) {
                unlisten();
                return;
            }
            attempt.unlisten = unlisten;
            attempt.dispatch('ready');
        })();

        try {
            await attempt.promise;
        } catch (error) {
            releaseInitialization(attempt);
            throw error;
        } finally {
            attempt.promise = null;
        }
    }

    function releaseInitialization(attempt = initialization.value) {
        if (!attempt) return;
        attempt.dispatch('dispose');
        const unlisten = attempt.unlisten;
        attempt.unlisten = null;
        unlisten?.();
    }

    async function dispose() {
        releaseInitialization();
    }

    onScopeDispose(() => releaseInitialization());

    async function refresh() {
        await loadFromDatabase();
    }

    const settingComputedRefs = createGeneralSettingsComputedRefs(settings);
    const settingUpdaters = createGeneralSettingUpdaters(updateSetting);

    return {
        settings,
        initialized,
        loading,
        initialize,
        dispose,
        refresh,
        ...settingComputedRefs,
        ...settingUpdaters,
    };
});
