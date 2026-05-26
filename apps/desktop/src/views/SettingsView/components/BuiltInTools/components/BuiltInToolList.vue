<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import { computed } from 'vue';

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
        <div v-if="sortedTools.length === 0" class="px-4 py-10 text-center">
            <p class="mt-3 text-sm text-neutral-500">暂无可配置的内置工具</p>
            <p class="mt-1 text-xs text-neutral-400">网关注册完成后会自动展示在这里</p>
        </div>

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
                    <h3 class="truncate text-[13px] font-normal text-neutral-950">
                        {{ tool.display_name }}
                    </h3>
                    <p class="mt-1 text-xs leading-5 text-neutral-500">
                        {{ getBuiltInToolSummary(tool.tool_id, tool.description) }}
                    </p>
                </div>
                <button
                    :disabled="togglingToolIds?.has(tool.id)"
                    :class="[
                        'relative mt-0.5 inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors',
                        tool.enabled ? 'bg-primary-700' : 'bg-neutral-200',
                        togglingToolIds?.has(tool.id) ? 'cursor-not-allowed opacity-50' : '',
                    ]"
                    title="启用/禁用"
                    @click.stop="emit('toggle-enabled', tool.id, !tool.enabled)"
                >
                    <span
                        :class="[
                            'inline-block h-3 w-3 transform rounded-full bg-white transition-transform',
                            tool.enabled ? 'translate-x-5' : 'translate-x-1',
                        ]"
                    />
                </button>
            </div>
        </div>
    </div>
</template>
