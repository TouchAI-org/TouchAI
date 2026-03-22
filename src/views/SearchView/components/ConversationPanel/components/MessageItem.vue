<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<template>
    <UserMessage v-if="message.role === 'user'" :message="message" />
    <AssistantMessage
        v-else
        :message="message"
        :approval-attention-token="approvalAttentionToken"
        @regenerate="(messageId: string) => emit('regenerate', messageId)"
        @approve-tool-approval="(callId: string) => emit('approveToolApproval', callId)"
        @reject-tool-approval="(callId: string) => emit('rejectToolApproval', callId)"
    />
</template>

<script setup lang="ts">
    import type { ConversationMessage } from '@/types/conversation';

    import AssistantMessage from './AssistantMessage.vue';
    import UserMessage from './UserMessage.vue';

    interface Props {
        message: ConversationMessage;
        approvalAttentionToken?: number;
    }

    withDefaults(defineProps<Props>(), {
        approvalAttentionToken: 0,
    });

    const emit = defineEmits<{
        regenerate: [messageId: string];
        approveToolApproval: [callId: string];
        rejectToolApproval: [callId: string];
    }>();
</script>
