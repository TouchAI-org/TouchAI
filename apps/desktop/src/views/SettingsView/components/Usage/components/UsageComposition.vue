<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import DonutChart from '@components/ui/donut-chart/DonutChart.vue';
    import type { UsageComposition } from '@database/queries/usageStats';
    import { computed } from 'vue';

    import { t } from '@/i18n';

    import { formatLongDuration, formatPercent, formatTokensCompact } from '../utils/format';

    const props = defineProps<{ composition: UsageComposition | null }>();
    defineOptions({ name: 'UsageComposition' });

    /**
     * DonutChart takes `{ key, label, value }` directly: grouping, palette,
     * gaps, hover linking, and the centre readout are its job. This component
     * only maps keys to copy.
     */
    const LABEL: Record<string, Parameters<typeof t>[0]> = {
        systemPrompt: 'settings.usage.composition.systemPrompt',
        toolDefinitions: 'settings.usage.composition.toolDefinitions',
        conversation: 'settings.usage.composition.conversation',
        toolResults: 'settings.usage.composition.toolResults',
        userPrompt: 'settings.usage.composition.userPrompt',
        injections: 'settings.usage.composition.injections',
        output: 'settings.usage.composition.output',
        wait: 'settings.usage.composition.wait',
        think: 'settings.usage.composition.think',
        reply: 'settings.usage.composition.reply',
        tool: 'settings.usage.composition.tool',
        other: 'settings.usage.composition.other',
    };

    function labelOf(key: string): string {
        return t(LABEL[key] ?? 'settings.usage.composition.other');
    }

    const tokenData = computed(() =>
        (props.composition?.tokens.segments ?? []).map((segment) => ({
            key: segment.key,
            label: labelOf(segment.key),
            value: segment.value,
        }))
    );

    const timingData = computed(() =>
        (props.composition?.timing.segments ?? []).map((segment) => ({
            key: segment.key,
            label: labelOf(segment.key),
            value: segment.value,
        }))
    );

    /** Keys of estimated segments, marked with a leading ≈ in the legend. */
    const estimatedTokenKeys = computed(() =>
        (props.composition?.tokens.segments ?? [])
            .filter((segment) => segment.estimated)
            .map((segment) => segment.key)
    );
</script>

<template>
    <!-- 两张卡内部已铺满内容，间距要比普通栅格大一些才不会读成一块 -->
    <div class="grid grid-cols-1 gap-6 xl:grid-cols-2" data-testid="settings-usage-composition">
        <!-- Token 构成 -->
        <section class="space-y-3">
            <div class="flex items-baseline justify-between gap-2">
                <h2 class="settings-section-title">
                    {{ t('settings.usage.composition.tokenTitle') }}
                </h2>
                <span class="text-[11px] text-neutral-400">
                    {{
                        t('settings.usage.composition.cacheNote', {
                            rate: formatPercent(composition?.cacheReadShare ?? 0),
                        })
                    }}
                </span>
            </div>

            <div class="rounded-[11px] bg-neutral-50/80 p-4">
                <div v-if="!composition" class="flex items-center gap-6 py-2">
                    <div class="h-40 w-40 shrink-0 animate-pulse rounded-full bg-neutral-200/60" />
                    <div class="flex-1 space-y-2">
                        <div
                            v-for="i in 4"
                            :key="i"
                            class="h-3 animate-pulse rounded bg-neutral-200/60"
                        />
                    </div>
                </div>
                <div v-else-if="tokenData.length === 0" class="py-10 text-center">
                    <span class="text-xs text-neutral-400">
                        {{ t('settings.usage.composition.empty') }}
                    </span>
                </div>

                <DonutChart
                    v-else
                    :data="tokenData"
                    :total-label="t('settings.usage.composition.totalTokens')"
                    :size="176"
                    :thickness="22"
                    :estimated-keys="estimatedTokenKeys"
                    :format-value="formatTokensCompact"
                />
            </div>
        </section>

        <!-- 耗时构成 -->
        <section class="space-y-3">
            <div class="flex items-baseline justify-between gap-2">
                <h2 class="settings-section-title">
                    {{ t('settings.usage.composition.timingTitle') }}
                </h2>
                <span class="text-[11px] text-neutral-400">
                    {{ t('settings.usage.composition.timingNote') }}
                </span>
            </div>

            <div class="rounded-[11px] bg-neutral-50/80 p-4">
                <div v-if="!composition" class="flex items-center gap-6 py-2">
                    <div class="h-40 w-40 shrink-0 animate-pulse rounded-full bg-neutral-200/60" />
                    <div class="flex-1 space-y-2">
                        <div
                            v-for="i in 3"
                            :key="i"
                            class="h-3 animate-pulse rounded bg-neutral-200/60"
                        />
                    </div>
                </div>
                <div v-else-if="timingData.length === 0" class="py-10 text-center">
                    <span class="text-xs text-neutral-400">
                        {{ t('settings.usage.composition.empty') }}
                    </span>
                </div>

                <DonutChart
                    v-else
                    :data="timingData"
                    :total-label="t('settings.usage.composition.activeTime')"
                    :size="176"
                    :thickness="22"
                    :format-value="formatLongDuration"
                />
            </div>
        </section>
    </div>
</template>
