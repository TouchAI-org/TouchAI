<script setup lang="ts">
    import { getAvailableAppUpdateVersion } from '@services/AppUpdateService/availability';
    import { computed } from 'vue';

    import { useAppUpdateState } from '@/composables/useAppUpdateState';
    import { t } from '@/i18n';

    defineEmits<{
        (event: 'click'): void;
    }>();

    const updateState = useAppUpdateState();
    const availableVersion = computed(() => getAvailableAppUpdateVersion(updateState.value));
</script>

<template>
    <button
        v-if="availableVersion"
        type="button"
        class="t-press inline-flex min-h-7 shrink-0 cursor-pointer items-center gap-2 rounded-sm bg-surface-sunken px-2.5 py-1 text-[12px] leading-5 font-normal text-neutral-700 transition-colors hover:bg-surface-selected focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neutral-400"
        data-testid="settings-update-available-badge"
        aria-controls="settings-update-section"
        @click="$emit('click')"
    >
        <span
            aria-hidden="true"
            class="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500 shadow-[0_0_5px_rgba(245,158,11,0.3)]"
        />
        {{ t('settings.general.update.availableBadge', { version: availableVersion }) }}
    </button>
</template>
