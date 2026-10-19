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
</script>

<template>
    <section class="space-y-4" data-testid="settings-usage-context">
        <div>
            <h2 class="settings-section-title">{{ t('settings.usage.context.title') }}</h2>
            <p class="settings-section-description">
                {{ t('settings.usage.context.description') }}
            </p>
        </div>

        <div v-if="!overall" class="settings-row-group px-5 py-10 text-center">
            <span class="text-xs text-neutral-400">{{ t('settings.usage.context.empty') }}</span>
        </div>

        <!-- 只留评分、构成与标签；分项与逐模型明细收进 tooltip，避免一屏表格 -->
        <div v-else class="settings-row-group p-5">
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

                <div class="min-w-52 flex-1">
                    <span class="text-xs text-neutral-500">
                        {{ t('settings.usage.context.composition') }}
                    </span>
                    <div class="mt-1.5 flex h-3 w-full overflow-hidden rounded-full bg-neutral-100">
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
                                    formatTokensCompact(shareOf(overall, segment.key)?.tokens ?? 0)
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
    </section>
</template>
