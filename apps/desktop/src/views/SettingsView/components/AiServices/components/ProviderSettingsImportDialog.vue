<script setup lang="ts">
    import DialogShell from '@components/DialogShell.vue';
    import { Button } from '@components/ui/button';
    import { DialogDescription, DialogTitle } from '@components/ui/dialog';
    import { Switch } from '@components/ui/switch';
    import { computed, ref, watch } from 'vue';

    import { getProviderDriverDefinition } from '@/app/api/models/catalog';
    import type {
        ProviderImportSourceId,
        ProviderSettingsImportScan,
    } from '@/app/api/models/providerSettingsImport';
    import { t } from '@/i18n';

    const props = defineProps<{
        open: boolean;
        sources: ProviderSettingsImportScan | null;
        scanning: boolean;
        saving: boolean;
        error: string | null;
    }>();
    const emit = defineEmits<{
        'update:open': [open: boolean];
        import: [sources: ProviderImportSourceId[]];
        retry: [];
        closed: [];
    }>();

    const sourceIds: ProviderImportSourceId[] = ['claudeCode', 'codex'];
    const selected = ref({ claudeCode: false, codex: false });
    watch(
        () => props.sources,
        (sources) => {
            for (const id of sourceIds) selected.value[id] = !!sources?.[id].candidate;
        },
        { immediate: true }
    );
    const selectedIds = computed(() =>
        sourceIds.filter((id) => selected.value[id] && props.sources?.[id].candidate)
    );

    function confirm() {
        if (!props.scanning && !props.saving && selectedIds.value.length > 0) {
            emit('import', selectedIds.value);
        }
    }
</script>

<template>
    <DialogShell
        :open="open"
        :dismissible="!saving"
        max-width-class="max-w-lg"
        @close="emit('update:open', false)"
        @closed="emit('closed')"
    >
        <DialogTitle>{{ t('settings.ai.import.title') }}</DialogTitle>
        <DialogDescription class="mt-2">
            {{ t('settings.ai.import.description') }}
        </DialogDescription>

        <p v-if="scanning" role="status" class="my-6 text-sm text-text-secondary">
            {{ t('settings.ai.import.scanning') }}
        </p>
        <div v-else-if="sources" class="my-5 space-y-4">
            <section
                v-for="id in sourceIds"
                :key="id"
                class="space-y-3 rounded-lg border border-border p-4"
            >
                <div class="flex items-center justify-between gap-3">
                    <h3 :id="`provider-import-${id}`" class="text-sm font-medium text-text-primary">
                        {{ t(`settings.ai.import.source.${id}`) }}
                    </h3>
                    <Switch
                        v-if="sources[id].candidate"
                        v-model="selected[id]"
                        :aria-labelledby="`provider-import-${id}`"
                        :disabled="saving"
                        :data-testid="`provider-import-select-${id}`"
                    />
                </div>
                <p class="text-sm text-text-secondary">
                    {{ t(`settings.ai.import.status.${sources[id].status}`) }}
                </p>
                <dl v-if="sources[id].candidate" class="space-y-2 text-sm">
                    <div>
                        <dt class="text-text-secondary">{{ t('settings.ai.providerName') }}</dt>
                        <dd class="break-all text-text-primary">
                            {{ sources[id].candidate.providerName }}
                        </dd>
                    </div>
                    <div>
                        <dt class="text-text-secondary">{{ t('common.type') }}</dt>
                        <dd class="text-text-primary">
                            {{ getProviderDriverDefinition(sources[id].candidate.driver).label }}
                        </dd>
                    </div>
                    <div>
                        <dt class="text-text-secondary">{{ t('settings.ai.apiEndpoint') }}</dt>
                        <dd class="font-mono break-all text-text-primary">
                            {{ sources[id].candidate.apiEndpoint }}
                        </dd>
                    </div>
                    <div>
                        <dt class="text-text-secondary">{{ t('settings.ai.modelId') }}</dt>
                        <dd class="break-all text-text-primary">
                            {{ sources[id].candidate.modelId || t('settings.ai.import.manual') }}
                        </dd>
                    </div>
                    <div>
                        <dt class="text-text-secondary">{{ t('settings.ai.apiKey') }}</dt>
                        <dd data-testid="provider-import-api-key" class="text-text-primary">
                            {{
                                sources[id].candidate.apiKey
                                    ? '••••••••'
                                    : t('settings.ai.import.manual')
                            }}
                        </dd>
                    </div>
                </dl>
            </section>
        </div>
        <p v-if="error" role="alert" class="my-4 text-sm text-text-danger">{{ error }}</p>
        <div class="mt-5 flex flex-wrap justify-end gap-3">
            <Button
                v-if="!scanning && !saving && (sources || error)"
                variant="outline-neutral"
                data-testid="provider-import-retry"
                @click="emit('retry')"
            >
                {{ t('common.retry') }}
            </Button>
            <Button
                variant="outline-neutral"
                data-testid="provider-import-cancel"
                :disabled="saving"
                @click="emit('update:open', false)"
            >
                {{ t('settings.ai.import.skip') }}
            </Button>
            <Button
                variant="strong"
                data-testid="provider-import-confirm"
                :disabled="scanning || saving || selectedIds.length === 0"
                @click="confirm"
            >
                {{ t('settings.ai.import.confirm') }}
            </Button>
        </div>
    </DialogShell>
</template>
