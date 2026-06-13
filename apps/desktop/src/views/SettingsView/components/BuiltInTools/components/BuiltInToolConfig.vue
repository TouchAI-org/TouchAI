<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import { onUnmounted, ref, watch } from 'vue';

    import { t } from '@/i18n';
    import { serializeDesktopContextToolConfig } from '@/services/BuiltInToolService/tools/desktopContext/config';
    import { serializeUpgradeModelToolConfig } from '@/services/BuiltInToolService/tools/upgradeModel/config';

    import type { BuiltInToolEntity, BuiltInToolUpdateData } from '../types';
    import {
        type BashToolConfig as BashToolConfigValue,
        type DesktopContextToolConfig as DesktopContextToolConfigValue,
        parseBashToolConfig,
        parseDesktopContextToolConfig,
        parseUpgradeModelToolConfig,
        type UpgradeModelToolConfig as UpgradeModelToolConfigValue,
        usesBuiltInToolEmptyConfig,
    } from '../types';
    import BashToolConfig from './BashToolConfig.vue';
    import DesktopContextToolConfig from './DesktopContextToolConfig.vue';
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
    const upgradeModelConfig = ref<UpgradeModelToolConfigValue>(
        parseUpgradeModelToolConfig(props.tool.config_json)
    );
    const desktopContextConfig = ref<DesktopContextToolConfigValue>(
        parseDesktopContextToolConfig(props.tool.config_json)
    );
    let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;

    watch(
        () => props.tool,
        (tool) => {
            bashConfig.value = parseBashToolConfig(tool.config_json);
            upgradeModelConfig.value = parseUpgradeModelToolConfig(tool.config_json);
            desktopContextConfig.value = parseDesktopContextToolConfig(tool.config_json);
        },
        { deep: true }
    );

    watch(
        () => JSON.stringify(bashConfig.value),
        (nextConfigJson) => {
            if (props.tool.tool_id !== 'bash') {
                if (autoSaveTimer) {
                    clearTimeout(autoSaveTimer);
                    autoSaveTimer = null;
                }
                return;
            }

            if (nextConfigJson === JSON.stringify(parseBashToolConfig(props.tool.config_json))) {
                if (autoSaveTimer) {
                    clearTimeout(autoSaveTimer);
                    autoSaveTimer = null;
                }
                return;
            }

            if (autoSaveTimer) {
                clearTimeout(autoSaveTimer);
            }

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
                return;
            }

            const currentConfigJson = serializeUpgradeModelToolConfig(
                parseUpgradeModelToolConfig(props.tool.config_json)
            );
            const nextConfigJson = serializeUpgradeModelToolConfig(upgradeModelConfig.value);

            if (nextConfigJson === currentConfigJson) {
                if (autoSaveTimer) {
                    clearTimeout(autoSaveTimer);
                    autoSaveTimer = null;
                }
                return;
            }

            if (autoSaveTimer) {
                clearTimeout(autoSaveTimer);
            }

            autoSaveTimer = setTimeout(() => {
                emit('save', {
                    config_json: nextConfigJson,
                });
                autoSaveTimer = null;
            }, 450);
        }
    );

    watch(
        () => JSON.stringify(desktopContextConfig.value),
        () => {
            if (props.tool.tool_id !== 'get_desktop_context') {
                return;
            }

            const currentConfigJson = serializeDesktopContextToolConfig(
                parseDesktopContextToolConfig(props.tool.config_json)
            );
            const nextConfigJson = serializeDesktopContextToolConfig(desktopContextConfig.value);

            if (nextConfigJson === currentConfigJson) {
                if (autoSaveTimer) {
                    clearTimeout(autoSaveTimer);
                    autoSaveTimer = null;
                }
                return;
            }

            if (autoSaveTimer) {
                clearTimeout(autoSaveTimer);
            }

            autoSaveTimer = setTimeout(() => {
                emit('save', {
                    config_json: nextConfigJson,
                });
                autoSaveTimer = null;
            }, 450);
        }
    );

    onUnmounted(() => {
        if (autoSaveTimer) {
            clearTimeout(autoSaveTimer);
            autoSaveTimer = null;
        }
    });
</script>

<template>
    <div class="settings-page-wide space-y-4">
        <BashToolConfig v-if="tool.tool_id === 'bash'" v-model="bashConfig" />
        <UpgradeModelToolConfig
            v-else-if="tool.tool_id === 'upgrade_model'"
            v-model="upgradeModelConfig"
        />
        <DesktopContextToolConfig
            v-else-if="tool.tool_id === 'get_desktop_context'"
            v-model="desktopContextConfig"
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
