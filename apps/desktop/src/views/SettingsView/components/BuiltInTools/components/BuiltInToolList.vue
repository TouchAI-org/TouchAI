<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import EmptyState from '@components/EmptyState.vue';
    import { Switch } from '@components/ui/switch';
    import { computed } from 'vue';

    import { t } from '@/i18n';

    import { type BuiltInToolEntity, getBuiltInToolSummary } from '../types';
    interface Props {
        tools: BuiltInToolEntity[];
        selectedToolId: string | null;
        togglingToolIds?: Set<number>;
    }

    interface Emits {
        (e: 'select', tool: BuiltInToolEntity): void;
        (e: 'toggle-enabled', toolId: number, enabled: boolean): void;
    }

    const props = defineProps<Props>();
    const emit = defineEmits<Emits>();

    const sortedTools = computed(() =>
        [...props.tools].sort((left, right) => Number(right.enabled) - Number(left.enabled))
    );
</script>

<template>
    <div class="settings-scrollbar flex-1 space-y-1 overflow-y-auto p-4 pt-5">
        <EmptyState
            v-if="sortedTools.length === 0"
            :title="t('settings.builtInTools.list.empty')"
            :description="t('settings.builtInTools.list.emptyDescription')"
            icon="tool"
        />

        <div
            v-for="tool in sortedTools"
            :key="tool.tool_id"
            :class="[
                'w-full cursor-pointer rounded-[11px] border px-3 py-2.5 text-left transition-colors',
                selectedToolId === tool.tool_id
                    ? 'settings-item-selected'
                    : 'settings-item-unselected',
            ]"
            @click="emit('select', tool)"
        >
            <div class="flex items-start justify-between gap-2">
                <div class="min-w-0 flex-1">
                    <h3
                        class="truncate text-[13px] font-normal text-neutral-950"
                        data-no-i18n="true"
                        translate="no"
                    >
                        {{ tool.display_name }}
                    </h3>
                    <p class="mt-1 text-xs leading-5 break-words text-neutral-500">
                        {{ getBuiltInToolSummary(tool.tool_id, tool.description) }}
                    </p>
                </div>
                <Switch
                    size="sm"
                    class="mt-0.5"
                    :model-value="tool.enabled === 1"
                    :disabled="togglingToolIds?.has(tool.id)"
                    :title="t('settings.builtInTools.toggleEnabled')"
                    @update:model-value="emit('toggle-enabled', tool.id, !tool.enabled)"
                />
            </div>
        </div>
    </div>
</template>
