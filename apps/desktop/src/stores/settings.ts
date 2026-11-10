// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { getSettingsService } from '@services/SettingsService';
import {
    applyGeneralSettingValue,
    createDefaultGeneralSettings,
    createGeneralSettingUpdaters,
    type GeneralSettingKey,
    type GeneralSettingsData,
    type GeneralSettingValue,
} from '@services/SettingsService/domain';
import {
    SettingsErrorCode,
    type SettingsMutationResult,
    SettingsServiceError,
} from '@services/SettingsService/types';
import { defineStore } from 'pinia';
import { ref } from 'vue';

import { createGeneralSettingsComputedRefs } from './settingBindings';

export type { GeneralSettingsData, OutputScrollBehavior } from '@services/SettingsService/domain';

function toSettingsError(result: SettingsMutationResult): SettingsServiceError {
    if (result.status === 'committed') {
        return new SettingsServiceError(SettingsErrorCode.PersistenceFailed);
    }
    return new SettingsServiceError(result.code, {
        rejection: result.status === 'rejected' ? result.rejection : undefined,
    });
}

export const useSettingsStore = defineStore('settings', () => {
    const settings = ref<GeneralSettingsData>(createDefaultGeneralSettings());
    const initialized = ref(false);
    const loading = ref(false);

    let initializePromise: Promise<void> | null = null;
    let unsubscribe: (() => void) | null = null;
    let pendingMutationToken = 0;
    const pendingMutations = new Map<
        GeneralSettingKey,
        { token: number; value: GeneralSettingValue }
    >();

    function service() {
        return getSettingsService();
    }

    function mirror(): void {
        const snapshot = service().getSnapshot();
        // A focus refresh can return the owner's pre-mutation snapshot while a write is
        // still in flight. Keep the latest requested value visible until that write settles.
        for (const [key, pending] of pendingMutations) {
            applyGeneralSettingValue(snapshot, key, pending.value);
        }
        settings.value = snapshot;
    }

    function settlePendingMutation(key: GeneralSettingKey, token: number): boolean {
        if (pendingMutations.get(key)?.token !== token) {
            return false;
        }
        pendingMutations.delete(key);
        mirror();
        return true;
    }

    async function updateSetting(
        key: GeneralSettingKey,
        value: GeneralSettingValue
    ): Promise<void> {
        const token = ++pendingMutationToken;
        pendingMutations.set(key, { token, value });
        mirror();

        let result: SettingsMutationResult;
        try {
            result = await service().mutate(key, value);
        } catch (error) {
            settlePendingMutation(key, token);
            throw error;
        }

        if (result.status === 'committed') {
            settlePendingMutation(key, token);
            return;
        }
        settlePendingMutation(key, token);
        throw toSettingsError(result);
    }

    async function initialize(): Promise<void> {
        if (initialized.value) {
            return;
        }

        if (initializePromise) {
            return initializePromise;
        }

        // Subscribe before the handshake. If the first initialize rejects (e.g. the owner
        // is not ready yet), a later owner-ready/focus reconcile still updates the mirror;
        // `initialized` stays false until a handshake actually succeeds.
        if (!unsubscribe) {
            unsubscribe = service().subscribe(() => mirror());
        }

        initializePromise = (async () => {
            loading.value = true;
            try {
                await service().initialize();
                mirror();
                initialized.value = true;
            } finally {
                loading.value = false;
                initializePromise = null;
            }
        })();

        return initializePromise;
    }

    async function dispose(): Promise<void> {
        pendingMutationToken += 1;
        pendingMutations.clear();
        if (unsubscribe) {
            unsubscribe();
            unsubscribe = null;
        }
        service().dispose();
        initialized.value = false;
    }

    async function refresh(): Promise<void> {
        await service().refresh();
        mirror();
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
