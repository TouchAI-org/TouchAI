<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<template>
    <div class="space-y-3">
        <!-- 输入参数 -->
        <div v-if="input">
            <div class="mb-2 font-serif text-xs text-gray-600">输入参数</div>
            <pre
                class="custom-scrollbar-thin bg-primary-50 text-primary-600 mt-1 max-h-40 overflow-auto rounded border border-gray-200 p-2 font-mono text-xs"
                >{{ formattedInput }}</pre
            >
        </div>

        <!-- 结果/输出 -->
        <div v-if="output">
            <div class="mb-2 font-serif text-xs text-gray-600">
                {{ isError ? '错误' : '结果' }}
            </div>
            <pre
                :class="[
                    'custom-scrollbar-thin text-primary-600 mt-1 max-h-40 overflow-auto rounded border border-gray-200 p-2 font-mono text-xs',
                    isError ? 'bg-red-50' : 'bg-primary-50',
                ]"
                >{{ formattedOutput }}</pre
            >
        </div>

        <!-- 独立错误信息（当 output 不是错误时显示） -->
        <div v-if="error && !isError">
            <div class="mb-2 font-serif text-xs text-red-600">错误</div>
            <pre
                class="custom-scrollbar-thin mt-1 max-h-40 overflow-auto rounded border border-gray-200 bg-red-50 p-2 font-mono text-xs text-red-600"
                >{{ error }}</pre
            >
        </div>
    </div>
</template>

<script setup lang="ts">
    import { computed } from 'vue';

    interface Props {
        input: string;
        output?: string | null;
        error?: string | null;
        isError?: boolean;
    }

    const props = withDefaults(defineProps<Props>(), {
        output: null,
        error: null,
        isError: false,
    });

    const formatJson = (str: string) => {
        try {
            const parsed = JSON.parse(str);
            return JSON.stringify(parsed, null, 2);
        } catch {
            return str;
        }
    };

    const formattedInput = computed(() => formatJson(props.input));
    const formattedOutput = computed(() => (props.output ? formatJson(props.output) : ''));
</script>

<style scoped>
    pre {
        font-family: 'JetBrains Mono', 'Fira Code', 'Consolas', 'Monaco', monospace;
        white-space: pre-wrap;
        word-wrap: break-word;
    }
</style>
