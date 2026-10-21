<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import { Input } from '@components/ui/input';

    import { t } from '@/i18n';

    import KeyValueRows from './KeyValueRows.vue';
    interface Props {
        url: string;
        headers: { key: string; value: string }[];
    }

    interface Emits {
        (e: 'update:url', value: string): void;
        (e: 'update:headers', value: { key: string; value: string }[]): void;
        (e: 'blur'): void;
    }

    const props = defineProps<Props>();
    const emit = defineEmits<Emits>();

    const updateHeaders = (next: { key: string; value: string }[]) => {
        emit('update:headers', next);
    };
</script>

<template>
    <div class="space-y-4">
        <div>
            <label class="block text-sm font-medium text-neutral-700">
                URL
                <span class="text-red-500">*</span>
            </label>
            <Input
                variant="filled"
                :model-value="url"
                type="text"
                class="mt-1.5 w-full font-mono"
                :placeholder="t('settings.mcp.config.urlPlaceholder')"
                @input="emit('update:url', ($event.target as HTMLInputElement).value)"
                @blur="emit('blur')"
            />
        </div>

        <KeyValueRows
            :rows="props.headers"
            :title="t('settings.mcp.config.headers')"
            :key-placeholder="t('settings.mcp.config.headerNamePlaceholder')"
            :value-placeholder="t('settings.mcp.config.headerValuePlaceholder')"
            @update:rows="updateHeaders"
            @blur="emit('blur')"
        />
    </div>
</template>
