<!-- Copyright (c) 2025-2026. Qian Cheng. Licensed under GPL v3 -->

<script lang="ts">
    type AlertSonnerOwnerListener = () => void;

    let sonnerOwnerUid: number | null = null;
    const alertSonnerOwnerListeners = new Set<AlertSonnerOwnerListener>();

    /**
     * Coordinates the single Sonner host shared by all alert components.
     *
     * Vue runs this ownership protocol on the browser's single JavaScript thread,
     * so checking and assigning the owner is atomic enough without locks. When the
     * owning component unmounts it clears the owner and notifies the remaining
     * subscribers; the first still-mounted instance that refreshes claims the host.
     * If no instances remain, the owner stays empty until another AlertMessage
     * mounts and claims it.
     */
    const notifyAlertSonnerOwnerChanged = (): void => {
        for (const listener of [...alertSonnerOwnerListeners]) {
            listener();
        }
    };

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
            notifyAlertSonnerOwnerChanged();
        }
    };

    const subscribeAlertSonnerOwner = (listener: AlertSonnerOwnerListener): (() => void) => {
        alertSonnerOwnerListeners.add(listener);
        return () => {
            alertSonnerOwnerListeners.delete(listener);
        };
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
    let unsubscribeAlertSonnerOwner: (() => void) | undefined;

    const refreshSonnerOwner = () => {
        if (instanceUid === undefined) return;
        isSonnerOwner.value = claimAlertSonnerOwner(instanceUid);
    };

    if (instanceUid !== undefined) {
        refreshSonnerOwner();
        unsubscribeAlertSonnerOwner = subscribeAlertSonnerOwner(refreshSonnerOwner);
    }

    onUnmounted(() => {
        unsubscribeAlertSonnerOwner?.();
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
