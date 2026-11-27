<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import EmptyState from '@components/EmptyState.vue';
    import { Switch } from '@components/ui/switch';
    import { onUnmounted, ref, watch } from 'vue';

    import {
        serializeReadConversationToolConfig,
        serializeSearchConversationToolConfig,
        serializeUpgradeModelToolConfig,
    } from '@/app/api/tools/configuration';
    import { t } from '@/i18n';

    import type { BuiltInToolEntity, BuiltInToolUpdateData } from '../types';
    import {
        type BashToolConfig as BashToolConfigValue,
        parseBashToolConfig,
        parseReadConversationToolConfig,
        parseSearchConversationToolConfig,
        parseUpgradeModelToolConfig,
        type ReadConversationToolConfig as ReadConversationToolConfigValue,
        type SearchConversationToolConfig as SearchConversationToolConfigValue,
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
    const searchConversationConfig = ref<SearchConversationToolConfigValue>(
        parseSearchConversationToolConfig(props.tool.config_json)
    );
    const readConversationConfig = ref<ReadConversationToolConfigValue>(
        parseReadConversationToolConfig(props.tool.config_json)
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
            upgradeModelConfig.value = parseUpgradeModelToolConfig(tool.config_json);
            searchConversationConfig.value = parseSearchConversationToolConfig(tool.config_json);
            readConversationConfig.value = parseReadConversationToolConfig(tool.config_json);
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

    watch(
        () => JSON.stringify(searchConversationConfig.value),
        () => {
            if (props.tool.tool_id !== 'search_conversation') {
                clearAutoSaveTimer();
                return;
            }

            const currentConfigJson = serializeSearchConversationToolConfig(
                parseSearchConversationToolConfig(props.tool.config_json)
            );
            const nextConfigJson = serializeSearchConversationToolConfig(
                searchConversationConfig.value
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

    function setSearchConversationEnabled(enabled: boolean) {
        if (props.tool.tool_id !== 'search_conversation') return;
        searchConversationConfig.value = { enabled };
    }

    watch(
        () => JSON.stringify(readConversationConfig.value),
        () => {
            if (props.tool.tool_id !== 'read_conversation') {
                return;
            }

            const currentConfigJson = serializeReadConversationToolConfig(
                parseReadConversationToolConfig(props.tool.config_json)
            );
            const nextConfigJson = serializeReadConversationToolConfig(
                readConversationConfig.value
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

    function setReadConversationEnabled(enabled: boolean) {
        if (props.tool.tool_id !== 'read_conversation') return;
        readConversationConfig.value = { enabled };
    }

    onUnmounted(() => {
        clearAutoSaveTimer();
    });
</script>

<template>
    <div class="settings-page-wide space-y-4">
        <BashToolConfig v-if="tool.tool_id === 'bash'" v-model="bashConfig" />
        <UpgradeModelToolConfig
            v-else-if="tool.tool_id === 'upgrade_model'"
            v-model="upgradeModelConfig"
        />
        <div
            v-else-if="tool.tool_id === 'search_conversation'"
            class="flex items-start justify-between gap-6 rounded-lg bg-surface-hover px-4 py-3"
        >
            <div class="min-w-0">
                <h4 class="text-sm font-semibold text-text-primary">
                    {{ t('settings.builtInTools.searchConversation.title') }}
                </h4>
                <p class="mt-1 text-sm leading-6 text-muted-foreground">
                    {{ t('settings.builtInTools.searchConversation.description') }}
                </p>
            </div>
            <Switch
                data-testid="conversation-search-enabled"
                :aria-label="t('settings.builtInTools.searchConversation.title')"
                :model-value="searchConversationConfig.enabled"
                :disabled="saving"
                @update:model-value="setSearchConversationEnabled"
            />
        </div>
        <div
            v-else-if="tool.tool_id === 'read_conversation'"
            class="flex items-start justify-between gap-6 rounded-lg bg-surface-hover px-4 py-3"
        >
            <div class="min-w-0">
                <h4 class="text-sm font-semibold text-text-primary">
                    {{ t('settings.builtInTools.readConversation.title') }}
                </h4>
                <p class="mt-1 text-sm leading-6 text-muted-foreground">
                    {{ t('settings.builtInTools.readConversation.description') }}
                </p>
            </div>
            <Switch
                data-testid="conversation-read-enabled"
                :aria-label="t('settings.builtInTools.readConversation.title')"
                :model-value="readConversationConfig.enabled"
                :disabled="saving"
                @update:model-value="setReadConversationEnabled"
            />
        </div>
        <EmptyState
            v-else-if="usesBuiltInToolEmptyConfig(tool.tool_id)"
            :title="t('settings.builtInTools.noConfig')"
            icon="tool"
        />

        <EmptyState v-else :title="t('settings.builtInTools.configComingSoon')" icon="tool" />
    </div>
</template>
