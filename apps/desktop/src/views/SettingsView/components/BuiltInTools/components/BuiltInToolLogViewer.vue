<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import ToolLogContent from '@components/ToolLogContent.vue';
    import { useListFilter } from '@composables/useListFilter';
    import { onMounted, ref, watch } from 'vue';

    import {
        getBuiltInToolApprovalStateText,
        getToolLogStatusText,
    } from '../../common/toolLogStatus';
    import ToolLogStatusBadge from '../../common/ToolLogStatusBadge.vue';
    import {
        type BuiltInToolEntity,
        type BuiltInToolLogEntity,
        loadBuiltInToolQueries,
    } from '../types';


    import { t } from '@/i18n';
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
        filteredItems: filteredLogs,
    } = useListFilter({
        items: logs,
        getStatus: (log) => log.status,
        getSearchableText: (log) => [log.tool_id, log.input, log.output, log.error_message],
    });

    function formatDate(value: string) {
        return new Date(value).toLocaleString('zh-CN');
    }

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

                <div class="relative w-full max-w-xs md:w-64">
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
                        type="button"
                        class="w-full p-4 text-left transition-colors hover:bg-neutral-50/70"
                        @click="toggleExpand(log.id)"
                    >
                        <div class="flex items-start justify-between">
                            <div class="min-w-0 flex-1">
                                <div class="flex flex-wrap items-center gap-2">
                                    <span class="text-[15px] font-normal text-neutral-950">
                                        {{ props.tool.display_name }}
                                    </span>
                                    <ToolLogStatusBadge :status="log.status" />
                                    <span class="text-xs text-neutral-500">
                                        {{ t('toolLog.iteration') }} {{ log.iteration }}
                                    </span>
                                </div>
                                <div
                                    class="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-neutral-500"
                                >
                                    <span data-no-i18n="true" translate="no">
                                        {{ formatDate(log.created_at) }}
                                    </span>
                                    <span v-if="log.duration_ms" data-no-i18n="true" translate="no">
                                        {{ log.duration_ms }}ms
                                    </span>
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
                            class="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-neutral-200 pt-3 font-mono text-xs text-neutral-500"
                        >
                            <span data-no-i18n="true" translate="no">
                                {{ t('toolLog.callIdLabel') }} {{ log.tool_call_id }}
                            </span>
                            <span v-if="log.session_id" data-no-i18n="true" translate="no">
                                {{ t('toolLog.sessionLabel') }} {{ log.session_id }}
                            </span>
                            <span v-if="log.message_id" data-no-i18n="true" translate="no">
                                {{ t('toolLog.messageLabel') }} {{ log.message_id }}
                            </span>
                            <span v-if="log.approval_state">
                                {{ t('toolLog.approvalLabel') }}
                                {{ getBuiltInToolApprovalStateText(log.approval_state) }}
                            </span>
                        </div>
                    </div>
                </div>

                <div v-if="hasMore" class="pt-2 text-center">
                    <button
                        type="button"
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
