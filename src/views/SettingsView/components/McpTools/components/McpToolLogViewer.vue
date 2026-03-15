<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import SvgIcon from '@components/SvgIcon.vue';
    import ToolLogContent from '@components/ToolLogContent.vue';
    import { useListFilter } from '@composables/useListFilter';
    import { findMcpToolLogsByServerId } from '@database/queries';
    import type { McpServerEntity, McpToolLogEntity } from '@database/types';
    import { onMounted, ref } from 'vue';

    interface Props {
        server: McpServerEntity;
    }

    const props = defineProps<Props>();

    const logs = ref<McpToolLogEntity[]>([]);
    const loading = ref(true);
    const loadingMore = ref(false);
    const expandedLogs = ref<Set<number>>(new Set());
    const PAGE_SIZE = 100;
    const hasMore = ref(false);

    const {
        filterStatus,
        searchQuery,
        filteredItems: filteredLogs,
    } = useListFilter({
        items: logs,
        getStatus: (log) => log.status,
        getSearchableText: (log) => [log.tool_name, log.input, log.output, log.error_message],
    });

    const loadLogs = async () => {
        try {
            loading.value = true;
            logs.value = await findMcpToolLogsByServerId(props.server.id, { limit: PAGE_SIZE });
            hasMore.value = logs.value.length === PAGE_SIZE;
        } catch (error) {
            console.error('Failed to load logs:', error);
        } finally {
            loading.value = false;
        }
    };

    const loadMore = async () => {
        try {
            loadingMore.value = true;
            const moreLogs = await findMcpToolLogsByServerId(props.server.id, {
                limit: PAGE_SIZE,
                offset: logs.value.length,
            });
            logs.value.push(...moreLogs);
            hasMore.value = moreLogs.length === PAGE_SIZE;
        } catch (error) {
            console.error('Failed to load more logs:', error);
        } finally {
            loadingMore.value = false;
        }
    };

    const toggleExpand = (logId: number) => {
        if (expandedLogs.value.has(logId)) {
            expandedLogs.value.delete(logId);
        } else {
            expandedLogs.value.add(logId);
        }
    };

    const formatDate = (dateStr: string) => {
        return new Date(dateStr).toLocaleString('zh-CN');
    };

    const statusColor = (status: string) => {
        switch (status) {
            case 'success':
                return 'bg-green-100 text-green-700';
            case 'error':
                return 'bg-red-100 text-red-700';
            case 'timeout':
                return 'bg-orange-100 text-orange-700';
            case 'pending':
                return 'bg-gray-100 text-gray-700';
            default:
                return 'bg-gray-100 text-gray-700';
        }
    };

    const statusText = (status: string) => {
        switch (status) {
            case 'success':
                return '成功';
            case 'error':
                return '错误';
            case 'timeout':
                return '超时';
            case 'pending':
                return '进行中';
            default:
                return status;
        }
    };

    onMounted(() => {
        loadLogs();
    });
</script>

<template>
    <div class="p-6">
        <div class="mx-auto max-w-6xl">
            <!-- 筛选和搜索栏 -->
            <div class="mb-4 flex items-center justify-between gap-4">
                <!-- 筛选标签 -->
                <div class="flex gap-2">
                    <button
                        v-for="status in ['all', 'success', 'error', 'timeout', 'pending']"
                        :key="status"
                        :class="[
                            'rounded-lg px-3 py-1.5 font-serif text-sm transition-colors',
                            filterStatus === status
                                ? 'bg-primary-600 text-white'
                                : 'bg-gray-100 text-gray-600 hover:bg-gray-200',
                        ]"
                        @click="filterStatus = status"
                    >
                        {{ status === 'all' ? '全部' : statusText(status) }}
                    </button>
                </div>

                <!-- 搜索框 -->
                <div class="relative w-64">
                    <input
                        v-model="searchQuery"
                        type="text"
                        placeholder="搜索日志..."
                        class="focus:border-primary-400 w-full rounded-lg border border-gray-200 py-1.5 pr-3 pl-9 font-serif text-sm text-gray-900 transition-colors focus:outline-none"
                    />
                    <SvgIcon
                        name="search"
                        class="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-gray-400"
                    />
                </div>
            </div>

            <div v-if="loading" class="space-y-2">
                <div v-for="i in 5" :key="i" class="h-16 animate-pulse rounded-lg bg-gray-100" />
            </div>

            <div v-else-if="filteredLogs.length === 0" class="py-12 text-center">
                <SvgIcon name="document-text" class="mx-auto h-16 w-16 text-gray-300" />
                <p class="mt-4 font-serif text-sm text-gray-500">
                    {{ searchQuery ? '未找到匹配的日志' : '暂无日志' }}
                </p>
                <p v-if="searchQuery" class="mt-1 font-serif text-xs text-gray-400">
                    尝试其他搜索关键词
                </p>
            </div>

            <div v-else class="space-y-2">
                <div
                    v-for="log in filteredLogs"
                    :key="log.id"
                    class="rounded-lg border border-gray-200 bg-white"
                >
                    <button
                        class="w-full p-4 text-left transition-colors hover:bg-gray-50"
                        @click="toggleExpand(log.id)"
                    >
                        <div class="flex items-start justify-between">
                            <div class="min-w-0 flex-1">
                                <div class="flex items-center gap-2">
                                    <span class="font-serif text-base font-medium text-gray-900">
                                        {{ log.tool_name }}
                                    </span>
                                    <span
                                        :class="[
                                            'rounded px-2 py-0.5 font-serif text-xs',
                                            statusColor(log.status),
                                        ]"
                                    >
                                        {{ statusText(log.status) }}
                                    </span>
                                    <span class="font-serif text-xs text-gray-500">
                                        迭代 {{ log.iteration }}
                                    </span>
                                </div>
                                <div
                                    class="mt-1 flex items-center gap-4 font-serif text-xs text-gray-500"
                                >
                                    <span>{{ formatDate(log.created_at) }}</span>
                                    <span v-if="log.duration_ms">{{ log.duration_ms }}ms</span>
                                </div>
                            </div>

                            <SvgIcon
                                name="chevron-right"
                                :class="
                                    expandedLogs.has(log.id)
                                        ? 'ml-4 h-5 w-5 flex-shrink-0 rotate-90 text-gray-400 transition-transform'
                                        : 'ml-4 h-5 w-5 flex-shrink-0 text-gray-400 transition-transform'
                                "
                            />
                        </div>
                    </button>

                    <div
                        v-if="expandedLogs.has(log.id)"
                        class="border-t border-gray-200 bg-gray-50 p-4"
                    >
                        <ToolLogContent
                            :input="log.input"
                            :output="log.output"
                            :error="log.error_message"
                            :is-error="log.status === 'error' && !!log.output"
                        />

                        <div
                            class="mt-3 flex items-center gap-4 border-t border-gray-200 pt-3 font-mono text-xs text-gray-500"
                        >
                            <span>Call ID: {{ log.tool_call_id }}</span>
                            <span v-if="log.session_id">Session: {{ log.session_id }}</span>
                            <span v-if="log.message_id">Message: {{ log.message_id }}</span>
                        </div>
                    </div>
                </div>

                <!-- 加载更多 -->
                <div v-if="hasMore" class="pt-2 text-center">
                    <button
                        :disabled="loadingMore"
                        class="rounded-lg bg-gray-100 px-4 py-2 font-serif text-sm text-gray-600 transition-colors hover:bg-gray-200 disabled:cursor-not-allowed disabled:opacity-50"
                        @click="loadMore"
                    >
                        {{ loadingMore ? '加载中...' : '加载更多' }}
                    </button>
                </div>
            </div>
        </div>
    </div>
</template>
