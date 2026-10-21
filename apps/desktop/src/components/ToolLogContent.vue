<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import { Button } from '@components/ui/button';
    import { Tooltip, TooltipTrigger } from '@components/ui/tooltip';
    import { computed, ref } from 'vue';

    import { t } from '@/i18n';
    import { clipboardService } from '@/services/ClipboardService';

    import { parseBashLogInput, parseBashLogOutput } from './toolLogDisplay';

    const props = withDefaults(
        defineProps<{
            input: string;
            output?: string | null;
            error?: string | null;
            isError?: boolean;
            isBash?: boolean;
        }>(),
        { output: null, error: null, isError: false, isBash: false }
    );

    const showRawInput = ref(false);
    const bashInput = computed(() => (props.isBash ? parseBashLogInput(props.input) : null));
    const bashOutput = computed(() =>
        props.isBash && props.output ? parseBashLogOutput(props.output) : null
    );
    const workingDirectory = computed(
        () => bashOutput.value?.workingDirectory || bashInput.value?.workingDirectory || null
    );
    const shell = computed(() => bashOutput.value?.shell || null);
    const exitCode = computed(() => {
        const value = bashOutput.value?.exitCode;
        return value && value !== 'none' ? value : null;
    });

    function formatJson(value: string): string {
        try {
            return JSON.stringify(JSON.parse(value), null, 2);
        } catch {
            return value;
        }
    }

    const formattedInput = computed(() =>
        bashInput.value && !showRawInput.value ? bashInput.value.command : formatJson(props.input)
    );
    const formattedOutput = computed(() =>
        props.output ? formatJson(bashOutput.value?.output ?? props.output) : ''
    );
    const showSeparateError = computed(() =>
        Boolean(props.error && !formattedOutput.value.includes(props.error))
    );

    async function copyText(value: string) {
        try {
            await clipboardService.writeText(value);
        } catch (error) {
            console.error('[ToolLogContent] Failed to copy log content:', error);
        }
    }
</script>

<template>
    <div data-testid="tool-log-content">
        <section v-if="input" class="px-5 py-4" data-testid="tool-log-input-section">
            <div class="mb-2 flex flex-wrap items-center gap-2">
                <span
                    data-testid="tool-log-input-label"
                    class="text-xs font-medium text-neutral-900"
                >
                    {{ t('toolLog.input') }}
                </span>
                <span
                    v-if="shell"
                    class="text-[11px] text-neutral-500"
                    data-no-i18n="true"
                    translate="no"
                >
                    {{ shell }}
                </span>
                <div class="ml-auto flex items-center gap-1">
                    <button
                        v-if="bashInput"
                        type="button"
                        class="rounded-md px-2 py-1 text-[11px] text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900"
                        :aria-pressed="showRawInput"
                        @click="showRawInput = !showRawInput"
                    >
                        {{ showRawInput ? t('toolLog.showCommand') : t('toolLog.rawJson') }}
                    </button>
                    <Tooltip :text="t('toolLog.copyInput')">
                        <TooltipTrigger as-child>
                            <Button
                                variant="ghost-neutral"
                                class="h-7 w-7 rounded-md"
                                :aria-label="t('toolLog.copyInput')"
                                @click="copyText(formattedInput)"
                            >
                                <AppIcon name="copy" class="h-4 w-4" />
                            </Button>
                        </TooltipTrigger>
                    </Tooltip>
                </div>
            </div>
            <div v-if="workingDirectory" class="mb-2 text-[11px] leading-5 text-neutral-500">
                {{ t('toolLog.workingDirectory') }}
                <code
                    class="font-mono break-all text-neutral-700"
                    data-testid="tool-log-working-directory"
                    data-no-i18n="true"
                    translate="no"
                >
                    {{ workingDirectory }}
                </code>
            </div>
            <pre
                data-testid="tool-log-code-block"
                data-no-i18n="true"
                translate="no"
                class="custom-scrollbar-thin max-h-64 overflow-auto rounded-[7px] bg-neutral-100/80 px-3.5 py-3 font-mono text-xs leading-6 break-all whitespace-pre-wrap text-neutral-800 select-text"
                >{{ formattedInput }}</pre
            >
        </section>

        <section
            v-if="output"
            class="border-t border-neutral-200/70 px-5 py-4"
            data-testid="tool-log-output-section"
        >
            <div class="mb-2 flex flex-wrap items-center gap-2">
                <span
                    data-testid="tool-log-output-label"
                    class="text-xs font-medium text-neutral-900"
                >
                    {{ isError ? t('toolLog.error') : t('toolLog.result') }}
                </span>
                <span v-if="exitCode" class="text-[11px] text-neutral-500">
                    {{ t('toolLog.exitCode') }} {{ exitCode }}
                </span>
                <Tooltip :text="t('toolLog.copyOutput')">
                    <TooltipTrigger as-child>
                        <Button
                            variant="ghost-neutral"
                            class="ml-auto h-7 w-7 rounded-md"
                            :aria-label="t('toolLog.copyOutput')"
                            @click="copyText(formattedOutput)"
                        >
                            <AppIcon name="copy" class="h-4 w-4" />
                        </Button>
                    </TooltipTrigger>
                </Tooltip>
            </div>
            <pre
                data-testid="tool-log-code-block"
                data-no-i18n="true"
                translate="no"
                :class="[
                    'custom-scrollbar-thin max-h-64 overflow-auto rounded-[7px] px-3.5 py-3 font-mono text-xs leading-6 break-all whitespace-pre-wrap select-text',
                    isError ? 'bg-red-50 text-red-700' : 'bg-neutral-100/80 text-neutral-800',
                ]"
                >{{ formattedOutput }}</pre
            >
        </section>

        <section v-if="showSeparateError" class="border-t border-neutral-200/70 px-5 py-4">
            <div data-testid="tool-log-error-label" class="mb-2 text-xs font-medium text-red-700">
                {{ t('toolLog.error') }}
            </div>
            <pre
                data-testid="tool-log-code-block"
                data-no-i18n="true"
                translate="no"
                class="custom-scrollbar-thin max-h-64 overflow-auto rounded-[7px] bg-red-50 px-3.5 py-3 font-mono text-xs leading-6 break-all whitespace-pre-wrap text-red-700 select-text"
                >{{ error }}</pre
            >
        </section>
    </div>
</template>
