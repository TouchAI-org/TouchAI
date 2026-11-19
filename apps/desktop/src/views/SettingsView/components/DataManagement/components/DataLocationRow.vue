<script setup lang="ts">
    import SettingsRow from '@components/SettingsRow.vue';
    import { Button } from '@components/ui/button';
    import { useAlert } from '@composables/useAlert';
    import { useConfirm } from '@composables/useConfirm';
    import { open } from '@tauri-apps/plugin-dialog';
    import { relaunch } from '@tauri-apps/plugin-process';
    import { computed, onMounted, onUnmounted, ref } from 'vue';

    import { type MessageKey, t } from '@/i18n';
    import type { DataLocationInfo } from '@/services/NativeService/storage';
    import { log } from '@/services/ObservabilityService';
    import { storageService } from '@/services/StorageService';

    const props = defineProps<{ disabled: boolean }>();
    const emit = defineEmits<{ busyChange: [busy: boolean] }>();
    const location = ref<DataLocationInfo | null>(null);
    const busy = ref(false);
    const error = ref<MessageKey | null>(null);
    const alert = useAlert();
    const { confirm } = useConfirm();
    let disposed = false;
    const disabled = computed(() => props.disabled || busy.value);
    const errorKeys: Record<string, MessageKey> = {
        storage_move_overlap: 'settings.storage.location.overlap',
        storage_move_not_empty: 'settings.storage.location.notEmpty',
        storage_move_cleanup_pending: 'settings.storage.location.cleanupPending',
        storage_move_source_missing: 'settings.storage.location.sourceMissing',
        storage_insufficient_space: 'settings.storage.errors.insufficientSpace',
        storage_invalid_path: 'settings.storage.errors.invalidPath',
        storage_busy: 'settings.storage.errors.busy',
    };

    function displayPath(path: string) {
        return path.replace(/^\\\\\?\\UNC\\/, '\\\\').replace(/^\\\\\?\\/, '');
    }

    function report(cause: unknown) {
        const code =
            typeof cause === 'string' ? cause : cause instanceof Error ? cause.message : '';
        log.error('[Storage] Data location operation failed', {
            code: code in errorKeys ? code : 'unknown',
        });
        if (!disposed) error.value = errorKeys[code] ?? 'settings.storage.location.failed';
    }

    async function load() {
        try {
            const result = await storageService.getLocation();
            if (disposed) return;
            location.value = result;
            if (result.notice) report(result.notice);
        } catch (cause) {
            report(cause);
        }
    }

    async function restart() {
        try {
            await relaunch();
        } catch (cause) {
            log.error('[Storage] Data move requires a manual restart', cause);
            if (!disposed) alert.warning(t('settings.storage.location.restartRequired'));
        }
    }

    async function move() {
        if (disabled.value || disposed) return;
        busy.value = true;
        emit('busyChange', true);
        try {
            const destination = await open({
                directory: true,
                multiple: false,
                title: t('settings.storage.location.choose'),
            });
            if (disposed || !destination || Array.isArray(destination)) return;
            const accepted = await confirm({
                title: t('settings.storage.location.move'),
                message: t('settings.storage.location.confirm', { path: destination }),
                type: 'info',
            });
            if (!accepted || disposed) return;
            const next = await storageService.scheduleMove(destination);
            if (disposed) return;
            location.value = next;
            error.value = null;
            await restart();
        } catch (cause) {
            report(cause);
        } finally {
            if (!disposed) {
                busy.value = false;
                emit('busyChange', false);
            }
        }
    }

    async function cancel() {
        if (disabled.value || disposed) return;
        busy.value = true;
        emit('busyChange', true);
        try {
            const next = await storageService.cancelMove();
            if (!disposed) {
                location.value = next;
                error.value = null;
            }
        } catch (cause) {
            report(cause);
        } finally {
            if (!disposed) {
                busy.value = false;
                emit('busyChange', false);
            }
        }
    }
    onMounted(load);
    onUnmounted(() => {
        disposed = true;
        emit('busyChange', false);
    });
</script>

<template>
    <SettingsRow
        data-settings-search-target="data-location"
        control-width="auto"
        :label="t('settings.storage.location.title')"
    >
        <template #description>
            <p v-if="location" class="mt-1 text-caption break-all text-text-secondary select-text">
                {{ displayPath(location.currentPath) }}
            </p>
            <p
                v-if="location?.pendingPath"
                class="mt-1 text-caption break-all text-text-secondary"
                role="status"
            >
                {{
                    t('settings.storage.location.pending', {
                        path: displayPath(location.pendingPath),
                    })
                }}
            </p>
            <p v-if="error" class="mt-1 text-caption text-text-danger" role="alert">
                {{ t(error) }}
            </p>
            <p
                v-if="error && location?.previousPath"
                class="mt-1 text-caption break-all text-text-secondary select-text"
            >
                {{ displayPath(location.previousPath) }}
            </p>
        </template>
        <div v-if="location?.pendingPath" class="flex flex-wrap gap-2">
            <Button variant="outline-neutral" :disabled="disabled" @click="cancel">
                {{ t('common.cancel') }}
            </Button>
            <Button variant="strong" :disabled="disabled" @click="restart">
                {{ t('settings.storage.selection.restart') }}
            </Button>
        </div>
        <Button
            v-else
            variant="outline-neutral"
            :disabled="disabled || !location"
            data-testid="settings-data-move"
            @click="move"
        >
            {{ t('settings.storage.location.move') }}
        </Button>
    </SettingsRow>
</template>
