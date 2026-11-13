// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { getSettingsService, type SettingsService } from '@services/SettingsService';
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
import { useStateMachine } from 'reka-ui';
import { computed, onScopeDispose, ref, shallowRef } from 'vue';

import { createGeneralSettingsComputedRefs } from './settingBindings';

export type { GeneralSettingsData, OutputScrollBehavior } from '@services/SettingsService/domain';

const SETTINGS_LIFECYCLE = {
    pending: { ready: 'ready', dispose: 'disposed' },
    ready: { dispose: 'disposed' },
    disposed: {},
} as const;

type SettingsInitialization = ReturnType<typeof useStateMachine<typeof SETTINGS_LIFECYCLE>> & {
    promise: Promise<void> | null;
    service: SettingsService;
};

function toSettingsError(result: SettingsMutationResult): SettingsServiceError {
    if (result.status === 'committed') {
        return new SettingsServiceError(SettingsErrorCode.PersistenceFailed);
    }
    return new SettingsServiceError(result.code, {
        rejection: result.status === 'rejected' ? result.rejection : undefined,
    });
}

function sameSettingField(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) {
        return true;
    }
    if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
        return false;
    }
    try {
        return JSON.stringify(left) === JSON.stringify(right);
    } catch {
        return false;
    }
}

export const useSettingsStore = defineStore('settings', () => {
    const settings = ref<GeneralSettingsData>(createDefaultGeneralSettings());
    const initialization = shallowRef<SettingsInitialization | null>(null);
    const initialized = computed(() => initialization.value?.state.value === 'ready');
    const pendingReads = ref(0);
    const loading = computed(() => pendingReads.value > 0);

    let initializePromise: Promise<void> | null = null;
    let unsubscribe: (() => void) | null = null;
    let subscribedService: SettingsService | null = null;
    let disposed = false;
    let pendingMutationToken = 0;
    const pendingMutations = new Map<
        GeneralSettingKey,
        { token: number; value: GeneralSettingValue }
    >();

    function service(): SettingsService {
        return getSettingsService();
    }

    function mirror(source: SettingsService = service()): void {
        if (disposed) {
            return;
        }
        const snapshot = source.getSnapshot();
        // A focus refresh can return the owner's pre-mutation snapshot while a write is
        // still in flight. Keep the latest requested value visible until that write settles.
        for (const [key, pending] of pendingMutations) {
            applyGeneralSettingValue(snapshot, key, pending.value);
        }
        // Do not replace the root object: Search and Browser keep an editable draft in a
        // deep watcher over their section. Mutate only fields whose content changed so an
        // unrelated save cannot reset a draft that is not part of the snapshot update.
        const target = settings.value as unknown as Record<keyof GeneralSettingsData, unknown>;
        const snapshotFields = snapshot as unknown as Record<keyof GeneralSettingsData, unknown>;
        for (const key of Object.keys(snapshotFields) as Array<keyof GeneralSettingsData>) {
            if (!sameSettingField(target[key], snapshotFields[key])) {
                target[key] = snapshotFields[key];
            }
        }
    }

    function ensureSubscribed(source: SettingsService): void {
        if (subscribedService === source && unsubscribe) {
            return;
        }
        unsubscribe?.();
        subscribedService = source;
        unsubscribe = source.subscribe(() => mirror(source));
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
        const source = service();
        const token = ++pendingMutationToken;
        pendingMutations.set(key, { token, value });
        mirror(source);

        let result: SettingsMutationResult;
        try {
            result = await source.mutate(key, value);
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
        if (disposed) {
            throw new SettingsServiceError(SettingsErrorCode.OwnerDisposed);
        }

        const current = initialization.value;
        if (current?.state.value === 'ready') {
            return;
        }
        if (current?.state.value === 'pending' && initializePromise) {
            return initializePromise;
        }

        const source = service();
        ensureSubscribed(source);

        const attempt: SettingsInitialization = {
            ...useStateMachine('pending', SETTINGS_LIFECYCLE),
            promise: null,
            service: source,
        };
        initialization.value = attempt;
        const isActive = () => attempt.state.value !== 'disposed';

        pendingReads.value += 1;
        initializePromise = (async () => {
            try {
                await source.initialize();
                if (!isActive()) {
                    return;
                }
                mirror(source);
                attempt.dispatch('ready');
            } finally {
                pendingReads.value -= 1;
            }
        })();
        attempt.promise = initializePromise;

        try {
            await initializePromise;
        } catch (error) {
            if (!isActive()) {
                return;
            }
            // A failed handshake is retryable. Keep the subscription so a late owner-ready
            // or focus reconcile can still update the mirror before the explicit retry.
            if (initialization.value === attempt && attempt.state.value === 'pending') {
                initialization.value = null;
            }
            throw error;
        } finally {
            if (initializePromise === attempt.promise) {
                initializePromise = null;
            }
            attempt.promise = null;
        }
    }

    function releaseInitialization(): void {
        const source = subscribedService ?? initialization.value?.service ?? null;
        disposed = true;
        const attempt = initialization.value;
        if (attempt?.state.value === 'pending' || attempt?.state.value === 'ready') {
            attempt.dispatch('dispose');
        }
        pendingMutationToken += 1;
        pendingMutations.clear();
        unsubscribe?.();
        unsubscribe = null;
        subscribedService = null;
        source?.dispose();
    }

    async function dispose(): Promise<void> {
        releaseInitialization();
    }

    onScopeDispose(() => releaseInitialization());

    async function refresh(): Promise<void> {
        const source = service();
        pendingReads.value += 1;
        try {
            await source.refresh();
            mirror(source);
        } finally {
            pendingReads.value -= 1;
        }
    }

    async function refreshStartOnBoot(): Promise<void> {
        const displayedBefore = settings.value.startOnBoot;
        const effective = await service().readEffectiveValue('start_on_boot');
        if (
            !disposed &&
            typeof effective === 'boolean' &&
            settings.value.startOnBoot === displayedBefore &&
            effective !== settings.value.startOnBoot
        ) {
            // The OS is authoritative when this view opens. Persist its value through the
            // owner so a later unrelated settings refresh cannot overwrite the displayed
            // state with a stale saved value.
            await updateSetting('start_on_boot', effective);
        }
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
        refreshStartOnBoot,
        ...settingComputedRefs,
        ...settingUpdaters,
    };
});
