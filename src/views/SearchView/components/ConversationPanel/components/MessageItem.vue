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
    import type { ConversationMessage } from '@composables/useAgent.ts';

    import AssistantMessage from './AssistantMessage.vue';
    import UserMessage from './UserMessage.vue';

    interface Props {
        message: ConversationMessage;
        previousMessage?: ConversationMessage;
    }

    defineProps<Props>();

    const emit = defineEmits<{
        regenerate: [messageId: string];
    }>();
</script>
