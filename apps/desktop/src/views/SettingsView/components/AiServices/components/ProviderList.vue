<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import type { Provider } from '@database/schema';

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
</script>

<template>
    <div class="flex h-full w-72 flex-col border-r border-gray-200 bg-white/60">
        <div class="border-b border-gray-200 bg-white/80 p-4">
            <h2 class="font-serif text-base font-semibold text-gray-900">大模型服务</h2>
        </div>

        <div class="custom-scrollbar flex-1 space-y-2 overflow-y-auto p-3">
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

        <div class="border-t border-gray-200 bg-white/80 p-3">
            <button
                class="bg-primary-500 hover:bg-primary-600 w-full rounded-lg px-4 py-2 font-serif text-sm font-medium text-white transition-colors"
                @click="emit('add-custom')"
            >
                + 添加自定义服务商
            </button>
        </div>
    </div>
</template>
