<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import { computed } from 'vue';

    import { t } from '@/i18n';
    interface Props {
        logo: string;
        name: string;
        size?: 'small' | 'large';
        showBadge?: boolean;
        promoted?: boolean;
    }

    const props = withDefaults(defineProps<Props>(), {
        size: 'small',
        showBadge: false,
        promoted: false,
    });

    // 使用 Vite 的 glob import 预加载所有提供商 logo，按文件名索引
    const rawLogos = import.meta.glob<{ default: string }>('@assets/logos/providers/*', {
        eager: true,
    });
    const providerLogos: Record<string, string> = {};
    for (const [path, mod] of Object.entries(rawLogos)) {
        const fileName = path.split('/').pop();
        if (fileName && mod.default) providerLogos[fileName] = mod.default;
    }

    const logoPath = computed(() => {
        return providerLogos[props.logo] || '';
    });

    const sizeClasses = computed(() => {
        return props.size === 'large' ? 'h-12 w-12' : 'h-8 w-8';
    });

    const textSizeClass = computed(() => {
        return props.size === 'large' ? 'text-lg' : 'text-sm';
    });
</script>

<template>
    <div class="relative inline-block">
        <img
            v-if="logoPath"
            :src="logoPath"
            :alt="name"
            class="rounded-lg object-contain"
            :class="sizeClasses"
        />
        <div
            v-else
            class="flex items-center justify-center rounded-lg bg-gray-100 font-semibold text-gray-500"
            :class="[sizeClasses, textSizeClass]"
        >
            {{ name.charAt(0) }}
        </div>

        <span
            v-if="promoted"
            class="absolute top-0 right-0 min-w-max translate-x-1/2 -translate-y-1/2 rounded border border-amber-300 bg-gradient-to-r from-amber-400 to-yellow-500 px-1 py-0.5 text-[9px] leading-none font-medium whitespace-nowrap text-white shadow-sm"
        >
            {{ t('common.recommended') }}
        </span>
        <span
            v-else-if="showBadge"
            data-testid="provider-built-in-badge"
            class="absolute top-0 right-0 min-w-max translate-x-1/2 -translate-y-1/2 rounded border border-neutral-300 bg-white px-1 py-0.5 text-[9px] leading-none whitespace-nowrap text-neutral-600 shadow-sm"
        >
            {{ t('common.builtIn') }}
        </span>
    </div>
</template>
