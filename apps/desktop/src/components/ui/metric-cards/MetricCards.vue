<script setup lang="ts">
    import AnimatedCounter from '@components/ui/animated-counter/AnimatedCounter.vue';

    import { getLocale } from '@/i18n';

    export interface MetricCard {
        key: string;
        label: string;
        value: string;
        prefix?: string;
        note?: string;
        warn?: boolean;
        description?: string;
        valueParts?: Array<{ value: string; unit: string }>;
        counter?: { value: number; prefix?: string; suffix?: string; decimals?: number };
    }

    defineProps<{ cards: MetricCard[]; testIdPrefix?: string }>();
</script>

<template>
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div
            v-for="card in cards"
            :key="card.key"
            :data-testid="testIdPrefix && `${testIdPrefix}${card.key}`"
            :data-value="card.counter?.value"
            :title="card.description"
            class="flex min-w-0 flex-col gap-1 rounded-control bg-metric-surface/80 px-4 py-3"
        >
            <span class="truncate text-xs text-muted-foreground">{{ card.label }}</span>
            <span
                class="truncate font-serif text-title leading-tight font-semibold text-settings-text tabular-nums"
                :title="`${card.prefix ?? ''}${card.value}`"
            >
                <template v-if="card.counter">
                    <span v-if="card.prefix" class="mr-0.5">{{ card.prefix }}</span>
                    <AnimatedCounter
                        v-bind="card.counter"
                        :animate-on-view="true"
                        :locale="getLocale()"
                    />
                </template>
                <template v-else-if="card.valueParts">
                    <span
                        v-for="part in card.valueParts"
                        :key="part.unit"
                        class="mr-1.5 inline-flex items-baseline gap-0.5 last:mr-0"
                    >
                        {{ part.value }}
                        <span class="text-reading font-normal text-metric-detail">
                            {{ part.unit }}
                        </span>
                    </span>
                </template>
                <template v-else>{{ card.prefix }}{{ card.value }}</template>
            </span>
            <span
                v-if="card.note"
                class="truncate text-caption"
                :class="card.warn ? 'text-metric-warning' : 'text-metric-detail'"
            >
                {{ card.note }}
            </span>
        </div>
    </div>
</template>
