<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import ToolLogContent from '@components/ToolLogContent.vue';
    import { useListFilter } from '@composables/useListFilter';
    import { findMcpToolLogsByServerId } from '@database/queries';
    import type { McpServerEntity, McpToolLogEntity } from '@database/types';
    import { onMounted, ref } from 'vue';

    import { getToolLogStatusText } from '../../common/toolLogStatus';
    import ToolLogStatusBadge from '../../common/ToolLogStatusBadge.vue';


    import { t } from '@/i18n';
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

    onMounted(() => {
        loadLogs();
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
                        v-for="status in ['all', 'success', 'error', 'timeout', 'pending']"
                        :key="status"
                        :class="[
                            'rounded-[10px] px-3 py-1.5 text-sm transition-colors',
                            filterStatus === status
                                ? 'bg-[#e9e9e7] text-neutral-950'
                                : 'bg-transparent text-neutral-600 hover:bg-[#f1f1ef]',
                        ]"
                        @click="filterStatus = status"
                    >
                        {{ status === 'all' ? t('common.all') : getToolLogStatusText(status) }}
                    </button>
                </div>

                <!-- 搜索框 -->
                <div class="relative w-64">
                    <input
                        v-model="searchQuery"
                        type="text"
                        :placeholder="t('toolLog.searchPlaceholder')"
                        class="settings-input w-full py-1.5 pr-3 pl-9"
                    />
                    <AppIcon
                        name="search"
                        class="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-neutral-400"
                    />
                </div>
            </div>

            <div v-if="loading" class="space-y-2">
                <div v-for="i in 5" :key="i" class="h-16 animate-pulse rounded-lg bg-neutral-100" />
            </div>

            <div v-else-if="filteredLogs.length === 0" class="py-12 text-center">
                <AppIcon name="document-text" class="mx-auto h-16 w-16 text-neutral-300" />
                <p class="mt-4 text-sm text-neutral-500">
                    {{ searchQuery ? t('toolLog.noMatches') : t('toolLog.empty') }}
                </p>
                <p v-if="searchQuery" class="mt-1 text-xs text-neutral-400">{{ t('toolLog.tryAnotherKeyword') }}</p>
            </div>

            <div v-else class="space-y-2">
                <div
                    v-for="log in filteredLogs"
                    :key="log.id"
                    class="overflow-hidden rounded-[13px] border border-neutral-200/70 bg-white"
                >
                    <button
                        class="w-full p-4 text-left transition-colors hover:bg-neutral-50/70"
                        @click="toggleExpand(log.id)"
                    >
                        <div class="flex items-start justify-between">
                            <div class="min-w-0 flex-1">
                                <div class="flex items-center gap-2">
                                    <span class="text-[15px] font-normal text-neutral-950">
                                        {{ log.tool_name }}
                                    </span>
                                    <ToolLogStatusBadge :status="log.status" />
                                    <span class="text-xs text-neutral-500">
                                        迭代 {{ log.iteration }}
                                    </span>
                                </div>
                                <div class="mt-1 flex items-center gap-4 text-xs text-neutral-500">
                                    <span>{{ formatDate(log.created_at) }}</span>
                                    <span v-if="log.duration_ms">{{ log.duration_ms }}ms</span>
                                </div>
                            </div>

                            <AppIcon
                                name="chevron-right"
                                :class="
                                    expandedLogs.has(log.id)
                                        ? 'ml-4 h-5 w-5 flex-shrink-0 rotate-90 text-neutral-400 transition-transform'
                                        : 'ml-4 h-5 w-5 flex-shrink-0 text-neutral-400 transition-transform'
                                "
                            />
                        </div>
                    </button>

                    <div
                        v-if="expandedLogs.has(log.id)"
                        class="border-t border-neutral-200/70 bg-neutral-50/70 p-4"
                    >
                        <ToolLogContent
                            :input="log.input"
                            :output="log.output"
                            :error="log.error_message"
                            :is-error="log.status === 'error' && !!log.output"
                        />

                        <div
                            class="mt-3 flex items-center gap-4 border-t border-neutral-200 pt-3 font-mono text-xs text-neutral-500"
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
                        class="settings-button-secondary"
                        @click="loadMore"
                    >
                        {{ loadingMore ? t('common.loading') : t('common.loadMore') }}
                    </button>
                </div>
            </div>
        </div>
    </div>
</template>
