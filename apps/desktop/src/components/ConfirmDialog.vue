<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import type { AppIconName } from '@components/appIconMap';
    import {
        AlertDialog,
        AlertDialogAction,
        AlertDialogCancel,
        AlertDialogContent,
        AlertDialogDescription,
        AlertDialogFooter,
        AlertDialogHeader,
        AlertDialogTitle,
    } from '@components/ui/alert-dialog';
    import { ref, watch } from 'vue';

    import { t } from '@/i18n';

    interface Props {
        open?: boolean;
        title?: string;
        message: string;
        confirmText?: string;
        cancelText?: string;
        type?: 'warning' | 'danger' | 'info';
    }

    interface Emits {
        (e: 'confirm'): void;
        (e: 'cancel'): void;
        (e: 'closed'): void;
    }

    const props = withDefaults(defineProps<Props>(), {
        open: true,
        title: '',
        confirmText: '',
        cancelText: '',
        type: 'warning',
    });

    const emit = defineEmits<Emits>();
    const isOpen = ref(props.open);
    const hasResult = ref(false);

    const closeWithResult = (result: 'confirm' | 'cancel') => {
        if (!hasResult.value) {
            hasResult.value = true;
            if (result === 'confirm') emit('confirm');
            else emit('cancel');
        }
        isOpen.value = false;
    };

    const handleConfirm = () => closeWithResult('confirm');
    const handleCancel = () => closeWithResult('cancel');

    // Keep the component reusable when a parent controls the lifecycle. The
    // imperative confirm composable normally leaves this at `true`, but a
    // controlled host may close and reopen the same instance.
    watch(
        () => props.open,
        (open) => {
            if (open) {
                hasResult.value = false;
                isOpen.value = true;
            } else if (isOpen.value) {
                handleCancel();
            }
        }
    );

    const handleOpenChange = (open: boolean) => {
        isOpen.value = open;
        if (!open && !hasResult.value) closeWithResult('cancel');
    };

    const handleAnimationEnd = (event: AnimationEvent) => {
        if (event.target === event.currentTarget && event.animationName === 't-modal-out') {
            emit('closed');
        }
    };

    const iconName = (): AppIconName => {
        switch (props.type) {
            case 'danger':
                return 'exclamation-triangle';
            case 'info':
                return 'information-circle';
            default:
                return 'exclamation-triangle';
        }
    };

    const iconColorClass = () => {
        switch (props.type) {
            case 'danger':
                return 'text-red-500';
            case 'info':
                return 'text-blue-500';
            default:
                return 'text-yellow-500';
        }
    };
</script>

<template>
    <AlertDialog :open="isOpen" @update:open="handleOpenChange">
        <AlertDialogContent
            class="w-full max-w-md rounded-xl border border-gray-200 bg-white p-6 shadow-xl"
            @escape-key-down="handleCancel"
            @pointer-down-outside="handleCancel"
            @interact-outside="handleCancel"
            @animationend="handleAnimationEnd"
        >
            <AlertDialogHeader class="flex items-start gap-4">
                <div
                    class="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full"
                    :class="{
                        'bg-red-50': type === 'danger',
                        'bg-yellow-50': type === 'warning',
                        'bg-blue-50': type === 'info',
                    }"
                >
                    <AppIcon :name="iconName()" class="h-5 w-5" :class="iconColorClass()" />
                </div>

                <div class="flex-1">
                    <AlertDialogTitle class="font-serif text-base font-semibold text-gray-900">
                        {{ title || t('common.confirmAction') }}
                    </AlertDialogTitle>
                    <AlertDialogDescription class="mt-2 text-sm text-gray-600">
                        {{ message }}
                    </AlertDialogDescription>
                </div>
            </AlertDialogHeader>

            <AlertDialogFooter class="mt-6 flex gap-3">
                <AlertDialogCancel
                    class="flex-1 rounded-lg border border-gray-200 px-4 py-2 font-serif text-sm font-medium text-gray-600 transition-colors hover:border-gray-300 hover:bg-gray-50"
                    @click.capture="handleCancel"
                >
                    {{ cancelText || t('common.cancel') }}
                </AlertDialogCancel>
                <AlertDialogAction
                    class="flex-1 rounded-lg px-4 py-2 font-serif text-sm font-medium text-white transition-colors"
                    :class="{
                        'bg-red-500 hover:bg-red-600': type === 'danger',
                        'bg-yellow-500 hover:bg-yellow-600': type === 'warning',
                        'bg-blue-500 hover:bg-blue-600': type === 'info',
                    }"
                    @click.capture="handleConfirm"
                >
                    {{ confirmText || t('common.confirm') }}
                </AlertDialogAction>
            </AlertDialogFooter>
        </AlertDialogContent>
    </AlertDialog>
</template>
