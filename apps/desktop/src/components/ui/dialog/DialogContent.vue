<script setup lang="ts">
    import {
        DialogContent,
        type DialogContentEmits,
        type DialogContentProps,
        DialogOverlay,
        DialogPortal,
        useForwardPropsEmits,
    } from 'reka-ui';
    import type { HTMLAttributes } from 'vue';
    import { computed, mergeProps, useAttrs } from 'vue';

    import { cn } from '@/lib/utils';

    import { useSettingsModalTarget } from '../settingsModalTarget';

    defineOptions({ inheritAttrs: false });

    interface Props extends DialogContentProps {
        class?: HTMLAttributes['class'];
        overlayClass?: HTMLAttributes['class'];
    }

    const attrs = useAttrs();

    const props = defineProps<Props>();
    const emits = defineEmits<DialogContentEmits>();

    const delegatedProps = computed(() => {
        const delegated = { ...props };
        delete delegated.class;
        delete delegated.overlayClass;
        return delegated;
    });

    const forwarded = useForwardPropsEmits(delegatedProps, emits);
    const forwardedWithAttrs = computed(() => mergeProps(forwarded.value, attrs));
    const { portalTarget, inSettingsShell } = useSettingsModalTarget();
</script>

<template>
    <DialogPortal :to="portalTarget">
        <DialogOverlay
            :class="
                cn(
                    inSettingsShell ? 'absolute' : 'fixed',
                    'pointer-events-auto inset-0 z-50 bg-black/40 backdrop-blur-sm',
                    't-overlay',
                    props.overlayClass
                )
            "
        />
        <DialogContent
            v-bind="forwardedWithAttrs"
            :class="
                cn(
                    /*
                     * `overflow-y-auto` pairs with the `max-h` cap: without it the box
                     * stops growing while its content keeps `overflow: visible`, so the
                     * overflow runs past the viewport and footer actions become
                     * unreachable. `DialogShell` puts its slot here directly, so the
                     * scroll container has to live at this level.
                     */
                    inSettingsShell ? 'absolute' : 'fixed',
                    'pointer-events-auto inset-0 z-50 m-auto grid h-fit max-h-[calc(100dvh-4rem)] w-full overflow-y-auto',
                    't-modal',
                    props.class
                )
            "
        >
            <slot />
        </DialogContent>
    </DialogPortal>
</template>
