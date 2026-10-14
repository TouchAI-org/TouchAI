<script setup lang="ts">
    import {
        DropdownMenuContent,
        type DropdownMenuContentEmits,
        type DropdownMenuContentProps,
        DropdownMenuPortal,
        useForwardPropsEmits,
    } from 'reka-ui';
    import type { HTMLAttributes } from 'vue';
    import { computed, mergeProps, useAttrs } from 'vue';

    import { cn } from '@/lib/utils';

    defineOptions({ inheritAttrs: false });

    interface Props extends DropdownMenuContentProps {
        class?: HTMLAttributes['class'];
        dataContextMenuId?: string;
    }

    const attrs = useAttrs();

    const props = withDefaults(defineProps<Props>(), {
        sideOffset: 4,
        class: '',
    });
    const emits = defineEmits<DropdownMenuContentEmits>();

    const delegatedProps = computed(() => {
        const delegated = { ...props };
        Reflect.deleteProperty(delegated, 'class');
        Reflect.deleteProperty(delegated, 'dataContextMenuId');
        return delegated;
    });

    const forwarded = useForwardPropsEmits(delegatedProps, emits);
    const forwardedWithAttrs = computed(() => mergeProps(forwarded.value, attrs));
</script>

<template>
    <DropdownMenuPortal>
        <DropdownMenuContent
            v-bind="forwardedWithAttrs"
            :data-context-menu-id="props.dataContextMenuId"
            :class="
                cn(
                    'z-50 min-w-[160px] rounded-lg border border-gray-200 bg-white py-1 shadow-lg',
                    't-dropdown',
                    props.class
                )
            "
        >
            <slot />
        </DropdownMenuContent>
    </DropdownMenuPortal>
</template>
