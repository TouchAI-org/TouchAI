<!-- Copyright (c) 2025. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import { computed } from 'vue';

    interface Props {
        logo: string;
        name: string;
        size?: 'small' | 'large';
        showBadge?: boolean;
    }

    const props = withDefaults(defineProps<Props>(), {
        size: 'small',
        showBadge: false,
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
        return props.size === 'large' ? 'h-14 w-14' : 'h-10 w-10';
    });

    const textSizeClass = computed(() => {
        return props.size === 'large' ? 'text-xl' : 'text-base';
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
            v-if="showBadge"
            class="absolute top-0 right-0 translate-x-1/2 -translate-y-1/2 rounded border border-gray-300 bg-white px-1 py-0.5 text-[10px] leading-none text-gray-600 shadow-sm"
        >
            内置
        </span>
    </div>
</template>
