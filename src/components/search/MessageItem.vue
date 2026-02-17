<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<template>
    <UserMessage v-if="message.role === 'user'" :message="message" />
    <AssistantMessage
        v-else
        :message="message"
        @regenerate="(messageId: string) => emit('regenerate', messageId)"
    />
</template>

<script setup lang="ts">
    import AssistantMessage from '@components/search/AssistantMessage.vue';
    import UserMessage from '@components/search/UserMessage.vue';
    import type { ConversationMessage } from '@composables/useAgent.ts';

    interface Props {
        message: ConversationMessage;
        previousMessage?: ConversationMessage;
    }

    defineProps<Props>();

    const emit = defineEmits<{
        regenerate: [messageId: string];
    }>();
</script>
