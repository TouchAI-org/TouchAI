<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import type { Provider } from '@database/schema';
    import { computed, ref, watch } from 'vue';

    import { t } from '@/i18n';

    import { useSettingsResizablePanel } from '../../../composables/useSettingsResizablePanel';
    import ProviderCard from './ProviderCard.vue';

    const PRIMARY_NAMES = new Set(['OpenAI', 'Anthropic', 'Gemini']);
    const PROMOTED_PROVIDER_DRIVERS = new Set(['mimo']);

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

    const props = defineProps<Props>();
    const emit = defineEmits<Emits>();

    const {
        handleResizeKeyDown,
        handleResizePointerDown,
        panelMaxWidth,
        panelMinWidth,
        panelStyle,
        panelWidth,
    } = useSettingsResizablePanel();

    const promotedProviders = computed<Provider[]>(() =>
        props.providers.filter(
            (provider) =>
                provider.is_builtin === 1 && PROMOTED_PROVIDER_DRIVERS.has(provider.driver)
        )
    );

    const isPromotedBuiltin = (provider: Provider) =>
        provider.is_builtin === 1 && PROMOTED_PROVIDER_DRIVERS.has(provider.driver);

    const primaryProviders = computed(() =>
        props.providers.filter(
            (provider) =>
                !isPromotedBuiltin(provider) && PRIMARY_NAMES.has(provider.name)
        )
    );

    const otherProviders = computed(() =>
        props.providers.filter(
            (provider) =>
                !isPromotedBuiltin(provider) && !PRIMARY_NAMES.has(provider.name)
        )
    );

    const othersExpanded = ref(false);
    let userToggledOthers = false;

    watch(
        () => [props.providers.length, promotedProviders.value.length] as const,
        ([providersLen, promotedLen]) => {
            if (userToggledOthers) return;
            if (providersLen === 0) return;
            othersExpanded.value = promotedLen === 0;
        },
        { immediate: true }
    );

    const showOthersToggle = computed(
        () =>
            otherProviders.value.length > 0 &&
            (promotedProviders.value.length > 0 || primaryProviders.value.length > 0)
    );

    const toggleOthers = () => {
        userToggledOthers = true;
        othersExpanded.value = !othersExpanded.value;
    };
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
                v-for="provider in promotedProviders"
                :key="provider.id"
                :provider="provider"
                :is-selected="provider.id === selectedProviderId"
                :has-default-model="defaultModelProviderIds.has(provider.id)"
                :promoted="true"
                @select="emit('select', provider.id)"
                @toggle-enabled="emit('toggle-enabled', provider.id)"
                @validation-error="emit('validation-error', $event)"
                @context-menu="emit('context-menu', provider.id, $event)"
            />

            <ProviderCard
                v-for="provider in primaryProviders"
                :key="provider.id"
                :provider="provider"
                :is-selected="provider.id === selectedProviderId"
                :has-default-model="defaultModelProviderIds.has(provider.id)"
                @select="emit('select', provider.id)"
                @toggle-enabled="emit('toggle-enabled', provider.id)"
                @validation-error="emit('validation-error', $event)"
                @context-menu="emit('context-menu', provider.id, $event)"
            />

            <button
                v-if="showOthersToggle"
                type="button"
                class="flex w-full items-center gap-1.5 rounded-lg px-3 py-2 text-left font-serif text-xs text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700"
                @click="toggleOthers"
            >
                <AppIcon
                    :name="othersExpanded ? 'chevron-down' : 'chevron-right'"
                    class="h-3.5 w-3.5 shrink-0"
                />
                <span>
                    {{
                        othersExpanded
                            ? t('settings.ai.collapseOthers')
                            : t('settings.ai.expandOthers')
                    }}
                </span>
            </button>

            <template v-if="othersExpanded">
                <ProviderCard
                    v-for="provider in otherProviders"
                    :key="provider.id"
                    :provider="provider"
                    :is-selected="provider.id === selectedProviderId"
                    :has-default-model="defaultModelProviderIds.has(provider.id)"
                    @select="emit('select', provider.id)"
                    @toggle-enabled="emit('toggle-enabled', provider.id)"
                    @validation-error="emit('validation-error', $event)"
                    @context-menu="emit('context-menu', provider.id, $event)"
                />
            </template>
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
