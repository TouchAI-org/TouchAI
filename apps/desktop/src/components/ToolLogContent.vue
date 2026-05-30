<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<template>
    <div class="space-y-3">
        <div v-if="input">
            <div
                data-testid="tool-log-input-label"
                class="mb-1.5 font-serif text-[11px] font-normal text-neutral-500"
            >
                {{ t('toolLog.input') }}
            </div>
            <pre
                data-testid="tool-log-code-block"
                data-no-i18n="true"
                translate="no"
                class="custom-scrollbar-thin mt-1 max-h-40 overflow-auto rounded-[8px] border border-neutral-200/70 bg-[#f7f5f2] p-2.5 font-mono text-[11px] leading-5 text-neutral-700 shadow-none"
                >{{ formattedInput }}</pre
            >
        </div>

        <div v-if="output">
            <div
                data-testid="tool-log-output-label"
                class="mb-1.5 font-serif text-[11px] font-normal text-neutral-500"
            >
                {{ isError ? t('toolLog.error') : t('toolLog.result') }}
            </div>
            <pre
                data-testid="tool-log-code-block"
                data-no-i18n="true"
                translate="no"
                :class="[
                    'custom-scrollbar-thin mt-1 max-h-40 overflow-auto rounded-[8px] border border-neutral-200/70 p-2.5 font-mono text-[11px] leading-5 shadow-none',
                    isError ? 'bg-red-50 text-red-700' : 'bg-[#f7f5f2] text-neutral-700',
                ]"
                >{{ formattedOutput }}</pre
            >
        </div>

        <div v-if="error && !isError">
            <div
                data-testid="tool-log-error-label"
                class="mb-1.5 font-serif text-[11px] font-normal text-red-600"
            >
                {{ t('toolLog.error') }}
            </div>
            <pre
                data-testid="tool-log-code-block"
                data-no-i18n="true"
                translate="no"
                class="custom-scrollbar-thin mt-1 max-h-40 overflow-auto rounded-[8px] border border-red-200/70 bg-red-50 p-2.5 font-mono text-[11px] leading-5 text-red-700 shadow-none"
                >{{ error }}</pre
            >
        </div>
    </div>
</template>

<script setup lang="ts">
    import { computed } from 'vue';

    import { t } from '@/i18n';

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
