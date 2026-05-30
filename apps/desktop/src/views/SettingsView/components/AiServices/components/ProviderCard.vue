<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import type { Provider } from '@database/schema';
    import { computed } from 'vue';

    import { t } from '@/i18n';

    import BadgedLogo from './BadgedLogo.vue';
    interface Props {
        provider: Provider;
        isSelected: boolean;
        promoted?: boolean;
    }

    interface Emits {
        (e: 'select'): void;
        (e: 'toggle-enabled'): void;
        (e: 'validation-error', message: string): void;
        (e: 'context-menu', event: MouseEvent): void;
    }

    const props = withDefaults(defineProps<Props>(), {
        promoted: false,
    });
    const emit = defineEmits<Emits>();

    const isToggleDisabled = computed(() => {
        return false;
    });

    const handleToggle = () => {
        // 如果要启用服务商，检查是否填写了必要信息
        if (props.provider.enabled === 0) {
            // 检查 API 地址
            if (!props.provider.api_endpoint || props.provider.api_endpoint.trim() === '') {
                emit('validation-error', t('settings.ai.configureApiUrlBeforeEnable'));
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
        class="provider-card flex cursor-pointer items-center gap-2.5 rounded-[11px] border px-3 py-2.5 transition-colors"
        :class="isSelected ? 'settings-item-selected' : 'settings-item-unselected'"
        @click="emit('select')"
        @contextmenu="handleContextMenu"
    >
        <BadgedLogo
            :logo="provider.logo"
            :name="provider.name"
            size="small"
            :show-badge="provider.is_builtin === 1"
            :promoted="promoted"
            class="shrink-0"
        />

        <div class="min-w-0 flex-1">
            <div class="flex min-w-0 items-center gap-2">
                <h3
                    class="min-w-0 flex-1 truncate text-[13px] font-normal text-neutral-950"
                    data-no-i18n="true"
                    translate="no"
                >
                    {{ provider.name }}
                </h3>
            </div>
        </div>

        <label class="relative inline-flex shrink-0 cursor-pointer items-center" @click.stop>
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
                    'bg-primary-700': provider.enabled === 1,
                    'bg-neutral-200': provider.enabled === 0,
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
