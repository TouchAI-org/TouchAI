<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import { Dialog, DialogContent } from '@components/ui/dialog';

    interface Props {
        open?: boolean;
        maxWidthClass?: string;
        dismissible?: boolean;
        contentClass?: string;
    }

    interface Emits {
        (e: 'close'): void;
        (e: 'closed'): void;
    }

    const props = withDefaults(defineProps<Props>(), {
        open: true,
        maxWidthClass: 'max-w-md',
        dismissible: false,
        contentClass: '',
    });

    const emit = defineEmits<Emits>();

    const onOpenChange = (open: boolean) => {
        if (!open && props.dismissible) {
            emit('close');
        }
    };

    const preventWhenLocked = (event: Event) => {
        if (!props.dismissible) {
            event.preventDefault();
        }
    };

    const onAnimationEnd = (event: AnimationEvent) => {
        if (event.target === event.currentTarget && event.animationName === 't-modal-out') {
            emit('closed');
        }
    };
</script>

<template>
    <Dialog :open="props.open" @update:open="onOpenChange">
        <DialogContent
            :inert="!props.open || undefined"
            :class="`w-full ${maxWidthClass} rounded-xl border border-gray-200 bg-white p-6 shadow-xl ${contentClass}`"
            :overlay-class="'fixed inset-0 z-50 bg-black/40 backdrop-blur-sm'"
            @escape-key-down="preventWhenLocked"
            @pointer-down-outside="preventWhenLocked"
            @interact-outside="preventWhenLocked"
            @animationend="onAnimationEnd"
        >
            <slot />
        </DialogContent>
    </Dialog>
</template>
