<!-- Copyright (c) 2026. Qian Cheng. Licensed under GPL v3 -->

<template>
    <iframe
        ref="frameRef"
        class="visual-reply-frame mx-auto block w-full max-w-2xl min-w-0 border-0 bg-transparent"
        :srcdoc="srcdoc"
        sandbox="allow-scripts"
        referrerpolicy="no-referrer"
        :title="title || t('visualReply.frame.title')"
        :style="{ height: `${height}px` }"
        :data-ready="ready"
        data-testid="visual-reply-frame"
    />
    <p
        v-if="error"
        role="alert"
        class="mx-auto mt-1 max-w-2xl text-dense text-text-danger"
        style="overflow-wrap: anywhere"
    >
        {{ t('visualReply.frame.error', { message: error }) }}
    </p>
</template>

<script setup lang="ts">
    import { onBeforeMount, onMounted, onUnmounted, ref, watch } from 'vue';

    import { t } from '@/i18n';
    import {
        isVisualReplyBridgeMessage,
        type VisualReplyBridgeMessage,
    } from '@/services/VisualReplyService/iframe';
    import {
        createVisualReplyThemeSnapshot,
        normalizeVisualReplyThemeSnapshot,
        VISUAL_REPLY_THEME_CHANGE_EVENT,
        type VisualReplyThemeSnapshot,
    } from '@/services/VisualReplyService/theme';

    const props = defineProps<{
        source: string;
        createSrcdoc: (source: string, nonce: string, theme: VisualReplyThemeSnapshot) => string;
        title?: string;
    }>();

    const emit = defineEmits<{
        ready: [];
        error: [message: string];
        resize: [height: number];
        dispose: [];
    }>();

    const frameRef = ref<HTMLIFrameElement | null>(null);
    const height = ref(220);
    const srcdoc = ref('');
    const error = ref('');
    const ready = ref(false);
    let nonce = '';
    let theme: VisualReplyThemeSnapshot = {};

    function loadDocument(createDocument: typeof props.createSrcdoc): void {
        nonce = crypto.randomUUID();
        ready.value = false;
        error.value = '';
        theme = createVisualReplyThemeSnapshot();

        try {
            srcdoc.value = createDocument(props.source, nonce, theme);
        } catch (cause) {
            srcdoc.value = '';
            reportError(cause instanceof Error ? cause.message : String(cause));
        }
    }

    function reportError(message: string): void {
        error.value = message.slice(0, 300);
        emit('error', message.slice(0, 300));
    }

    function handleMessage(event: MessageEvent<unknown>): void {
        if (event.source !== frameRef.value?.contentWindow) return;
        if (!isVisualReplyBridgeMessage(event.data) || event.data.nonce !== nonce) return;

        const message = event.data as VisualReplyBridgeMessage;
        if (message.type === 'ready') {
            if (ready.value) return;
            ready.value = true;
            emit('ready');
            postTheme();
        } else if (message.type === 'resize') {
            const nextHeight = Math.max(120, Math.min(900, Math.ceil(message.value)));
            height.value = nextHeight;
            emit('resize', nextHeight);
        } else if (message.type === 'error') {
            reportError(message.value);
        }
    }

    function postTheme(): void {
        if (!ready.value || !frameRef.value?.contentWindow) return;
        frameRef.value.contentWindow.postMessage(
            { channel: 'touchai-visual-reply', nonce, type: 'theme', value: theme },
            '*'
        );
    }

    function handleThemeChange(): void {
        theme = normalizeVisualReplyThemeSnapshot(createVisualReplyThemeSnapshot());
        postTheme();
    }

    watch(
        () => props.source,
        () => loadDocument(props.createSrcdoc)
    );

    // Build before insertion so the iframe already owns its document when the
    // WebView adopts it; mounting is too late on some embedded WebViews.
    onBeforeMount(() => {
        loadDocument(props.createSrcdoc);
    });

    onMounted(() => {
        window.addEventListener('message', handleMessage);
        window.addEventListener(VISUAL_REPLY_THEME_CHANGE_EVENT, handleThemeChange);
    });

    onUnmounted(() => {
        window.removeEventListener('message', handleMessage);
        window.removeEventListener(VISUAL_REPLY_THEME_CHANGE_EVENT, handleThemeChange);
        emit('dispose');
    });
</script>

<style scoped>
    .visual-reply-frame {
        transition: height var(--duration-fast) var(--ease-smooth-out);
    }
</style>
