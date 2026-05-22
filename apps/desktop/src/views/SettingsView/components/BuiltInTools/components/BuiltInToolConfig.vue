<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import { onUnmounted, ref, watch } from 'vue';

    import { serializeUpgradeModelToolConfig } from '@/services/BuiltInToolService/tools/upgradeModel/config';

    import type { BuiltInToolEntity, BuiltInToolUpdateData } from '../types';
    import {
        type BashToolConfig as BashToolConfigValue,
        parseBashToolConfig,
        parseUpgradeModelToolConfig,
        type UpgradeModelToolConfig as UpgradeModelToolConfigValue,
        usesBuiltInToolEmptyConfig,
    } from '../types';
    import BashToolConfig from './BashToolConfig.vue';
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
    let autoSaveTimer: ReturnType<typeof setTimeout> | null = null;

    watch(
        () => props.tool,
        (tool) => {
            bashConfig.value = parseBashToolConfig(tool.config_json);
            upgradeModelConfig.value = parseUpgradeModelToolConfig(tool.config_json);
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

    onUnmounted(() => {
        if (autoSaveTimer) {
            clearTimeout(autoSaveTimer);
            autoSaveTimer = null;
        }
    });
</script>

<template>
    <div class="space-y-4 p-6">
        <BashToolConfig v-if="tool.tool_id === 'bash'" v-model="bashConfig" />
        <UpgradeModelToolConfig
            v-else-if="tool.tool_id === 'upgrade_model'"
            v-model="upgradeModelConfig"
        />
        <div
            v-else-if="usesBuiltInToolEmptyConfig(tool.tool_id)"
            class="rounded-xl border border-dashed border-gray-200 bg-white px-5 py-12 text-center"
        >
            <p class="font-serif text-sm text-gray-500">该工具无需在此配置</p>
        </div>

        <div
            v-else
            class="rounded-xl border border-dashed border-gray-200 bg-white px-5 py-10 text-center"
        >
            <p class="font-serif text-sm text-gray-500">该工具的配置表单将在后续批次接入。</p>
        </div>
    </div>
</template>
