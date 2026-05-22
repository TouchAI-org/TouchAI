<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';

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
            <label class="block font-serif text-sm font-medium text-gray-600">
                URL
                <span class="text-red-500">*</span>
            </label>
            <input
                :value="url"
                type="text"
                class="focus:border-primary-400 mt-1.5 w-full rounded-lg border border-gray-200 px-3 py-2 font-mono text-sm text-gray-900 transition-colors focus:outline-none"
                placeholder="例如: https://example.com/mcp"
                @input="emit('update:url', ($event.target as HTMLInputElement).value)"
                @blur="emit('blur')"
            />
        </div>

        <div>
            <div class="flex items-center justify-between">
                <label class="block font-serif text-sm font-medium text-gray-600">请求头</label>
                <button
                    class="text-gray-400 transition-colors hover:text-gray-600"
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
                        class="focus:border-primary-400 w-1/3 rounded-lg border border-gray-200 px-4 py-2.5 font-mono text-sm text-gray-900 transition-colors focus:outline-none"
                        placeholder="请求头名称"
                        @input="updateHeaderKey(index, ($event.target as HTMLInputElement).value)"
                        @blur="emit('blur')"
                    />
                    <input
                        :value="header.value"
                        type="text"
                        class="focus:border-primary-400 flex-1 rounded-lg border border-gray-200 px-4 py-2.5 font-mono text-sm text-gray-900 transition-colors focus:outline-none"
                        placeholder="请求头值"
                        @input="updateHeaderValue(index, ($event.target as HTMLInputElement).value)"
                        @blur="emit('blur')"
                    />
                    <button
                        class="text-gray-400 transition-colors hover:text-red-600"
                        @click="removeHeader(index)"
                    >
                        <AppIcon name="x" class="h-5 w-5" />
                    </button>
                </div>
            </div>
        </div>
    </div>
</template>
