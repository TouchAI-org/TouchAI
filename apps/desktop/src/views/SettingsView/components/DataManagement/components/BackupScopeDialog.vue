<script setup lang="ts">
    import DialogShell from '@components/DialogShell.vue';
    import { Button } from '@components/ui/button';
    import { Switch } from '@components/ui/switch';
    import type { ImportMode } from '@database/backup';
    import { computed, ref, watch } from 'vue';

    import { t } from '@/i18n';

    const props = defineProps<{
        action: 'export' | 'import';
        available: ImportMode;
        open: boolean;
        isLoading: boolean;
    }>();
    const emit = defineEmits<{
        select: [mode: ImportMode];
        close: [];
        closed: [];
    }>();
    const settings = ref(false);
    const data = ref(false);
    watch(
        () => [props.open, props.available, props.action],
        () => {
            if (props.open) {
                settings.value = props.available !== 'chat_only';
                data.value = props.available !== 'settings_only';
            }
        },
        { immediate: true }
    );
    const scope = computed<ImportMode | null>(() => {
        if (settings.value) return data.value ? 'full' : 'settings_only';
        return data.value ? 'chat_only' : null;
    });
</script>

<template>
    <DialogShell :open="open" dismissible @close="emit('close')" @closed="emit('closed')">
        <h3 class="settings-section-title">
            {{
                t(
                    action === 'export'
                        ? 'settings.dataManagement.exportSettings'
                        : 'settings.dataManagement.importSettings'
                )
            }}
        </h3>
        <div class="my-4 divide-y divide-border-subtle">
            <div class="flex items-center justify-between gap-4 py-3">
                <label for="backup-scope-settings" class="min-w-0">
                    <span class="block text-compact font-medium text-text-primary">
                        {{ t('settings.backup.scope.settings') }}
                    </span>
                    <span class="text-caption text-text-secondary">
                        {{ t('settings.backup.scope.configuration') }}
                    </span>
                </label>
                <Switch
                    id="backup-scope-settings"
                    v-model="settings"
                    :aria-label="t('settings.backup.scope.settings')"
                    :disabled="isLoading || available === 'chat_only'"
                />
            </div>
            <div class="flex items-center justify-between gap-4 py-3">
                <label for="backup-scope-data" class="min-w-0">
                    <span class="block text-compact font-medium text-text-primary">
                        {{ t('settings.backup.scope.data') }}
                    </span>
                    <span class="text-caption text-text-secondary">
                        {{ t('settings.backup.scope.history') }}
                    </span>
                </label>
                <Switch
                    id="backup-scope-data"
                    v-model="data"
                    :aria-label="t('settings.backup.scope.data')"
                    :disabled="isLoading || available === 'settings_only'"
                />
            </div>
        </div>
        <p v-if="action === 'import' && settings" class="mb-4 text-caption text-text-secondary">
            {{ t('settings.backup.scope.overwrite') }}
        </p>
        <div class="flex justify-end gap-2">
            <Button variant="outline-neutral" @click="emit('close')">
                {{ t('common.cancel') }}
            </Button>
            <Button
                variant="strong"
                :disabled="isLoading || !scope"
                @click="scope && emit('select', scope)"
            >
                {{ t(action === 'export' ? 'common.export' : 'common.import') }}
            </Button>
        </div>
    </DialogShell>
</template>
