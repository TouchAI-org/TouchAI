<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import { useListFilter } from '@composables/useListFilter';
    import { updateMcpTool } from '@database/queries';
    import type { McpServerEntity, McpToolEntity } from '@database/types';
    import { computed, onMounted, ref } from 'vue';

    import { useMcpStore } from '@/stores/mcp';
    import {
        type McpToolProperty,
        type McpToolSchema,
        parseMcpToolSchemaJson,
    } from '@/utils/mcpSchemas';

    interface Props {
        server: McpServerEntity;
    }

    const props = defineProps<Props>();

    const mcpStore = useMcpStore();
    const loading = ref(true);
    const expandedTools = ref<Set<number>>(new Set());

    const tools = computed(() => mcpStore.getServerTools(props.server.id));

    const {
        filterStatus,
        searchQuery,
        filteredItems: filteredTools,
    } = useListFilter({
        items: tools,
        getStatus: (tool) => !!tool.enabled,
        getSearchableText: (tool) => [tool.name, tool.description],
    });

    const loadTools = async () => {
        try {
            loading.value = true;
            await mcpStore.loadServerTools(props.server.id);
        } catch (error) {
            console.error('Failed to load tools:', error);
        } finally {
            loading.value = false;
        }
    };

    const toggleExpand = (toolId: number) => {
        if (expandedTools.value.has(toolId)) {
            expandedTools.value.delete(toolId);
        } else {
            expandedTools.value.add(toolId);
        }
    };

    const toggleEnabled = async (tool: McpToolEntity, event: Event) => {
        event.stopPropagation();
        try {
            await updateMcpTool(tool.id, {
                enabled: tool.enabled ? 0 : 1,
            });
            // 通过 store 重新加载数据，而不是直接修改对象
            await mcpStore.loadServerTools(props.server.id);
        } catch (error) {
            console.error('Failed to toggle tool:', error);
        }
    };

    // 缓存每个工具的 schema 解析结果，避免模板中重复 JSON.parse
    const parsedSchemas = computed(() => {
        const map = new Map<number, McpToolSchema>();
        for (const tool of tools.value) {
            map.set(tool.id, parseMcpToolSchemaJson(tool.input_schema));
        }
        return map;
    });

    const getToolSchema = (toolId: number): McpToolSchema => {
        return parsedSchemas.value.get(toolId) ?? parseMcpToolSchemaJson();
    };

    const getSchemaProperties = (schema: McpToolSchema): Record<string, McpToolProperty> | null => {
        return Object.keys(schema.properties).length > 0 ? schema.properties : null;
    };

    const getPropertyType = (prop: McpToolProperty | null): string => {
        if (!prop) return 'any';
        if (prop.type) {
            if (Array.isArray(prop.type)) {
                return prop.type.join(' | ');
            }
            return prop.type;
        }
        if (prop.enum) return 'enum';
        return 'any';
    };

    const isRequired = (schema: McpToolSchema, propName: string): boolean => {
        return schema.required?.includes(propName) ?? false;
    };

    onMounted(() => {
        loadTools();
    });
</script>

<template>
    <div class="settings-page-wide">
        <div>
            <!-- 筛选和搜索栏 -->
            <div class="mb-4 flex items-center justify-between gap-4">
                <!-- 筛选标签 -->
                <div class="flex gap-2">
                    <button
                        :class="[
                            'rounded-[10px] px-3 py-1.5 text-sm transition-colors',
                            filterStatus === 'all'
                                ? 'bg-[#e9e9e7] text-neutral-950'
                                : 'bg-transparent text-neutral-600 hover:bg-[#f1f1ef]',
                        ]"
                        @click="filterStatus = 'all'"
                    >
                        全部
                    </button>
                    <button
                        :class="[
                            'rounded-[10px] px-3 py-1.5 text-sm transition-colors',
                            filterStatus === 'enabled'
                                ? 'bg-[#e9e9e7] text-neutral-950'
                                : 'bg-transparent text-neutral-600 hover:bg-[#f1f1ef]',
                        ]"
                        @click="filterStatus = 'enabled'"
                    >
                        已启用
                    </button>
                    <button
                        :class="[
                            'rounded-[10px] px-3 py-1.5 text-sm transition-colors',
                            filterStatus === 'disabled'
                                ? 'bg-[#e9e9e7] text-neutral-950'
                                : 'bg-transparent text-neutral-600 hover:bg-[#f1f1ef]',
                        ]"
                        @click="filterStatus = 'disabled'"
                    >
                        已禁用
                    </button>
                </div>

                <!-- 搜索框 -->
                <div class="relative w-64">
                    <input
                        v-model="searchQuery"
                        type="text"
                        placeholder="搜索工具..."
                        class="settings-input w-full py-1.5 pr-3 pl-9"
                    />
                    <AppIcon
                        name="search"
                        class="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-neutral-400"
                    />
                </div>
            </div>

            <div v-if="loading" class="space-y-3">
                <div v-for="i in 3" :key="i" class="h-24 animate-pulse rounded-lg bg-neutral-100" />
            </div>

            <div v-else-if="filteredTools.length === 0" class="py-12 text-center">
                <AppIcon name="mcp" class="mx-auto h-16 w-16 text-neutral-300" />
                <p class="mt-4 text-sm text-neutral-500">
                    {{ searchQuery ? '未找到匹配的工具' : '暂无工具' }}
                </p>
                <p class="mt-1 text-xs text-neutral-400">
                    {{ searchQuery ? '尝试其他搜索关键词' : '连接服务器后将自动发现工具' }}
                </p>
            </div>

            <div v-else class="space-y-3">
                <div
                    v-for="tool in filteredTools"
                    :key="tool.id"
                    class="overflow-hidden rounded-[13px] border border-neutral-200/70 bg-white"
                >
                    <button
                        class="w-full p-4 text-left transition-colors hover:bg-neutral-50/70"
                        @click="toggleExpand(tool.id)"
                    >
                        <div class="flex items-start justify-between">
                            <div class="min-w-0 flex-1">
                                <div class="flex items-center gap-2">
                                    <h3 class="text-[15px] font-medium text-neutral-950">
                                        {{ tool.name }}
                                    </h3>
                                    <button
                                        :class="[
                                            'relative inline-flex h-5 w-9 items-center rounded-full transition-colors',
                                            tool.enabled ? 'bg-primary-700' : 'bg-neutral-200',
                                        ]"
                                        @click="toggleEnabled(tool, $event)"
                                    >
                                        <span
                                            :class="[
                                                'inline-block h-3 w-3 transform rounded-full bg-white transition-transform',
                                                tool.enabled ? 'translate-x-5' : 'translate-x-1',
                                            ]"
                                        />
                                    </button>
                                </div>
                                <p
                                    v-if="tool.description"
                                    :class="[
                                        'mt-1 text-xs text-gray-500',
                                        !expandedTools.has(tool.id) && 'line-clamp-2',
                                    ]"
                                >
                                    {{ tool.description }}
                                </p>
                            </div>

                            <AppIcon
                                name="chevron-right"
                                :class="
                                    expandedTools.has(tool.id)
                                        ? 'ml-4 h-5 w-5 flex-shrink-0 rotate-90 text-neutral-400 transition-transform'
                                        : 'ml-4 h-5 w-5 flex-shrink-0 text-neutral-400 transition-transform'
                                "
                            />
                        </div>
                    </button>

                    <div
                        v-if="expandedTools.has(tool.id)"
                        class="border-t border-neutral-200/70 bg-neutral-50/70 p-4"
                    >
                        <h4 class="mb-2 text-xs font-medium text-neutral-700">输入参数</h4>

                        <template v-if="getToolSchema(tool.id)">
                            <template v-if="getSchemaProperties(getToolSchema(tool.id))">
                                <div
                                    v-if="
                                        Object.keys(getSchemaProperties(getToolSchema(tool.id))!)
                                            .length === 0
                                    "
                                    class="rounded-lg bg-white p-3 text-center text-xs text-neutral-500"
                                >
                                    无参数
                                </div>
                                <div
                                    v-else
                                    class="overflow-hidden rounded-lg border border-neutral-200 bg-white"
                                >
                                    <table class="w-full">
                                        <thead class="bg-neutral-50">
                                            <tr>
                                                <th
                                                    class="border-b border-neutral-200 px-3 py-2 text-left text-xs font-medium text-neutral-700"
                                                >
                                                    参数名
                                                </th>
                                                <th
                                                    class="border-b border-neutral-200 px-3 py-2 text-left text-xs font-medium text-neutral-700"
                                                >
                                                    类型
                                                </th>
                                                <th
                                                    class="border-b border-neutral-200 px-3 py-2 text-left text-xs font-medium text-neutral-700"
                                                >
                                                    必填
                                                </th>
                                                <th
                                                    class="border-b border-neutral-200 px-3 py-2 text-left text-xs font-medium text-neutral-700"
                                                >
                                                    描述
                                                </th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            <tr
                                                v-for="(prop, propName) in getSchemaProperties(
                                                    getToolSchema(tool.id)
                                                )"
                                                :key="propName"
                                                class="border-b border-neutral-100 last:border-0"
                                            >
                                                <td
                                                    class="px-3 py-2 font-mono text-xs text-neutral-950"
                                                >
                                                    {{ propName }}
                                                </td>
                                                <td
                                                    class="px-3 py-2 font-mono text-xs text-neutral-600"
                                                >
                                                    {{ getPropertyType(prop) }}
                                                </td>
                                                <td class="px-3 py-2 text-xs">
                                                    <span
                                                        v-if="
                                                            isRequired(
                                                                getToolSchema(tool.id),
                                                                String(propName)
                                                            )
                                                        "
                                                        class="rounded bg-red-100 px-1.5 py-0.5 text-red-700"
                                                    >
                                                        是
                                                    </span>
                                                    <span v-else class="text-gray-400">否</span>
                                                </td>
                                                <td class="px-3 py-2 text-xs text-neutral-600">
                                                    {{ prop.description || '-' }}
                                                </td>
                                            </tr>
                                        </tbody>
                                    </table>
                                </div>
                            </template>
                            <pre
                                v-else
                                class="overflow-x-auto rounded-lg bg-white p-3 font-mono text-xs text-neutral-950"
                                >{{ JSON.stringify(getToolSchema(tool.id), null, 2) }}</pre
                            >
                        </template>
                        <pre
                            v-else
                            class="overflow-x-auto rounded-lg bg-white p-3 font-mono text-xs text-neutral-950"
                            >{{ tool.input_schema }}</pre
                        >
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>
