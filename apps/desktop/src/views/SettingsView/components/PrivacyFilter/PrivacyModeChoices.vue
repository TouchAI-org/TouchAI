<script setup lang="ts">
    import { RadioGroupItem, RadioGroupRoot } from 'reka-ui';

    import modelScene from '@/assets/privacy/model.svg';
    import rulesScene from '@/assets/privacy/rules.svg';
    import { t } from '@/i18n';

    const mode = defineModel<'model' | 'rules'>({ required: true });
    defineProps<{ disabled: boolean }>();
    const options = [
        { value: 'model', image: modelScene },
        { value: 'rules', image: rulesScene },
    ] as const;
</script>

<template>
    <RadioGroupRoot
        v-model="mode"
        orientation="horizontal"
        :disabled="disabled"
        :aria-label="t('settings.privacyFilter.mode.label')"
        class="flex flex-wrap items-center justify-end gap-2"
    >
        <RadioGroupItem
            v-for="option in options"
            :key="option.value"
            :value="option.value"
            :aria-label="t(`settings.privacyFilter.mode.${option.value}`)"
            :data-testid="`privacy-filter-mode-${option.value}`"
            class="group relative flex w-40 flex-col items-center gap-1.5 rounded-control border border-border bg-surface-floating p-1.5 text-center text-xs leading-5 text-text-secondary transition-colors focus-visible:bg-surface-hover focus-visible:underline focus-visible:underline-offset-4 enabled:cursor-pointer enabled:hover:border-border-strong enabled:hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50 aria-checked:bg-metric-card aria-checked:font-bold aria-checked:text-text-primary"
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
            <span>{{ t(`settings.privacyFilter.mode.${option.value}`) }}</span>
        </RadioGroupItem>
    </RadioGroupRoot>
</template>
