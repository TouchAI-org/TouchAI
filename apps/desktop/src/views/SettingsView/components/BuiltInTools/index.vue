<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import AlertMessage from '@components/AlertMessage.vue';
    import AppIcon from '@components/AppIcon.vue';
    import { useScrollbarStabilizer } from '@composables/useScrollbarStabilizer';
    import { computed, onMounted, ref, watch } from 'vue';

    import SectionTabs, { type SectionTabItem } from '../SectionTabs.vue';
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
    const tools = ref<BuiltInToolEntity[]>([]);
    const selectedTool = ref<BuiltInToolEntity | null>(null);
    const loading = ref(true);
    const saving = ref(false);
    const togglingToolIds = ref<Set<number>>(new Set());
    const queuedPatch = ref<BuiltInToolUpdateData | null>(null);
    const activeTab = ref<'config' | 'logs'>('config');
    const baseTabs: SectionTabItem<'config' | 'logs'>[] = [
        { value: 'config', label: '配置' },
        { value: 'logs', label: '调用日志' },
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
            alertMessage.value?.error('加载内置工具失败', 6000);
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

    async function handleToggleEnabled(toolId: number, enabled: boolean) {
        if (togglingToolIds.value.has(toolId)) {
            return;
        }

        togglingToolIds.value.add(toolId);
        try {
            const queries = await loadBuiltInToolQueries();
            const updatedTool = await queries.updateBuiltInTool(toolId, {
                enabled: enabled ? 1 : 0,
            });
            if (!updatedTool) {
                throw new Error(`Built-in tool not found after update: ${toolId}`);
            }
            await loadTools();
        } catch (error) {
            console.error('[BuiltInToolsView] Failed to toggle tool enabled:', error);
            alertMessage.value?.error('更新工具启用状态失败', 6000);
        } finally {
            togglingToolIds.value.delete(toolId);
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

        const currentToolId = selectedTool.value.id;
        saving.value = true;
        try {
            const queries = await loadBuiltInToolQueries();
            const nextTool = await queries.updateBuiltInTool(currentToolId, patch);
            if (!nextTool) {
                throw new Error(`Built-in tool not found after update: ${currentToolId}`);
            }
            applyToolUpdate(nextTool);
        } catch (error) {
            console.error('[BuiltInToolsView] Failed to update tool:', error);
            alertMessage.value?.error('保存内置工具配置失败', 6000);
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

    <div class="flex h-full">
        <div class="flex h-full w-72 flex-col border-r border-gray-200 bg-white/60">
            <div class="border-b border-gray-200 bg-white/80 p-4">
                <h2 class="font-serif text-base font-semibold text-gray-900">内置工具</h2>
            </div>

            <BuiltInToolList
                :tools="tools"
                :selected-tool-id="selectedTool?.tool_id ?? null"
                :toggling-tool-ids="togglingToolIds"
                @select="handleSelect"
                @toggle-enabled="handleToggleEnabled"
            />
        </div>

        <div class="flex min-w-0 flex-1 flex-col">
            <div v-if="loading" class="flex flex-1 items-center justify-center">
                <div class="space-y-3 text-center">
                    <div
                        class="border-t-primary-500 mx-auto h-10 w-10 animate-spin rounded-full border-2 border-gray-200"
                    />
                    <p class="font-serif text-sm text-gray-500">正在加载内置工具配置...</p>
                </div>
            </div>

            <div
                v-else-if="!selectedTool"
                class="flex flex-1 items-center justify-center px-6 text-center"
            >
                <div class="max-w-md">
                    <AppIcon name="tool" class="mx-auto h-12 w-12 text-gray-300" />
                    <h3 class="mt-4 font-serif text-base font-semibold text-gray-900">
                        尚未发现可配置的内置工具
                    </h3>
                    <p class="mt-2 font-serif text-sm leading-6 text-gray-500">
                        等待网关注册完成后，工具会自动显示在左侧列表中。
                    </p>
                </div>
            </div>

            <template v-else>
                <SectionTabs v-model="activeTab" :tabs="tabs" />

                <div
                    ref="tabContentRef"
                    class="custom-scrollbar min-h-0 flex-1 overflow-y-auto bg-gray-50/50"
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
