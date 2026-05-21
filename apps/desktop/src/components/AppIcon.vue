<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import { appIconFallback, appIconMap, type AppIconName } from '@components/appIconMap';
    import { type Component, computed } from 'vue';

    defineOptions({
        inheritAttrs: false,
    });

    const props = defineProps<{
        name: AppIconName;
    }>();

    const warnedNames = new Set<string>();

    const iconComponent = computed<Component>(() => {
        const resolved = appIconMap[props.name];
        if (resolved) {
            return resolved;
        }

        // 未知图标名如果继续静默失败，问题只会在视觉验收时暴露。
        // 开发环境里给出一次性告警，并返回占位图标保持布局稳定。
        if (import.meta.env.DEV && !warnedNames.has(props.name)) {
            warnedNames.add(props.name);
            console.warn(`[AppIcon] 未找到图标映射: ${props.name}`);
        }

        return appIconFallback;
    });
</script>

<template>
    <component :is="iconComponent" v-bind="$attrs" />
</template>
