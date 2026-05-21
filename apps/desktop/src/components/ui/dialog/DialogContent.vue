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
    import { computed } from 'vue';

    import { cn } from '@/lib/utils';

    interface Props extends DialogContentProps {
        class?: HTMLAttributes['class'];
        overlayClass?: HTMLAttributes['class'];
    }

    const props = defineProps<Props>();
    const emits = defineEmits<DialogContentEmits>();

    const delegatedProps = computed(() => {
        const delegated = { ...props };
        delete delegated.class;
        delete delegated.overlayClass;
        return delegated;
    });

    const forwarded = useForwardPropsEmits(delegatedProps, emits);
</script>

<template>
    <DialogPortal>
        <DialogOverlay
            :class="
                cn(
                    'fixed inset-0 z-50 bg-black/40 backdrop-blur-sm',
                    'data-[state=open]:animate-in data-[state=closed]:animate-out',
                    props.overlayClass
                )
            "
        />
        <DialogContent
            v-bind="forwarded"
            :class="
                cn(
                    'fixed top-[50%] left-[50%] z-50 grid w-full translate-x-[-50%] translate-y-[-50%]',
                    'data-[state=open]:animate-in data-[state=closed]:animate-out',
                    props.class
                )
            "
        >
            <slot />
        </DialogContent>
    </DialogPortal>
</template>
