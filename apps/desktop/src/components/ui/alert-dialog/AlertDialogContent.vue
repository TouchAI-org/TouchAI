<script setup lang="ts">
    import {
        AlertDialogContent,
        type AlertDialogContentEmits,
        type AlertDialogContentProps,
        AlertDialogOverlay,
        AlertDialogPortal,
        useForwardPropsEmits,
    } from 'reka-ui';
    import type { HTMLAttributes } from 'vue';
    import { computed, mergeProps, useAttrs } from 'vue';

    import { cn } from '@/lib/utils';

    defineOptions({ inheritAttrs: false });

    interface Props extends AlertDialogContentProps {
        class?: HTMLAttributes['class'];
        overlayClass?: HTMLAttributes['class'];
    }

    const attrs = useAttrs();

    const props = defineProps<Props>();
    const emits = defineEmits<AlertDialogContentEmits>();

    const delegatedProps = computed(() => {
        const delegated = { ...props };
        delete delegated.class;
        delete delegated.overlayClass;
        return delegated;
    });

    const forwarded = useForwardPropsEmits(delegatedProps, emits);
    const forwardedWithAttrs = computed(() => mergeProps(forwarded.value, attrs));
</script>

<template>
    <AlertDialogPortal>
        <AlertDialogOverlay
            :class="
                cn(
                    'fixed inset-0 z-50 bg-black/40 backdrop-blur-sm',
                    't-overlay',
                    props.overlayClass
                )
            "
        />
        <AlertDialogContent
            v-bind="forwardedWithAttrs"
            :class="
                cn(
                    /*
                     * `overflow-y-auto` pairs with the `max-h` cap: without it the box
                     * stops growing while its content keeps `overflow: visible`, so the
                     * overflow runs past the viewport and footer actions become
                     * unreachable. `ConfirmDialog` puts its slot here directly, so the
                     * scroll container has to live at this level.
                     */
                    'fixed inset-0 z-50 m-auto grid h-fit max-h-[calc(100dvh-4rem)] w-full max-w-md overflow-y-auto',
                    't-modal',
                    props.class
                )
            "
        >
            <slot />
        </AlertDialogContent>
    </AlertDialogPortal>
</template>
