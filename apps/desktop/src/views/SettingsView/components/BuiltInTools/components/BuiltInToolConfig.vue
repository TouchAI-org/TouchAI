<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import { onUnmounted, ref, watch } from 'vue';

    import { t } from '@/i18n';
    import { serializeUpgradeModelToolConfig } from '@/services/BuiltInToolService/tools/upgradeModel/config';

    import type { BuiltInToolEntity, BuiltInToolUpdateData } from '../types';
    import {
        type BashToolConfig as BashToolConfigValue,
        type BrowserAutomationToolConfig as BrowserAutomationToolConfigValue,
        getBrowserAutomationStartupUrlError,
        isBrowserAutomationToolId,
        parseBashToolConfig,
        parseBrowserAutomationToolConfig,
        parseUpgradeModelToolConfig,
        serializeBrowserAutomationToolConfig,
        type UpgradeModelToolConfig as UpgradeModelToolConfigValue,
        usesBuiltInToolEmptyConfig,
    } from '../types';
    import BashToolConfig from './BashToolConfig.vue';
    import BrowserAutomationToolConfig from './BrowserAutomationToolConfig.vue';
    import UpgradeModelToolConfig from './UpgradeModelToolConfig.vue';
    interface Props {
        tool: BuiltInToolEntity;
        saving?: boolean;
    }

    interface Emits {
        (e: 'save', patch: BuiltInToolUpdateData): void;
    }

    const props = defineProps<Props>();
    const emit = defineEmits<Emits>();

    const bashConfig = ref<BashToolConfigValue>(parseBashToolConfig(props.tool.config_json));
    const browserAutomationConfig = ref<BrowserAutomationToolConfigValue>(
        parseBrowserAutomationToolConfig(props.tool.config_json)
    );
    const upgradeModelConfig = ref<UpgradeModelToolConfigValue>(
        parseUpgradeModelToolConfig(props.tool.config_json)
    );
    let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;

    function clearAutoSaveTimer() {
        if (autoSaveTimer) {
            clearTimeout(autoSaveTimer);
            autoSaveTimer = null;
        }
    }

    watch(
        () => props.tool,
        (tool) => {
            clearAutoSaveTimer();
            bashConfig.value = parseBashToolConfig(tool.config_json);
            browserAutomationConfig.value = parseBrowserAutomationToolConfig(tool.config_json);
            upgradeModelConfig.value = parseUpgradeModelToolConfig(tool.config_json);
        },
        { deep: true }
    );

    watch(
        () => JSON.stringify(bashConfig.value),
        (nextConfigJson) => {
            if (props.tool.tool_id !== 'bash') {
                clearAutoSaveTimer();
                return;
            }

            if (nextConfigJson === JSON.stringify(parseBashToolConfig(props.tool.config_json))) {
                clearAutoSaveTimer();
                return;
            }

            clearAutoSaveTimer();

            autoSaveTimer = setTimeout(() => {
                emit('save', {
                    config_json: nextConfigJson,
                });
                autoSaveTimer = null;
            }, 450);
        }
    );

    watch(
        () => JSON.stringify(browserAutomationConfig.value),
        () => {
            if (!isBrowserAutomationToolId(props.tool.tool_id)) {
                clearAutoSaveTimer();
                return;
            }

            if (getBrowserAutomationStartupUrlError(browserAutomationConfig.value)) {
                clearAutoSaveTimer();
                return;
            }

            const currentConfigJson = serializeBrowserAutomationToolConfig(
                parseBrowserAutomationToolConfig(props.tool.config_json)
            );
            const nextConfigJson = serializeBrowserAutomationToolConfig(
                browserAutomationConfig.value
            );

            if (nextConfigJson === currentConfigJson) {
                clearAutoSaveTimer();
                return;
            }

            clearAutoSaveTimer();

            autoSaveTimer = setTimeout(() => {
                emit('save', {
                    config_json: nextConfigJson,
                });
                autoSaveTimer = null;
            }, 450);
        }
    );

    watch(
        () => JSON.stringify(upgradeModelConfig.value),
        () => {
            if (props.tool.tool_id !== 'upgrade_model') {
                clearAutoSaveTimer();
                return;
            }

            const currentConfigJson = serializeUpgradeModelToolConfig(
                parseUpgradeModelToolConfig(props.tool.config_json)
            );
            const nextConfigJson = serializeUpgradeModelToolConfig(upgradeModelConfig.value);

            if (nextConfigJson === currentConfigJson) {
                clearAutoSaveTimer();
                return;
            }

            clearAutoSaveTimer();

            autoSaveTimer = setTimeout(() => {
                emit('save', {
                    config_json: nextConfigJson,
                });
                autoSaveTimer = null;
            }, 450);
        }
    );

    onUnmounted(() => {
        clearAutoSaveTimer();
    });
</script>

<template>
    <div class="settings-page-wide space-y-4">
        <BashToolConfig v-if="tool.tool_id === 'bash'" v-model="bashConfig" />
        <BrowserAutomationToolConfig
            v-else-if="isBrowserAutomationToolId(tool.tool_id)"
            v-model="browserAutomationConfig"
            :disabled="saving || tool.enabled === 0"
        />
        <UpgradeModelToolConfig
            v-else-if="tool.tool_id === 'upgrade_model'"
            v-model="upgradeModelConfig"
        />
        <div
            v-else-if="usesBuiltInToolEmptyConfig(tool.tool_id)"
            class="rounded-lg border border-dashed border-neutral-200 bg-neutral-50/60 px-5 py-12 text-center"
        >
            <p class="text-sm text-neutral-500">{{ t('settings.builtInTools.noConfig') }}</p>
        </div>

        <div
            v-else
            class="rounded-lg border border-dashed border-neutral-200 bg-neutral-50/60 px-5 py-10 text-center"
        >
            <p class="text-sm text-neutral-500">
                {{ t('settings.builtInTools.configComingSoon') }}
            </p>
        </div>
    </div>
</template>
