<!-- Copyright (c) 2026. Qian Cheng. Licensed under GPL v3 -->

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import MotionCollapse from '@components/MotionCollapse.vue';
    import ToolLogContent from '@components/ToolLogContent.vue';

    import { formatDateTime } from '@/i18n/format';
    import { formatCompactDuration } from '@/utils/duration';

    import ToolLogStatusBadge from './ToolLogStatusBadge.vue';

    defineProps<{
        name: string;
        status: string;
        createdAt: string;
        durationMs: number | null;
        input: string;
        output: string | null;
        error: string | null;
        expanded: boolean;
        isBash?: boolean;
    }>();

    const emit = defineEmits<{ toggle: [] }>();

    function formatLogDuration(durationMs: number): string {
        if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
        if (durationMs < 60_000) return `${Number((durationMs / 1000).toFixed(2))}s`;
        return formatCompactDuration(durationMs) ?? '';
    }
</script>

<template>
    <article class="overflow-hidden rounded-[10px] border border-neutral-200/70 bg-white">
        <button
            type="button"
            class="w-full px-5 py-4 text-left transition-colors hover:bg-neutral-50/70"
            :aria-expanded="expanded"
            @click="emit('toggle')"
        >
            <span class="flex min-w-0 flex-wrap items-center gap-2.5" data-testid="tool-log-header">
                <span
                    class="flex h-7 w-7 shrink-0 items-center justify-center rounded-[7px] bg-neutral-100 text-neutral-500"
                    aria-hidden="true"
                >
                    <AppIcon :name="isBash ? 'terminal' : 'tool'" class="h-4 w-4" />
                </span>
                <span
                    class="min-w-0 text-[14px] font-medium break-words text-neutral-950"
                    data-testid="tool-log-name"
                    data-no-i18n="true"
                    translate="no"
                >
                    {{ name }}
                </span>
                <ToolLogStatusBadge :status="status" subtle />
                <span
                    class="ml-auto flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-xs text-neutral-500"
                >
                    <time
                        :datetime="createdAt"
                        class="whitespace-nowrap"
                        data-no-i18n="true"
                        translate="no"
                    >
                        {{ formatDateTime(createdAt) }}
                    </time>
                    <span
                        v-if="durationMs !== null && durationMs >= 0"
                        class="whitespace-nowrap"
                        data-no-i18n="true"
                        translate="no"
                    >
                        {{ formatLogDuration(durationMs) }}
                    </span>
                </span>
                <AppIcon
                    name="chevron-right"
                    :class="[
                        'h-4 w-4 shrink-0 text-neutral-400 transition-transform',
                        expanded && 'rotate-90',
                    ]"
                />
            </span>
        </button>

        <MotionCollapse :open="expanded" lazy>
            <div class="border-t border-neutral-200/70">
                <ToolLogContent
                    :input="input"
                    :output="output"
                    :error="error"
                    :is-error="status === 'error' && !!output"
                    :is-bash="isBash"
                />
            </div>
        </MotionCollapse>
    </article>
</template>
