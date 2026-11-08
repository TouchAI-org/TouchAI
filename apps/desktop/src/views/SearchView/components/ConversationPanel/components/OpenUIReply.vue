<!-- Copyright (c) 2026. Qian Cheng. Licensed under GPL v3 -->

<template>
    <div class="openui-reply" data-testid="openui-reply">
        <OpenUIRenderer
            :response="response"
            :library="visualReplyLibrary"
            :is-streaming="isStreaming"
            :on-action="handleAction"
            :on-error="handleError"
        />
        <pre v-if="parseErrors.length" class="openui-reply-error" role="status">{{
            parseErrors.join('\n')
        }}</pre>
    </div>
</template>

<script setup lang="ts">
    import {
        type ActionEvent,
        BuiltinActionType,
        type OpenUIError,
        Renderer as OpenUIRenderer,
    } from '@openuidev/vue-lang';
    import { ref, watch } from 'vue';

    import {
        dispatchVisualReplyLink,
        dispatchVisualReplyPrompt,
    } from '@/services/VisualReplyService/bridge';
    import { visualReplyLibrary, visualReplyParser } from '@/services/VisualReplyService/library';

    const props = defineProps<{ response: string; isStreaming: boolean }>();
    const parseErrors = ref<string[]>([]);

    watch(
        () => props.response,
        (response) => {
            parseErrors.value = [];
            if (props.isStreaming) return;
            const result = visualReplyParser.parse(response);
            if (result.meta.errors.length > 0) {
                parseErrors.value = result.meta.errors.map((error) => error.message);
            }
        },
        { immediate: true, flush: 'sync' }
    );

    async function handleAction(event: ActionEvent): Promise<void> {
        if (event.type === BuiltinActionType.ContinueConversation) {
            dispatchVisualReplyPrompt(event.humanFriendlyMessage);
            return;
        }

        if (event.type === BuiltinActionType.OpenUrl) {
            dispatchVisualReplyLink(event.params.url);
            return;
        }
    }

    function handleError(errors: OpenUIError[]): void {
        parseErrors.value = errors.map((error) => error.message);
    }
</script>

<style scoped>
    .openui-reply {
        min-width: 0;
        max-width: 100%;
        overflow-wrap: anywhere;
    }

    .openui-reply-error {
        margin: 0.5rem 0 0;
        color: var(--color-error-800);
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        font: 0.75rem/1.4 var(--font-mono);
    }
</style>
