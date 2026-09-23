<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import type { Provider } from '@database/schema';

    import { t } from '@/i18n';

    import { useSettingsResizablePanel } from '../../../composables/useSettingsResizablePanel';
    import ProviderCard from './ProviderCard.vue';

    interface Props {
        providers: Provider[];
        selectedProviderId: number | null;
        defaultModelProviderIds: Set<number>;
    }

    interface Emits {
        (e: 'select', providerId: number): void;
        (e: 'toggle-enabled', providerId: number): void;
        (e: 'add-custom'): void;
        (e: 'validation-error', message: string): void;
        (e: 'context-menu', providerId: number, event: MouseEvent): void;
    }

    defineProps<Props>();
    const emit = defineEmits<Emits>();

    const {
        handleResizeKeyDown,
        handleResizePointerDown,
        panelMaxWidth,
        panelMinWidth,
        panelStyle,
        panelWidth,
    } = useSettingsResizablePanel();
</script>

<template>
    <div
        class="settings-side-panel"
        :style="panelStyle"
        data-settings-secondary-panel="true"
        data-testid="settings-ai-services-panel"
    >
        <div class="settings-scrollbar flex-1 space-y-2 overflow-y-auto p-4 pt-5">
            <ProviderCard
                v-for="provider in providers"
                :key="provider.id"
                :provider="provider"
                :is-selected="provider.id === selectedProviderId"
                :has-default-model="defaultModelProviderIds.has(provider.id)"
                @select="emit('select', provider.id)"
                @toggle-enabled="emit('toggle-enabled', provider.id)"
                @validation-error="emit('validation-error', $event)"
                @context-menu="emit('context-menu', provider.id, $event)"
            />
        </div>

        <div class="settings-side-panel-footer">
            <button
                class="settings-button-primary flex w-full items-center justify-center gap-2 break-words whitespace-normal"
                data-testid="settings-add-custom-provider-button"
                @click="emit('add-custom')"
            >
                <AppIcon name="plus" class="h-4 w-4" />
                {{ t('settings.ai.addProvider.title') }}
            </button>
        </div>

        <div
            data-testid="settings-ai-services-panel-resizer"
            role="separator"
            aria-orientation="vertical"
            :aria-valuemin="panelMinWidth"
            :aria-valuemax="panelMaxWidth"
            :aria-valuenow="panelWidth"
            tabindex="0"
            class="settings-side-panel-resizer"
            :title="t('settings.ai.resizeProviderList')"
            @keydown="handleResizeKeyDown"
            @pointerdown="handleResizePointerDown"
        />
    </div>
</template>
