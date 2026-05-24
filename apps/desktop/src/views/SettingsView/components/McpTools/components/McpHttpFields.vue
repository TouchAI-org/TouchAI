<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';


    import { t } from '@/i18n';
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

    const addHeader = () => {
        emit('update:headers', [...props.headers, { key: '', value: '' }]);
    };

    const removeHeader = (index: number) => {
        const newHeaders = [...props.headers];
        newHeaders.splice(index, 1);
        emit('update:headers', newHeaders);
        emit('blur');
    };

    const updateHeaderKey = (index: number, key: string) => {
        const newHeaders = [...props.headers];
        newHeaders[index] = { ...newHeaders[index]!, key, value: newHeaders[index]!.value };
        emit('update:headers', newHeaders);
    };

    const updateHeaderValue = (index: number, value: string) => {
        const newHeaders = [...props.headers];
        newHeaders[index] = { ...newHeaders[index]!, key: newHeaders[index]!.key, value };
        emit('update:headers', newHeaders);
    };
</script>

<template>
    <div class="space-y-4">
        <div>
            <label class="block text-sm font-medium text-neutral-700">
                URL
                <span class="text-red-500">*</span>
            </label>
            <input
                :value="url"
                type="text"
                class="settings-input mt-1.5 w-full font-mono"
                :placeholder="t('settings.mcp.config.urlPlaceholder')"
                @input="emit('update:url', ($event.target as HTMLInputElement).value)"
                @blur="emit('blur')"
            />
        </div>

        <div>
            <div class="flex items-center justify-between">
                <label class="block text-sm font-medium text-neutral-700">{{ t('settings.mcp.config.headers') }}</label>
                <button
                    class="text-neutral-400 transition-colors hover:text-neutral-700"
                    @click="addHeader"
                >
                    <AppIcon name="plus" class="h-5 w-5" />
                </button>
            </div>
            <div v-if="headers.length > 0" class="mt-2 space-y-2">
                <div v-for="(header, index) in headers" :key="index" class="flex gap-2">
                    <input
                        :value="header.key"
                        type="text"
                        class="settings-input w-1/3 px-4 py-2.5 font-mono"
                        :placeholder="t('settings.mcp.config.headerNamePlaceholder')"
                        @input="updateHeaderKey(index, ($event.target as HTMLInputElement).value)"
                        @blur="emit('blur')"
                    />
                    <input
                        :value="header.value"
                        type="text"
                        class="settings-input flex-1 px-4 py-2.5 font-mono"
                        :placeholder="t('settings.mcp.config.headerValuePlaceholder')"
                        @input="updateHeaderValue(index, ($event.target as HTMLInputElement).value)"
                        @blur="emit('blur')"
                    />
                    <button
                        class="text-neutral-400 transition-colors hover:text-red-600"
                        @click="removeHeader(index)"
                    >
                        <AppIcon name="x" class="h-5 w-5" />
                    </button>
                </div>
            </div>
        </div>
    </div>
</template>
