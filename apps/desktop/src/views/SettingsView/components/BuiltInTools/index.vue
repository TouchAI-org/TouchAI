<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import AlertMessage from '@components/AlertMessage.vue';
    import AppIcon from '@components/AppIcon.vue';
    import LoadingState from '@components/LoadingState.vue';
    import { useScrollbarStabilizer } from '@composables/useScrollbarStabilizer';
    import { computed, onMounted, ref, watch } from 'vue';

    import { t } from '@/i18n';

    import { useSettingsResizablePanel } from '../../composables/useSettingsResizablePanel';
    import SectionTabs, { type SectionTabItem } from '../SectionTabs.vue';
    import { getBuiltInToolUpdateTargets } from './browserToolGroup';
    import BuiltInToolConfig from './components/BuiltInToolConfig.vue';
    import BuiltInToolList from './components/BuiltInToolList.vue';
    import BuiltInToolLogViewer from './components/BuiltInToolLogViewer.vue';
    import {
        type BuiltInToolEntity,
        type BuiltInToolUpdateData,
        isBuiltInToolVisibleInSettings,
        loadBuiltInToolQueries,
        usesBuiltInToolEmptyConfig,
    } from './types';
    defineOptions({
        name: 'SettingsBuiltInToolsSection',
    });

    const alertMessage = ref<InstanceType<typeof AlertMessage> | null>(null);
    const {
        handleResizeKeyDown,
        handleResizePointerDown,
        panelMaxWidth,
        panelMinWidth,
        panelStyle,
        panelWidth,
    } = useSettingsResizablePanel();
    const tools = ref<BuiltInToolEntity[]>([]);
    const selectedTool = ref<BuiltInToolEntity | null>(null);
    const loading = ref(true);
    const saving = ref(false);
    const togglingToolIds = ref<Set<number>>(new Set());
    const queuedPatch = ref<BuiltInToolUpdateData | null>(null);
    const activeTab = ref<'config' | 'logs'>('config');
    const baseTabs: SectionTabItem<'config' | 'logs'>[] = [
        { value: 'config', label: t('settings.builtInTools.tabs.config') },
        { value: 'logs', label: t('settings.builtInTools.tabs.logs') },
    ];
    const tabs = computed<SectionTabItem<'config' | 'logs'>[]>(() => {
        if (selectedTool.value && usesBuiltInToolEmptyConfig(selectedTool.value.tool_id)) {
            return baseTabs.filter((tab) => tab.value !== 'config');
        }

        return baseTabs;
    });
    const tabContentRef = ref<HTMLElement | null>(null);
    useScrollbarStabilizer(tabContentRef);

    /**
     * 空配置工具会隐藏“配置”标签，切换时需要把当前标签同步到仍然可见的项。
     */
    watch(
        tabs,
        (nextTabs) => {
            if (nextTabs.some((tab) => tab.value === activeTab.value)) {
                return;
            }

            activeTab.value = nextTabs[0]?.value ?? 'logs';
        },
        { immediate: true }
    );

    async function loadTools() {
        loading.value = true;
        try {
            const queries = await loadBuiltInToolQueries();
            const nextTools = (await queries.findAllBuiltInTools()).filter((tool) =>
                isBuiltInToolVisibleInSettings(tool.tool_id)
            );
            tools.value = nextTools;

            if (!selectedTool.value && nextTools.length > 0) {
                selectedTool.value = nextTools[0] ?? null;
                return;
            }

            if (selectedTool.value) {
                selectedTool.value =
                    nextTools.find((tool) => tool.tool_id === selectedTool.value?.tool_id) ?? null;
            }
        } catch (error) {
            console.error('[BuiltInToolsView] Failed to load tools:', error);
            alertMessage.value?.error(t('settings.builtInTools.loadFailed'), 6000);
            tools.value = [];
            selectedTool.value = null;
        } finally {
            loading.value = false;
        }
    }

    function handleSelect(tool: BuiltInToolEntity) {
        queuedPatch.value = null;
        selectedTool.value = tool;
        activeTab.value = usesBuiltInToolEmptyConfig(tool.tool_id) ? 'logs' : 'config';
    }

    function applyToolUpdate(nextTool: BuiltInToolEntity) {
        tools.value = tools.value.map((tool) => (tool.id === nextTool.id ? nextTool : tool));

        if (selectedTool.value?.id === nextTool.id) {
            selectedTool.value = nextTool;
        }
    }

    function updateTogglingToolIds(toolIds: number[], active: boolean) {
        const next = new Set(togglingToolIds.value);
        for (const toolId of toolIds) {
            if (active) {
                next.add(toolId);
            } else {
                next.delete(toolId);
            }
        }
        togglingToolIds.value = next;
    }

    async function updateTargetTools(
        targetTools: BuiltInToolEntity[],
        patch: BuiltInToolUpdateData
    ): Promise<BuiltInToolEntity[]> {
        const queries = await loadBuiltInToolQueries();
        const targetToolIds = targetTools.map((targetTool) => targetTool.id);
        if (targetTools.length > 1) {
            return await queries.updateBuiltInTools(targetToolIds, patch);
        }

        const targetTool = targetTools[0];
        if (!targetTool) {
            return [];
        }

        const updatedTool = await queries.updateBuiltInTool(targetTool.id, patch);
        if (!updatedTool) {
            throw new Error(`Built-in tool not found after update: ${targetTool.id}`);
        }

        return [updatedTool];
    }

    async function handleToggleEnabled(toolId: number, enabled: boolean) {
        const tool = tools.value.find((candidate) => candidate.id === toolId);
        const targetTools = getBuiltInToolUpdateTargets(tools.value, tool);
        const targetToolIds = targetTools.map((targetTool) => targetTool.id);
        if (
            targetToolIds.length === 0 ||
            targetToolIds.some((id) => togglingToolIds.value.has(id))
        ) {
            return;
        }

        updateTogglingToolIds(targetToolIds, true);
        try {
            const patch = {
                enabled: enabled ? 1 : 0,
            };
            const updatedTools = await updateTargetTools(targetTools, patch);
            for (const updatedTool of updatedTools) {
                applyToolUpdate(updatedTool);
            }
        } catch (error) {
            console.error('[BuiltInToolsView] Failed to toggle tool enabled:', error);
            alertMessage.value?.error(t('settings.builtInTools.updateEnabledFailed'), 6000);
        } finally {
            updateTogglingToolIds(targetToolIds, false);
        }
    }

    async function handleSave(patch: BuiltInToolUpdateData) {
        if (!selectedTool.value) {
            return;
        }

        if (saving.value) {
            queuedPatch.value = {
                ...(queuedPatch.value ?? {}),
                ...patch,
            };
            return;
        }

        const currentTool = selectedTool.value;
        const currentToolId = currentTool.id;
        const targetTools = getBuiltInToolUpdateTargets(tools.value, currentTool);
        saving.value = true;
        try {
            const updatedTools = await updateTargetTools(targetTools, patch);
            for (const updatedTool of updatedTools) {
                applyToolUpdate(updatedTool);
            }
        } catch (error) {
            console.error('[BuiltInToolsView] Failed to update tool:', error);
            alertMessage.value?.error(t('settings.builtInTools.saveConfigFailed'), 6000);
        } finally {
            saving.value = false;

            if (queuedPatch.value && selectedTool.value?.id === currentToolId) {
                const nextPatch = queuedPatch.value;
                queuedPatch.value = null;
                await handleSave(nextPatch);
            }
        }
    }

    onMounted(() => {
        void loadTools();
    });
</script>

<template>
    <AlertMessage ref="alertMessage" />

    <div class="flex h-full bg-white">
        <div
            class="settings-side-panel"
            :style="panelStyle"
            data-settings-secondary-panel="true"
            data-testid="settings-built-in-tools-panel"
        >
            <BuiltInToolList
                :tools="tools"
                :selected-tool-id="selectedTool?.tool_id ?? null"
                :toggling-tool-ids="togglingToolIds"
                @select="handleSelect"
                @toggle-enabled="handleToggleEnabled"
            />

            <div
                data-testid="settings-built-in-tools-panel-resizer"
                role="separator"
                aria-orientation="vertical"
                :aria-valuemin="panelMinWidth"
                :aria-valuemax="panelMaxWidth"
                :aria-valuenow="panelWidth"
                tabindex="0"
                class="settings-side-panel-resizer"
                :title="t('settings.builtInTools.resizeList')"
                @keydown="handleResizeKeyDown"
                @pointerdown="handleResizePointerDown"
            />
        </div>

        <div class="flex min-w-0 flex-1 flex-col">
            <LoadingState v-if="loading" variant="brand" fill="min" />

            <div
                v-else-if="!selectedTool"
                class="flex flex-1 items-center justify-center px-6 text-center"
            >
                <div class="max-w-md">
                    <AppIcon name="tool" class="mx-auto h-12 w-12 text-neutral-300" />
                    <h3 class="mt-4 text-[15px] font-medium text-neutral-950">
                        {{ t('settings.builtInTools.emptyConfigurable') }}
                    </h3>
                    <p class="mt-2 text-sm leading-6 text-neutral-500">
                        {{ t('settings.builtInTools.emptyConfigurableDescription') }}
                    </p>
                </div>
            </div>

            <template v-else>
                <SectionTabs v-model="activeTab" :tabs="tabs" />

                <div
                    ref="tabContentRef"
                    class="settings-scrollbar min-h-0 flex-1 overflow-y-auto bg-white"
                >
                    <BuiltInToolConfig
                        v-if="activeTab === 'config'"
                        :tool="selectedTool"
                        :saving="saving"
                        @save="handleSave"
                    />
                    <BuiltInToolLogViewer v-else :tool="selectedTool" />
                </div>
            </template>
        </div>
    </div>
</template>
