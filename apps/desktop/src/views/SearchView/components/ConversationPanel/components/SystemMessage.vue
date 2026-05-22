<!-- Copyright (c) 2026. 千诚. Licensed under GPL v3 -->

<template>
    <div class="mb-4 flex justify-center">
        <div
            class="system-message max-w-full"
            :class="{
                'system-message--completed': reminderKind === 'completed',
                'system-message--failed': reminderKind === 'failed',
                'system-message--waiting': reminderKind === 'waiting_approval',
            }"
        >
            <AppIcon :name="iconName" class="system-message__icon" />
            <span class="system-message__content">{{ message.content }}</span>
        </div>
    </div>
</template>

<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import { computed } from 'vue';

    import type { SessionMessage } from '@/types/session';
    import { getSessionStatusReminderKindFromContent } from '@/utils/session';

    interface Props {
        message: SessionMessage;
    }

    const props = defineProps<Props>();

    const reminderKind = computed(() =>
        getSessionStatusReminderKindFromContent(props.message.content)
    );

    const iconName = computed(() => {
        if (reminderKind.value === 'completed') {
            return 'check-circle';
        }

        if (reminderKind.value === 'failed') {
            return 'x-circle';
        }

        return 'exclamation-triangle';
    });
</script>

<style scoped>
    .system-message {
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
        border-radius: 999px;
        border: 1px solid rgb(214, 211, 209);
        background: rgb(250, 250, 249);
        padding: 0.55rem 0.9rem;
        color: rgb(87, 83, 78);
        box-shadow: 0 8px 24px rgba(28, 25, 23, 0.06);
    }

    .system-message--completed {
        border-color: rgb(134, 239, 172);
        background: rgb(240, 253, 244);
        color: rgb(21, 128, 61);
    }

    .system-message--failed {
        border-color: rgb(254, 202, 202);
        background: rgb(254, 242, 242);
        color: rgb(185, 28, 28);
    }

    .system-message--waiting {
        border-color: rgb(253, 224, 71);
        background: rgb(254, 249, 195);
        color: rgb(161, 98, 7);
    }

    .system-message__icon {
        flex: none;
        height: 0.95rem;
        width: 0.95rem;
    }

    .system-message__content {
        min-width: 0;
        font-family: Georgia, 'Times New Roman', serif;
        font-size: 13px;
        line-height: 1.5;
        text-align: center;
        word-break: break-word;
    }
</style>
