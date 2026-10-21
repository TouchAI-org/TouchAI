<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    defineOptions({
        name: 'UiTooltip',
    });

    import {
        TooltipProvider,
        TooltipRoot,
        type TooltipRootEmits,
        type TooltipRootProps,
        useForwardPropsEmits,
    } from 'reka-ui';
    import { computed } from 'vue';

    import TooltipContent from './TooltipContent.vue';

    interface Props extends TooltipRootProps {
        /**
         * 提示文本。提供该值时组件自动包好 trigger 与 content，
         * 调用点只需用默认插槽放触发元素。
         * 不提供时退化为纯 Root，需自行组合 Trigger / Content。
         */
        text?: string;
        /** content 的额外 class */
        contentClass?: string;
        /** 展开延迟（毫秒） */
        delay?: number;
    }

    const props = withDefaults(defineProps<Props>(), {
        text: undefined,
        contentClass: '',
        delay: 300,
    });

    const emits = defineEmits<TooltipRootEmits>();

    const delegatedProps = computed(() => {
        const delegated = { ...props } as Record<string, unknown>;
        delete delegated.text;
        delete delegated.contentClass;
        delete delegated.delay;
        return delegated;
    });

    const forwarded = useForwardPropsEmits(delegatedProps, emits);
</script>

<template>
    <TooltipProvider :delay-duration="delay">
        <TooltipRoot v-bind="forwarded">
            <slot />
            <TooltipContent v-if="text" :class="contentClass">
                {{ text }}
            </TooltipContent>
            <slot v-else name="content" />
        </TooltipRoot>
    </TooltipProvider>
</template>
