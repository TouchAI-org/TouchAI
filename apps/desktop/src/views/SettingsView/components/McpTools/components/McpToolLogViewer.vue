<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import EmptyState from '@components/EmptyState.vue';
    import { Button } from '@components/ui/button';
    import { Input } from '@components/ui/input';
    import { useListFilter } from '@composables/useListFilter';
    import { findMcpToolLogById, findMcpToolLogSummariesByServerId } from '@database/queries';
    import type { McpToolLogSummary } from '@database/queries/mcpToolLogs';
    import type { McpServerEntity, McpToolLogEntity } from '@database/types';
    import { log as appLog } from '@services/ObservabilityService';
    import { onMounted, ref } from 'vue';

    import { t } from '@/i18n';

    import ToolLogEntry from '../../common/ToolLogEntry.vue';
    import { getToolLogStatusText } from '../../common/toolLogStatus';

    interface Props {
        server: McpServerEntity;
    }

    const props = defineProps<Props>();

    // 列表只拿摘要；完整 input/output 在展开时按 id 拉取。
    const logs = ref<McpToolLogSummary[]>([]);
    const details = ref<Record<number, McpToolLogEntity>>({});
    const loading = ref(true);
    const loadingMore = ref(false);
    const expandedLogs = ref<Set<number>>(new Set());
    const PAGE_SIZE = 100;
    const hasMore = ref(false);

    const {
        filterStatus,
        searchQuery,
        hasActiveFilters,
        resetFilters,
        filteredItems: filteredLogs,
    } = useListFilter({
        items: logs,
        getStatus: (log) => log.status,
        // 搜索基于列表已有的摘要字段；完整输出需要展开后查看。
        getSearchableText: (log) => [log.tool_name, log.input_preview],
    });

    const loadLogs = async () => {
        try {
            loading.value = true;
            logs.value = await findMcpToolLogSummariesByServerId(props.server.id, {
                limit: PAGE_SIZE,
            });
            hasMore.value = logs.value.length === PAGE_SIZE;
        } catch (error) {
            appLog.error('Failed to load logs:', error);
        } finally {
            loading.value = false;
        }
    };

    const loadMore = async () => {
        try {
            loadingMore.value = true;
            const moreLogs = await findMcpToolLogSummariesByServerId(props.server.id, {
                limit: PAGE_SIZE,
                offset: logs.value.length,
            });
            logs.value.push(...moreLogs);
            hasMore.value = moreLogs.length === PAGE_SIZE;
        } catch (error) {
            appLog.error('Failed to load more logs:', error);
        } finally {
            loadingMore.value = false;
        }
    };

    const ensureDetail = async (logId: number) => {
        if (details.value[logId]) {
            return;
        }

        try {
            const detail = await findMcpToolLogById(logId);
            if (detail) {
                details.value = { ...details.value, [logId]: detail };
            }
        } catch (error) {
            appLog.error('Failed to load log detail:', error);
        }
    };

    const toggleExpand = (logId: number) => {
        if (expandedLogs.value.has(logId)) {
            expandedLogs.value.delete(logId);
        } else {
            expandedLogs.value.add(logId);
            void ensureDetail(logId);
        }
    };

    onMounted(() => {
        loadLogs();
    });
</script>

<template>
    <div class="settings-page-wide">
        <div>
            <!-- 筛选和搜索栏 -->
            <div
                class="mb-4 flex flex-wrap items-center justify-between gap-4"
                data-testid="mcp-tool-log-toolbar"
            >
                <!-- 筛选标签 -->
                <div class="flex flex-wrap gap-2" data-testid="mcp-tool-log-filters">
                    <button
                        v-for="status in ['all', 'success', 'error', 'timeout', 'pending']"
                        :key="status"
                        :class="[
                            'rounded-control px-3 py-1.5 text-sm transition-colors',
                            filterStatus === status
                                ? 'bg-surface-selected text-neutral-950'
                                : 'bg-transparent text-neutral-600 hover:bg-surface-hover',
                        ]"
                        @click="filterStatus = status"
                    >
                        {{ status === 'all' ? t('common.all') : getToolLogStatusText(status) }}
                    </button>
                </div>

                <!-- 搜索框 -->
                <div class="relative min-w-[16rem] flex-1" data-testid="mcp-tool-log-search">
                    <Input
                        v-model="searchQuery"
                        variant="filled"
                        type="text"
                        :placeholder="t('toolLog.searchPlaceholder')"
                        class="w-full py-1.5 pr-3 pl-9"
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

            <div v-else-if="filteredLogs.length === 0">
                <EmptyState
                    :title="hasActiveFilters ? t('toolLog.noMatches') : t('toolLog.empty')"
                    :description="
                        hasActiveFilters
                            ? t('common.noResultsDescription')
                            : t('toolLog.emptyDescription')
                    "
                    icon="document-text"
                >
                    <template v-if="hasActiveFilters" #actions>
                        <Button variant="outline-neutral" @click="resetFilters">
                            {{ t('common.clearFilters') }}
                        </Button>
                    </template>
                </EmptyState>
            </div>

            <div v-else class="space-y-2">
                <ToolLogEntry
                    v-for="log in filteredLogs"
                    :key="log.id"
                    :name="log.tool_name"
                    :status="log.status"
                    :created-at="log.created_at"
                    :duration-ms="log.duration_ms"
                    :input="details[log.id]?.input ?? log.input_preview ?? ''"
                    :output="details[log.id]?.output ?? null"
                    :error="details[log.id]?.error_message ?? null"
                    :expanded="expandedLogs.has(log.id)"
                    @toggle="toggleExpand(log.id)"
                />

                <!-- 加载更多 -->
                <div v-if="hasMore" class="pt-2 text-center">
                    <Button variant="outline-neutral" :disabled="loadingMore" @click="loadMore">
                        {{ loadingMore ? t('common.loading') : t('common.loadMore') }}
                    </Button>
                </div>
            </div>
        </div>
    </div>
</template>
