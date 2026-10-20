<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import EmptyState from '@components/EmptyState.vue';
    import { Button } from '@components/ui/button';
    import { useListFilter } from '@composables/useListFilter';
    import { onMounted, ref, watch } from 'vue';

    import { t } from '@/i18n';

    import ToolLogEntry from '../../common/ToolLogEntry.vue';
    import { getToolLogStatusText } from '../../common/toolLogStatus';
    import {
        type BuiltInToolEntity,
        type BuiltInToolLogEntity,
        loadBuiltInToolQueries,
    } from '../types';

    interface Props {
        tool: BuiltInToolEntity;
    }

    const props = defineProps<Props>();

    const logs = ref<BuiltInToolLogEntity[]>([]);
    const loading = ref(true);
    const loadingMore = ref(false);
    const hasMore = ref(false);
    const expandedLogs = ref<Set<number>>(new Set());
    const PAGE_SIZE = 50;

    const {
        filterStatus,
        searchQuery,
        hasActiveFilters,
        resetFilters,
        filteredItems: filteredLogs,
    } = useListFilter({
        items: logs,
        getStatus: (log) => log.status,
        getSearchableText: (log) => [log.tool_id, log.input, log.output, log.error_message],
    });

    async function loadLogs() {
        loading.value = true;
        try {
            const queries = await loadBuiltInToolQueries();
            logs.value = await queries.findBuiltInToolLogsByToolId(props.tool.tool_id, {
                limit: PAGE_SIZE,
            });
            hasMore.value = logs.value.length === PAGE_SIZE;
        } catch (error) {
            console.error('[BuiltInToolLogViewer] Failed to load logs:', error);
            logs.value = [];
            hasMore.value = false;
        } finally {
            loading.value = false;
        }
    }

    async function loadMore() {
        loadingMore.value = true;
        try {
            const queries = await loadBuiltInToolQueries();
            const moreLogs = await queries.findBuiltInToolLogsByToolId(props.tool.tool_id, {
                limit: PAGE_SIZE,
                offset: logs.value.length,
            });
            logs.value.push(...moreLogs);
            hasMore.value = moreLogs.length === PAGE_SIZE;
        } catch (error) {
            console.error('[BuiltInToolLogViewer] Failed to load more logs:', error);
        } finally {
            loadingMore.value = false;
        }
    }

    function toggleExpand(logId: number) {
        if (expandedLogs.value.has(logId)) {
            expandedLogs.value.delete(logId);
            return;
        }

        expandedLogs.value.add(logId);
    }

    onMounted(() => {
        void loadLogs();
    });

    watch(
        () => props.tool.tool_id,
        () => {
            filterStatus.value = 'all';
            searchQuery.value = '';
            expandedLogs.value = new Set();
            void loadLogs();
        }
    );
</script>

<template>
    <div class="settings-page-wide">
        <div>
            <div class="mb-4 flex flex-wrap items-center justify-between gap-4">
                <div class="flex flex-wrap gap-2">
                    <button
                        v-for="status in [
                            'all',
                            'success',
                            'error',
                            'timeout',
                            'awaiting_approval',
                            'rejected',
                            'pending',
                        ]"
                        :key="status"
                        type="button"
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

                <div class="relative min-w-[16rem] flex-1">
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
                    :name="props.tool.display_name"
                    :status="log.status"
                    :created-at="log.created_at"
                    :duration-ms="log.duration_ms"
                    :input="log.input"
                    :output="log.output"
                    :error="log.error_message"
                    :is-bash="props.tool.tool_id === 'bash'"
                    :expanded="expandedLogs.has(log.id)"
                    @toggle="toggleExpand(log.id)"
                />

                <div v-if="hasMore" class="pt-2 text-center">
                    <Button variant="outline-neutral" :disabled="loadingMore" @click="loadMore">
                        {{ loadingMore ? t('common.loading') : t('common.loadMore') }}
                    </Button>
                </div>
            </div>
        </div>
    </div>
</template>
