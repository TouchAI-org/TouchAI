<!-- Copyright (c) 2026. Qian Cheng. Licensed under GPL v3 -->

<template>
    <UserMessage
        v-if="message.role === 'user'"
        :message="message"
        :editing="editing"
        :actions-disabled="actionsDisabled"
        @send-now="emit('pendingAction', 'sendNow', $event)"
        @edit="emit('pendingAction', 'edit', $event)"
        @remove="emit('pendingAction', 'remove', $event)"
        @cancel-edit="emit('pendingAction', 'cancelEdit', $event)"
    />
    <AssistantMessage
        v-else
        :message="message"
        @regenerate="(messageId: string) => emit('regenerate', messageId)"
    />
</template>

<script setup lang="ts">
    import type { SessionMessage } from '@/types/session';

    import AssistantMessage from './AssistantMessage.vue';
    import UserMessage from './UserMessage.vue';

    interface Props {
        message: SessionMessage;
        editing?: boolean;
        actionsDisabled?: boolean;
    }

    defineProps<Props>();

    const emit = defineEmits<{
        regenerate: [messageId: string];
        pendingAction: [action: 'sendNow' | 'edit' | 'remove' | 'cancelEdit', messageId: string];
    }>();
</script>
