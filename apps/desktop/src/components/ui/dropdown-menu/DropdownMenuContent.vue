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
        /**
         * Render the menu inside the caller's subtree instead of a portal.
         *
         * The search overlays live in a host with its own stacking context, so a
         * portalled menu would paint behind them. `SelectContent` already exposes
         * the same escape hatch for the same reason.
         */
        disablePortal?: boolean;
    }

    const attrs = useAttrs();

    const props = withDefaults(defineProps<Props>(), {
        sideOffset: 4,
        class: '',
        disablePortal: false,
    });
    const emits = defineEmits<DropdownMenuContentEmits>();

    const delegatedProps = computed(() => {
        const delegated = { ...props };
        Reflect.deleteProperty(delegated, 'class');
        Reflect.deleteProperty(delegated, 'dataContextMenuId');
        Reflect.deleteProperty(delegated, 'disablePortal');
        return delegated;
    });

    const forwarded = useForwardPropsEmits(delegatedProps, emits);
    const forwardedWithAttrs = computed(() => mergeProps(forwarded.value, attrs));
</script>

<template>
    <DropdownMenuPortal :disabled="props.disablePortal">
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
