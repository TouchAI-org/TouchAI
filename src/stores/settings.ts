// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { getSettingValue, setSetting } from '@database/queries';
import type { GeneralSettingKey, SettingsGeneralUpdatedEvent } from '@services/EventService';
import { AppEvent, eventService } from '@services/EventService';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

import { z } from '@/utils/zod';

export type OutputScrollBehavior = 'follow_output' | 'stay_position' | 'jump_to_top';

export interface GeneralSettingsData {
    globalShortcut: string;
    startOnBoot: boolean;
    startMinimized: boolean;
    mcpMaxIterations: number;
    outputScrollBehavior: OutputScrollBehavior;
}

const DEFAULT_GENERAL_SETTINGS: GeneralSettingsData = {
    globalShortcut: 'Alt+Space',
    startOnBoot: false,
    startMinimized: true,
    mcpMaxIterations: 10,
    outputScrollBehavior: 'follow_output',
};

type GeneralSettingValue = SettingsGeneralUpdatedEvent['value'];

const outputScrollBehaviorSchema = z.enum(['follow_output', 'stay_position', 'jump_to_top']);

export const useSettingsStore = defineStore('settings', () => {
    const settings = ref<GeneralSettingsData>({ ...DEFAULT_GENERAL_SETTINGS });
    const initialized = ref(false);
    const loading = ref(false);
    const windowLabel = ref('unknown');

    const instanceId = crypto.randomUUID();
    let initializePromise: Promise<void> | null = null;
    let unlistenSettingsUpdated: (() => void) | null = null;

    function normalizeOutputScrollBehavior(value: string | null): OutputScrollBehavior {
        const result = outputScrollBehaviorSchema.safeParse(value);
        if (result.success) {
            return result.data;
        }
        return DEFAULT_GENERAL_SETTINGS.outputScrollBehavior;
    }

    function normalizeMcpMaxIterations(value: number): number {
        if (Number.isNaN(value)) {
            return DEFAULT_GENERAL_SETTINGS.mcpMaxIterations;
        }
        return Math.max(1, Math.min(50, value));
    }

    function applySetting(key: GeneralSettingKey, value: GeneralSettingValue): void {
        switch (key) {
            case 'global_shortcut':
                settings.value.globalShortcut = String(
                    value || DEFAULT_GENERAL_SETTINGS.globalShortcut
                );
                break;
            case 'start_on_boot':
                settings.value.startOnBoot =
                    typeof value === 'boolean' ? value : String(value) === 'true';
                break;
            case 'start_minimized':
                settings.value.startMinimized =
                    typeof value === 'boolean' ? value : String(value) === 'true';
                break;
            case 'mcp_max_iterations': {
                const parsed = typeof value === 'number' ? value : parseInt(String(value), 10);
                settings.value.mcpMaxIterations = normalizeMcpMaxIterations(parsed);
                break;
            }
            case 'output_scroll_behavior':
                settings.value.outputScrollBehavior = normalizeOutputScrollBehavior(String(value));
                break;
            default:
                break;
        }
    }

    function serializeSetting(key: GeneralSettingKey): string {
        switch (key) {
            case 'global_shortcut':
                return settings.value.globalShortcut;
            case 'start_on_boot':
                return String(settings.value.startOnBoot);
            case 'start_minimized':
                return String(settings.value.startMinimized);
            case 'mcp_max_iterations':
                return String(settings.value.mcpMaxIterations);
            case 'output_scroll_behavior':
                return settings.value.outputScrollBehavior;
            default:
                return '';
        }
    }

    function payloadValueForEvent(key: GeneralSettingKey): GeneralSettingValue {
        switch (key) {
            case 'global_shortcut':
                return settings.value.globalShortcut;
            case 'start_on_boot':
                return settings.value.startOnBoot;
            case 'start_minimized':
                return settings.value.startMinimized;
            case 'mcp_max_iterations':
                return settings.value.mcpMaxIterations;
            case 'output_scroll_behavior':
                return settings.value.outputScrollBehavior;
            default:
                return '';
        }
    }

    async function persistDefaultIfMissing(key: GeneralSettingKey, currentValue: string | null) {
        if (currentValue !== null) {
            return;
        }
        await setSetting({ key, value: serializeSetting(key) });
    }

    async function loadFromDatabase() {
        loading.value = true;
        try {
            const [globalShortcut, startOnBoot, startMinimized, mcpMaxIterations, outputScroll] =
                await Promise.all([
                    getSettingValue({ key: 'global_shortcut' }),
                    getSettingValue({ key: 'start_on_boot' }),
                    getSettingValue({ key: 'start_minimized' }),
                    getSettingValue({ key: 'mcp_max_iterations' }),
                    getSettingValue({ key: 'output_scroll_behavior' }),
                ]);

            settings.value.globalShortcut =
                globalShortcut || DEFAULT_GENERAL_SETTINGS.globalShortcut;
            settings.value.startOnBoot =
                startOnBoot === null
                    ? DEFAULT_GENERAL_SETTINGS.startOnBoot
                    : startOnBoot === 'true';
            settings.value.startMinimized =
                startMinimized === null
                    ? DEFAULT_GENERAL_SETTINGS.startMinimized
                    : startMinimized === 'true';
            settings.value.mcpMaxIterations = normalizeMcpMaxIterations(
                mcpMaxIterations
                    ? parseInt(mcpMaxIterations, 10)
                    : DEFAULT_GENERAL_SETTINGS.mcpMaxIterations
            );
            settings.value.outputScrollBehavior = normalizeOutputScrollBehavior(outputScroll);

            await Promise.allSettled([
                persistDefaultIfMissing('global_shortcut', globalShortcut),
                persistDefaultIfMissing('start_on_boot', startOnBoot),
                persistDefaultIfMissing('start_minimized', startMinimized),
                persistDefaultIfMissing('mcp_max_iterations', mcpMaxIterations),
                persistDefaultIfMissing('output_scroll_behavior', outputScroll),
            ]);
        } finally {
            loading.value = false;
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
        applySetting(key, value);
        await setSetting({ key, value: serializeSetting(key) });
        if (broadcast) {
            await broadcastUpdate(key);
        }
    }

    async function initialize() {
        if (initialized.value) {
            return;
        }

        if (initializePromise) {
            await initializePromise;
            return;
        }

        initializePromise = (async () => {
            try {
                windowLabel.value = getCurrentWindow().label;
            } catch {
                windowLabel.value = 'unknown';
            }

            await loadFromDatabase();

            if (!unlistenSettingsUpdated) {
                unlistenSettingsUpdated = await eventService.on(
                    AppEvent.SETTINGS_GENERAL_UPDATED,
                    (payload) => {
                        if (payload.sourceId === instanceId) {
                            return;
                        }
                        applySetting(payload.key, payload.value);
                    }
                );
            }

            initialized.value = true;
        })();

        try {
            await initializePromise;
        } finally {
            initializePromise = null;
        }
    }

    async function dispose() {
        if (unlistenSettingsUpdated) {
            unlistenSettingsUpdated();
            unlistenSettingsUpdated = null;
        }
        initialized.value = false;
    }

    async function refresh() {
        await loadFromDatabase();
    }

    async function updateGlobalShortcut(shortcut: string) {
        await updateSetting('global_shortcut', shortcut);
    }

    async function updateStartOnBoot(enabled: boolean) {
        await updateSetting('start_on_boot', enabled);
    }

    async function updateStartMinimized(enabled: boolean) {
        await updateSetting('start_minimized', enabled);
    }

    async function updateMcpMaxIterations(iterations: number) {
        await updateSetting('mcp_max_iterations', normalizeMcpMaxIterations(iterations));
    }

    async function updateOutputScrollBehavior(mode: OutputScrollBehavior) {
        await updateSetting('output_scroll_behavior', mode);
    }

    const outputScrollBehavior = computed(() => settings.value.outputScrollBehavior);
    const mcpMaxIterations = computed(() => settings.value.mcpMaxIterations);
    const globalShortcut = computed(() => settings.value.globalShortcut);

    return {
        settings,
        initialized,
        loading,
        outputScrollBehavior,
        mcpMaxIterations,
        globalShortcut,
        initialize,
        dispose,
        refresh,
        updateGlobalShortcut,
        updateStartOnBoot,
        updateStartMinimized,
        updateMcpMaxIterations,
        updateOutputScrollBehavior,
    };
});
