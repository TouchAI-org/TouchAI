<!-- Copyright (c) 2025-2026. Qian Cheng. Licensed under GPL v3 -->

<script lang="ts">
    let sonnerOwnerUid: number | null = null;

    const claimAlertSonnerOwner = (uid: number): boolean => {
        if (sonnerOwnerUid === null) {
            sonnerOwnerUid = uid;
            return true;
        }

        return sonnerOwnerUid === uid;
    };

    const releaseAlertSonnerOwner = (uid: number): void => {
        if (sonnerOwnerUid === uid) {
            sonnerOwnerUid = null;
        }
    };
</script>

<script setup lang="ts">
    import { Sonner } from '@components/ui/sonner';
    import { getCurrentInstance, onUnmounted, ref } from 'vue';
    import { toast } from 'vue-sonner';

    type AlertId = string | number;

    interface AlertProps {
        id: AlertId;
        type: 'success' | 'error' | 'warning' | 'info';
        message: string;
        duration?: number;
    }

    const isSonnerOwner = ref(false);
    const instanceUid = getCurrentInstance()?.uid;

    if (instanceUid !== undefined) {
        isSonnerOwner.value = claimAlertSonnerOwner(instanceUid);
    }

    onUnmounted(() => {
        if (instanceUid !== undefined && isSonnerOwner.value) {
            releaseAlertSonnerOwner(instanceUid);
        }
    });

    const show = (type: AlertProps['type'], message: string, duration: number = 3000): AlertId => {
        const options = { duration };
        const id =
            type === 'success'
                ? toast.success(message, options)
                : type === 'error'
                  ? toast.error(message, options)
                  : type === 'warning'
                    ? toast.warning(message, options)
                    : toast.info(message, options);

        return id;
    };

    const close = (id: AlertId) => {
        toast.dismiss(id);
    };

    const success = (message: string, duration?: number) => show('success', message, duration);
    const error = (message: string, duration?: number) => show('error', message, duration);
    const warning = (message: string, duration?: number) => show('warning', message, duration);
    const info = (message: string, duration?: number) => show('info', message, duration);

    defineExpose({
        show,
        close,
        success,
        error,
        warning,
        info,
    });
</script>

<template>
    <Sonner v-if="isSonnerOwner" />
</template>
