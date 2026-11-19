<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import type { SearchRoutingStrategy } from '@services/SettingsService/domain';
    import { RadioGroupItem, RadioGroupRoot } from 'reka-ui';
    import { nextTick, ref } from 'vue';

    import autoScene from '@/assets/search-strategy/auto.svg';
    import defaultScene from '@/assets/search-strategy/default.svg';
    import priorityScene from '@/assets/search-strategy/priority.svg';
    import { t } from '@/i18n';

    defineOptions({ name: 'SearchStrategyChoices' });

    const strategy = defineModel<SearchRoutingStrategy>({ required: true });
    const props = defineProps<{ disabled: boolean }>();
    const rootRef = ref<{ $el?: HTMLElement } | null>(null);

    const options = [
        {
            value: 'capability',
            image: autoScene,
            label: 'settings.search.strategy.capability',
        },
        {
            value: 'manual',
            image: defaultScene,
            label: 'settings.search.strategy.manual',
        },
        {
            value: 'priority',
            image: priorityScene,
            label: 'settings.search.strategy.priority',
        },
    ] as const;

    function moveSelection(event: KeyboardEvent) {
        if (props.disabled) return;
        const delta =
            event.key === 'ArrowRight' || event.key === 'ArrowDown'
                ? 1
                : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
                  ? -1
                  : 0;
        if (!delta) return;
        event.preventDefault();
        event.stopPropagation();
        const currentIndex = options.findIndex((option) => option.value === strategy.value);
        const nextIndex = (Math.max(0, currentIndex) + delta + options.length) % options.length;
        strategy.value = options[nextIndex]!.value;
        void nextTick(() => {
            const buttons = rootRef.value?.$el?.querySelectorAll<HTMLElement>('[role="radio"]');
            buttons?.[nextIndex]?.focus();
        });
    }
</script>

<template>
    <div @keydown.capture="moveSelection">
        <RadioGroupRoot
            ref="rootRef"
            v-model="strategy"
            orientation="horizontal"
            :disabled="disabled"
            :aria-label="t('settings.search.strategy')"
            class="flex flex-wrap items-start justify-center gap-2"
        >
            <RadioGroupItem
                v-for="option in options"
                :key="option.value"
                :value="option.value"
                :aria-label="t(option.label)"
                :data-testid="`search-strategy-${option.value}`"
                class="group flex w-40 flex-col items-center gap-1.5 rounded-control border border-border bg-surface-floating p-1.5 text-center text-xs leading-5 text-settings-text transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-400 enabled:cursor-pointer enabled:hover:border-border-strong disabled:cursor-not-allowed disabled:opacity-50 aria-checked:bg-metric-card aria-checked:font-bold"
            >
                <span class="block w-full rounded-sm border border-border bg-surface-floating p-1">
                    <img
                        :src="option.image"
                        alt=""
                        width="160"
                        height="120"
                        class="block h-auto w-full rounded-xs"
                    />
                </span>
                <span>{{ t(option.label) }}</span>
            </RadioGroupItem>
        </RadioGroupRoot>
    </div>
</template>
