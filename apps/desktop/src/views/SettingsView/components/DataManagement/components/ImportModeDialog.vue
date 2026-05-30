<script setup lang="ts">
    import DialogShell from '@components/DialogShell.vue';
    import { Button } from '@components/ui/button';
    import { type ImportMode } from '@database/backup';

    import { t } from '@/i18n';
    defineProps<{
        isLoading: boolean;
    }>();

    const emit = defineEmits<{
        (e: 'select', mode: ImportMode): void;
        (e: 'close'): void;
    }>();
</script>

<template>
    <DialogShell dismissible @close="emit('close')">
        <h3 class="text-[15px] font-medium text-neutral-950">
            {{ t('settings.dataManagement.importMode.title') }}
        </h3>
        <p class="mt-2 text-sm text-neutral-600">
            {{ t('settings.dataManagement.importMode.description') }}
        </p>

        <div class="mt-4 space-y-3">
            <Button
                variant="outline"
                class="h-auto w-full rounded-lg border border-neutral-200 px-4 py-3 text-left break-words whitespace-normal transition-colors hover:border-neutral-300 hover:bg-neutral-50"
                :disabled="isLoading"
                @click="emit('select', 'chat_only')"
            >
                <div>
                    <div class="text-sm font-medium text-neutral-950">
                        {{ t('settings.dataManagement.importMode.chatOnly.title') }}
                    </div>
                    <div class="mt-1 text-xs text-neutral-500">
                        {{ t('settings.dataManagement.importMode.chatOnly.description') }}
                    </div>
                </div>
            </Button>

            <Button
                variant="outline"
                class="h-auto w-full rounded-lg border border-red-200 px-4 py-3 text-left break-words whitespace-normal transition-colors hover:border-red-300 hover:bg-red-50"
                :disabled="isLoading"
                @click="emit('select', 'full')"
            >
                <div>
                    <div class="text-sm font-medium text-neutral-950">
                        {{ t('settings.dataManagement.importMode.full.title') }}
                    </div>
                    <div class="mt-1 text-xs text-neutral-500">
                        {{ t('settings.dataManagement.importMode.full.description') }}
                    </div>
                </div>
            </Button>
        </div>

        <div class="mt-6">
            <Button
                variant="outline"
                class="w-full rounded-lg border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-600 transition-colors hover:border-neutral-300 hover:bg-neutral-50"
                :disabled="isLoading"
                @click="emit('close')"
            >
                {{ t('common.cancel') }}
            </Button>
        </div>
    </DialogShell>
</template>
