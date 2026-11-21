<script setup lang="ts">
    import AppIcon from '@components/AppIcon.vue';
    import { Button } from '@components/ui/button';
    import { CodeBlockNode, type CodeBlockNodeProps } from 'markstream-vue';
    import { onUnmounted, ref } from 'vue';

    import { useProductAnalyticsApi } from '@/app/api/analytics/product';
    import { log } from '@/app/api/diagnostics';
    import type { PrivacyReviewAnnotation } from '@/app/api/privacy';
    import { writeClipboardText } from '@/app/api/windows/clipboard';
    import { notify } from '@/app/api/windows/notifications';
    import { t } from '@/i18n';

    import MarkdownPrivacyCode from './MarkdownPrivacyCode.vue';
    const { runResultAction } = useProductAnalyticsApi();

    defineOptions({ inheritAttrs: false });
    const props = withDefaults(
        defineProps<{
            node: CodeBlockNodeProps['node'] & { privacyAnnotations?: PrivacyReviewAnnotation[] };
            showHeader?: boolean;
            showCopyButton?: boolean;
        }>(),
        { showHeader: true, showCopyButton: true }
    );
    const copied = ref(false);
    let copyTimer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;

    async function copyCode() {
        try {
            await runResultAction('copy_code', () => writeClipboardText(props.node.code));
            if (disposed) return;
            copied.value = true;
            clearTimeout(copyTimer);
            copyTimer = setTimeout(() => {
                copied.value = false;
            }, 1000);
            notify({ title: 'TouchAI', body: t('common.copied') });
        } catch (error) {
            log.error('[MarkdownCodeBlock] Failed to copy code:', error);
            if (!disposed) notify({ title: 'TouchAI', body: t('common.copyFailed') });
        }
    }

    onUnmounted(() => {
        disposed = true;
        clearTimeout(copyTimer);
    });
</script>

<template>
    <div class="relative">
        <!-- Reserve copy space while retaining markstream's renderer and header controls. -->
        <MarkdownPrivacyCode
            v-if="node.privacyAnnotations?.length"
            :node="{ ...node, privacyAnnotations: node.privacyAnnotations }"
            :show-header="showHeader"
        />
        <CodeBlockNode
            v-else
            v-bind="$attrs"
            class="[&_.code-block-header]:pr-12"
            :node="node"
            :show-header="showHeader"
            :show-copy-button="false"
        />
        <Button
            v-if="showHeader && showCopyButton"
            variant="ghost-neutral"
            class="absolute top-1.5 right-2"
            :aria-label="copied ? t('common.copied') : t('common.copy')"
            @click="copyCode"
        >
            <AppIcon :name="copied ? 'check-circle' : 'copy'" class="h-4 w-4" />
        </Button>
        <span class="sr-only" role="status" aria-live="polite">
            {{ copied ? t('common.copied') : '' }}
        </span>
    </div>
</template>
