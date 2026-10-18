<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import type { ContextProfile, ContextShare } from '@database/queries/usageContext';

    import { type MessageKey, t } from '@/i18n';

    import { formatPercent, formatTokensCompact } from '../utils/format';

    interface Props {
        /** 总体画像；没有采样时为 null */
        overall: ContextProfile | null;
        models: ContextProfile[];
    }

    defineProps<Props>();

    defineOptions({ name: 'UsageContext' });

    /** 分段展示顺序与配色：同一分段在所有条形图里颜色一致 */
    const SEGMENTS: Array<{ key: string; className: string }> = [
        { key: 'systemPrompt', className: 'bg-neutral-800' },
        { key: 'builtinToolDefinitions', className: 'bg-neutral-500' },
        { key: 'mcpToolDefinitions', className: 'bg-sky-500' },
        { key: 'conversation', className: 'bg-neutral-300' },
        { key: 'userPrompt', className: 'bg-emerald-500' },
        { key: 'attachments', className: 'bg-amber-500' },
    ];

    const SCORE_LABELS: Record<string, MessageKey> = {
        cache: 'settings.usage.context.score.cache',
        lean: 'settings.usage.context.score.lean',
        pace: 'settings.usage.context.score.pace',
        reliable: 'settings.usage.context.score.reliable',
    };

    const TAG_LABELS: Record<string, MessageKey> = {
        cacheFriendly: 'settings.usage.context.tag.cacheFriendly',
        cacheMisses: 'settings.usage.context.tag.cacheMisses',
        lean: 'settings.usage.context.tag.lean',
        heavyStart: 'settings.usage.context.tag.heavyStart',
        mcpHeavy: 'settings.usage.context.tag.mcpHeavy',
        fillsFast: 'settings.usage.context.tag.fillsFast',
        nearFull: 'settings.usage.context.tag.nearFull',
        compacts: 'settings.usage.context.tag.compacts',
        attachmentHeavy: 'settings.usage.context.tag.attachmentHeavy',
        promptBloat: 'settings.usage.context.tag.promptBloat',
        steady: 'settings.usage.context.tag.steady',
        flaky: 'settings.usage.context.tag.flaky',
    };

    const TONE_CLASS: Record<string, string> = {
        good: 'bg-green-100 text-green-700',
        warn: 'bg-amber-100 text-amber-700',
        info: 'bg-neutral-100 text-neutral-600',
    };

    function segmentLabel(key: string): string {
        return t(`settings.usage.context.segment.${key}` as MessageKey);
    }

    function shareOf(profile: ContextProfile, key: string): ContextShare | undefined {
        return profile.shares.find((share) => share.key === key);
    }

    /** 评分色阶：≥80 好，≥60 中，其余偏弱 */
    function scoreClass(score: number): string {
        if (score >= 80) return 'text-green-600';
        if (score >= 60) return 'text-amber-600';
        return 'text-red-600';
    }

    function fillClass(rate: number): string {
        if (rate >= 0.85) return 'text-red-600';
        if (rate >= 0.6) return 'text-amber-600';
        return 'text-neutral-700';
    }

    function baselineRatio(profile: ContextProfile): number {
        return profile.window > 0 ? profile.baselineMedian / profile.window : 0;
    }

    /** 表头列只声明一次，表头与数据行共用，避免两边列宽漂移 */
    const COLUMNS = [
        {
            key: 'turns',
            labelKey: 'settings.usage.context.column.turns' as MessageKey,
            width: 'w-14',
        },
        {
            key: 'median',
            labelKey: 'settings.usage.context.column.median' as MessageKey,
            width: 'w-16',
        },
        { key: 'p90', labelKey: 'settings.usage.context.column.p90' as MessageKey, width: 'w-16' },
        {
            key: 'baseline',
            labelKey: 'settings.usage.context.column.baseline' as MessageKey,
            width: 'w-16',
        },
        {
            key: 'window',
            labelKey: 'settings.usage.context.column.window' as MessageKey,
            width: 'w-16',
        },
        {
            key: 'peak',
            labelKey: 'settings.usage.context.column.peak' as MessageKey,
            width: 'w-16',
        },
        {
            key: 'cache',
            labelKey: 'settings.usage.context.column.cache' as MessageKey,
            width: 'w-16',
        },
        {
            key: 'compacts',
            labelKey: 'settings.usage.context.column.compacts' as MessageKey,
            width: 'w-14',
        },
        {
            key: 'score',
            labelKey: 'settings.usage.context.column.score' as MessageKey,
            width: 'w-16',
        },
    ];
</script>

<template>
    <section class="space-y-4">
        <div>
            <h2 class="settings-section-title">{{ t('settings.usage.context.title') }}</h2>
            <p class="settings-section-description">
                {{ t('settings.usage.context.description') }}
            </p>
        </div>

        <div v-if="!overall" class="settings-row-group px-5 py-10 text-center">
            <span class="text-xs text-neutral-400">
                {{ t('settings.usage.context.empty') }}
            </span>
        </div>

        <template v-else>
            <!-- 总体：评分 + 分段构成 -->
            <div class="settings-row-group p-5">
                <div class="flex flex-wrap items-start gap-8">
                    <div class="flex flex-col gap-1">
                        <span class="text-xs text-neutral-500">
                            {{ t('settings.usage.context.overallScore') }}
                        </span>
                        <span
                            :class="[
                                'font-serif text-[32px] leading-none font-semibold tabular-nums',
                                scoreClass(overall.score),
                            ]"
                        >
                            {{ overall.score }}
                        </span>
                        <span class="text-[11px] text-neutral-400">
                            {{ t('settings.usage.context.turns', { count: overall.turnCount }) }}
                        </span>
                    </div>

                    <div class="flex flex-col gap-1.5">
                        <span class="text-xs text-neutral-500">
                            {{ t('settings.usage.context.breakdown') }}
                        </span>
                        <div class="flex flex-col gap-1">
                            <div
                                v-for="part in overall.scores"
                                :key="part.key"
                                class="flex items-center gap-2 text-[11px]"
                            >
                                <span class="w-16 shrink-0 text-neutral-500">
                                    {{
                                        t(SCORE_LABELS[part.key] ?? 'settings.usage.context.title')
                                    }}
                                </span>
                                <div
                                    class="h-[3px] w-24 overflow-hidden rounded-full bg-neutral-100"
                                >
                                    <div
                                        class="h-full rounded-full bg-neutral-800/70"
                                        :style="{ width: `${(part.points / part.most) * 100}%` }"
                                    />
                                </div>
                                <span class="text-neutral-600 tabular-nums">
                                    {{ part.points }}/{{ part.most }}
                                </span>
                            </div>
                        </div>
                    </div>

                    <div class="min-w-48 flex-1">
                        <span class="text-xs text-neutral-500">
                            {{ t('settings.usage.context.composition') }}
                        </span>
                        <div
                            class="mt-1.5 flex h-3 w-full overflow-hidden rounded-full bg-neutral-100"
                        >
                            <div
                                v-for="segment in SEGMENTS"
                                :key="segment.key"
                                :class="[segment.className, 'h-full']"
                                :style="{
                                    width: `${(shareOf(overall, segment.key)?.share ?? 0) * 100}%`,
                                }"
                                :title="`${segmentLabel(segment.key)} ${formatPercent(
                                    shareOf(overall, segment.key)?.share ?? 0
                                )}`"
                            />
                        </div>
                        <div class="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                            <span
                                v-for="segment in SEGMENTS"
                                :key="`legend-${segment.key}`"
                                class="flex items-center gap-1.5 text-[11px] text-neutral-500"
                            >
                                <span
                                    :class="[segment.className, 'h-2 w-2 rounded-full']"
                                    aria-hidden="true"
                                />
                                {{ segmentLabel(segment.key) }}
                                <span class="text-neutral-400 tabular-nums">
                                    ≈
                                    {{
                                        formatTokensCompact(
                                            shareOf(overall, segment.key)?.tokens ?? 0
                                        )
                                    }}
                                </span>
                            </span>
                        </div>
                        <p class="mt-2 text-[11px] text-neutral-400">
                            {{ t('settings.usage.context.estimateNote') }}
                        </p>
                    </div>
                </div>

                <div v-if="overall.tags.length > 0" class="mt-4 flex flex-wrap gap-1.5">
                    <span
                        v-for="tag in overall.tags"
                        :key="tag.key"
                        :class="[
                            'rounded px-2 py-0.5 text-[11px] whitespace-nowrap',
                            TONE_CLASS[tag.tone] ?? TONE_CLASS.info,
                        ]"
                    >
                        {{ t(TAG_LABELS[tag.key] ?? 'settings.usage.context.title') }}
                    </span>
                </div>
            </div>

            <!-- 模型维度对比 -->
            <div class="settings-row-group divide-y divide-neutral-200/70">
                <div
                    class="flex items-center gap-3 px-5 py-2 text-[11px] text-neutral-400"
                    aria-hidden="true"
                >
                    <span class="min-w-0 flex-1">
                        {{ t('settings.usage.context.column.model') }}
                    </span>
                    <span
                        v-for="column in COLUMNS"
                        :key="column.key"
                        :class="[column.width, 'shrink-0 text-right']"
                    >
                        {{ t(column.labelKey) }}
                    </span>
                </div>

                <div
                    v-for="profile in models"
                    :key="profile.modelId ?? 'overall'"
                    data-testid="settings-usage-context-row"
                    class="flex items-center gap-3 bg-transparent px-5 py-3 transition-colors hover:bg-[#f1f1ef]"
                >
                    <div class="min-w-0 flex-1">
                        <div
                            class="truncate text-[13px] text-neutral-950"
                            :title="profile.modelName"
                            translate="no"
                        >
                            {{ profile.modelName || t('settings.usage.context.all') }}
                        </div>
                        <div class="mt-1 flex flex-wrap gap-1">
                            <span
                                v-for="tag in profile.tags"
                                :key="`${profile.modelId}-${tag.key}`"
                                :class="[
                                    'rounded px-1.5 py-0.5 text-[10px] whitespace-nowrap',
                                    TONE_CLASS[tag.tone] ?? TONE_CLASS.info,
                                ]"
                            >
                                {{ t(TAG_LABELS[tag.key] ?? 'settings.usage.context.title') }}
                            </span>
                        </div>
                    </div>

                    <span
                        class="w-14 shrink-0 text-right text-[13px] text-neutral-600 tabular-nums"
                    >
                        {{ profile.turnCount }}
                    </span>
                    <span
                        class="w-16 shrink-0 text-right text-[13px] text-neutral-600 tabular-nums"
                    >
                        {{ formatTokensCompact(profile.promptMedian) }}
                    </span>
                    <span
                        class="w-16 shrink-0 text-right text-[13px] text-neutral-600 tabular-nums"
                    >
                        {{ formatTokensCompact(profile.promptP90) }}
                    </span>
                    <span
                        class="w-16 shrink-0 text-right text-[13px] text-neutral-600 tabular-nums"
                        :title="formatPercent(baselineRatio(profile))"
                    >
                        {{ formatTokensCompact(profile.baselineMedian) }}
                    </span>
                    <span
                        class="w-16 shrink-0 text-right text-[13px] text-neutral-600 tabular-nums"
                    >
                        {{ profile.window > 0 ? formatTokensCompact(profile.window) : '—' }}
                    </span>
                    <span
                        :class="[
                            'w-16 shrink-0 text-right text-[13px] tabular-nums',
                            fillClass(profile.peakFill),
                        ]"
                    >
                        {{ formatPercent(profile.peakFill) }}
                    </span>
                    <span
                        class="w-16 shrink-0 text-right text-[13px] text-neutral-600 tabular-nums"
                    >
                        {{ formatPercent(profile.cacheReuseRate) }}
                    </span>
                    <span
                        class="w-14 shrink-0 text-right text-[13px] text-neutral-600 tabular-nums"
                    >
                        {{ profile.compactCount }}
                    </span>
                    <span
                        :class="[
                            'w-16 shrink-0 text-right text-[13px] font-medium tabular-nums',
                            scoreClass(profile.score),
                        ]"
                    >
                        {{ profile.score }}
                    </span>
                </div>
            </div>
        </template>
    </section>
</template>
