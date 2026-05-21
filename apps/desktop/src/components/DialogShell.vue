<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import { Dialog, DialogContent } from '@components/ui/dialog';

    interface Props {
        maxWidthClass?: string;
        dismissible?: boolean;
        contentClass?: string;
    }

    interface Emits {
        (e: 'close'): void;
    }

    const props = withDefaults(defineProps<Props>(), {
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
</script>

<template>
    <Dialog :open="true" @update:open="onOpenChange">
        <DialogContent
            :class="`w-full ${maxWidthClass} rounded-xl border border-gray-200 bg-white p-6 shadow-xl ${contentClass}`"
            :overlay-class="'fixed inset-0 z-50 bg-black/40 backdrop-blur-sm'"
            @escape-key-down="preventWhenLocked"
            @pointer-down-outside="preventWhenLocked"
            @interact-outside="preventWhenLocked"
        >
            <slot />
        </DialogContent>
    </Dialog>
</template>
