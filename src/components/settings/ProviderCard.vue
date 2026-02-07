<!-- Copyright (c) 2025. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import type { Provider } from '@database/schema';
    import { computed } from 'vue';

    import BadgedLogo from './BadgedLogo.vue';

    interface Props {
        provider: Provider;
        isSelected: boolean;
        hasDefaultModel: boolean;
    }

    interface Emits {
        (e: 'select'): void;
        (e: 'toggle-enabled'): void;
        (e: 'validation-error', message: string): void;
        (e: 'context-menu', event: MouseEvent): void;
    }

    const props = defineProps<Props>();
    const emit = defineEmits<Emits>();

    const isToggleDisabled = computed(() => {
        // 如果服务商已启用且有默认模型，则不能禁用
        return props.provider.enabled === 1 && props.hasDefaultModel;
    });

    const handleToggle = () => {
        // 如果要启用服务商，检查是否填写了必要信息
        if (props.provider.enabled === 0) {
            // 检查 API 地址
            if (!props.provider.api_endpoint || props.provider.api_endpoint.trim() === '') {
                emit('validation-error', '请先配置 API 地址后再启用服务商');
                return;
            }
        }

        emit('toggle-enabled');
    };

    const handleContextMenu = (event: MouseEvent) => {
        // 只对非内置服务商显示右键菜单
        if (props.provider.is_builtin === 0) {
            event.preventDefault();
            emit('context-menu', event);
        }
    };
</script>

<template>
    <div
        class="provider-card flex cursor-pointer items-center gap-3 rounded-lg border p-3 transition-all"
        :class="{
            'border-primary-300 bg-primary-50/50': isSelected,
            'border-gray-200 bg-white hover:border-gray-300': !isSelected,
        }"
        @click="emit('select')"
        @contextmenu="handleContextMenu"
    >
        <BadgedLogo
            :logo="provider.logo"
            :name="provider.name"
            size="small"
            :show-badge="provider.is_builtin === 1"
        />

        <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
                <h3 class="truncate font-serif text-sm font-medium text-gray-900">
                    {{ provider.name }}
                </h3>
                <span
                    v-if="hasDefaultModel"
                    class="bg-primary-50 text-primary-600 rounded-full px-2 py-0.5 text-xs"
                >
                    默认
                </span>
            </div>
        </div>

        <label class="relative inline-flex cursor-pointer items-center" @click.stop>
            <input
                type="checkbox"
                :checked="provider.enabled === 1"
                :disabled="isToggleDisabled"
                class="peer sr-only"
                @change="handleToggle"
            />
            <div
                class="peer h-5 w-9 rounded-full transition-colors"
                :class="{
                    'bg-primary-500': provider.enabled === 1,
                    'bg-gray-200': provider.enabled === 0,
                    'cursor-not-allowed opacity-50': isToggleDisabled,
                }"
            >
                <div
                    class="absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-transform"
                    :class="{
                        'translate-x-4': provider.enabled === 1,
                        'translate-x-0': provider.enabled === 0,
                    }"
                ></div>
            </div>
        </label>
    </div>
</template>

<style scoped></style>
