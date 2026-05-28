<!--
  - Copyright (c) 2026. Qian Cheng. Licensed under GPL v3
  -->

<template>
    <div
        ref="markdownContainerRef"
        :class="containerClass"
        data-no-i18n="true"
        translate="no"
        @click="handleMarkdownClick"
    >
        <MarkdownRender
            :key="markdownRenderKey"
            :nodes="nodes"
            :final="props.final"
            :is-dark="false"
            :themes="codeBlockThemes"
            :code-block-light-theme="codeBlockLightTheme"
            :code-block-dark-theme="codeBlockDarkTheme"
            :code-block-monaco-options="codeBlockMonacoOptions"
            :max-live-nodes="maxLiveNodes"
            :batch-rendering="true"
            :initial-render-batch-size="24"
            :render-batch-size="16"
            :render-batch-delay="8"
            :render-batch-budget-ms="6"
            :typewriter="isTypewriterEnabled"
            :code-block-props="codeBlockProps"
        />
    </div>
</template>

<script lang="ts">
    import { full as markdownItEmoji } from 'markdown-it-emoji';
    import {
        enableKatex,
        enableMermaid,
        getMarkdown,
        languageMap,
        type MarkdownIt,
        setDefaultI18nMap,
    } from 'markstream-vue';

    const markdownParser = getMarkdown('touchai-markdown', {
        enableContainers: false,
    });
    const markdownItEmojiPlugin = markdownItEmoji as unknown as Parameters<MarkdownIt['use']>[0];

    let isConfigured = false;

    const markstreamZhI18nMap: Record<string, string> = {
        'common.copy': '复制',
        'common.copySuccess': '已复制',
        'common.copied': '已复制',
        'common.decrease': '减小',
        'common.reset': '重置',
        'common.increase': '增大',
        'common.expand': '展开',
        'common.collapse': '收起',
        'common.preview': '预览',
        'common.source': '源码',
        'common.export': '导出',
        'common.open': '打开',
        'common.zoomIn': '放大',
        'common.zoomOut': '缩小',
        'common.resetZoom': '重置缩放',
        'image.loadError': '图片加载失败',
        'image.loading': '图片加载中...',
        'artifacts.htmlPreviewTitle': 'HTML 预览',
        'artifacts.svgPreviewTitle': 'SVG 预览',
    };

    const markstreamEnI18nMap: Record<string, string> = {
        'common.copy': 'Copy',
        'common.copySuccess': 'Copied',
        'common.copied': 'Copied',
        'common.decrease': 'Decrease',
        'common.reset': 'Reset',
        'common.increase': 'Increase',
        'common.expand': 'Expand',
        'common.collapse': 'Collapse',
        'common.preview': 'Preview',
        'common.source': 'Source',
        'common.export': 'Export',
        'common.open': 'Open',
        'common.zoomIn': 'Zoom in',
        'common.zoomOut': 'Zoom out',
        'common.resetZoom': 'Reset zoom',
        'image.loadError': 'Failed to load image',
        'image.loading': 'Loading image...',
        'artifacts.htmlPreviewTitle': 'HTML preview',
        'artifacts.svgPreviewTitle': 'SVG preview',
    };

    function configureMarkstreamLabels(locale: string): void {
        const isEnglish = locale === 'en-US';
        setDefaultI18nMap(
            (isEnglish ? markstreamEnI18nMap : markstreamZhI18nMap) as unknown as Parameters<
                typeof setDefaultI18nMap
            >[0]
        );
        languageMap[''] = isEnglish ? 'Plain text' : '纯文本';
        languageMap.plaintext = isEnglish ? 'Plain text' : '纯文本';
        languageMap.mermaid = isEnglish ? 'Diagram' : '流程图';
    }

    function getTouchAiMarkdownParser(): MarkdownIt {
        if (!isConfigured) {
            markdownParser.use(markdownItEmojiPlugin);

            enableKatex(() => import('katex'));
            enableMermaid(() => import('mermaid'));
            isConfigured = true;
        }

        return markdownParser;
    }
</script>

<script setup lang="ts">
    import { notify } from '@services/NotificationService';
    import MarkdownRender, { type ParsedNode, parseMarkdownToStructure } from 'markstream-vue';
    import { computed, watch } from 'vue';
    import { ref } from 'vue';

    import { getLocale, locale, t } from '@/i18n';
    import { clipboardService } from '@/services/ClipboardService';

    interface Props {
        content: string;
        variant?: 'default' | 'reasoning';
        final?: boolean;
    }

    const props = withDefaults(defineProps<Props>(), {
        variant: 'default',
        final: true,
    });

    const containerClass = computed(() => {
        if (props.variant === 'reasoning') {
            return 'touchai-markdown touchai-markdown--reasoning';
        }
        return 'touchai-markdown touchai-markdown--default select-text';
    });

    const parser = getTouchAiMarkdownParser();
    configureMarkstreamLabels(getLocale());
    watch(locale, (nextLocale) => {
        configureMarkstreamLabels(nextLocale);
    });
    const markdownContainerRef = ref<HTMLElement | null>(null);
    const markdownParseInput = computed(() => ({
        content: props.content,
        final: props.final,
        locale: locale.value,
    }));
    const markdownRenderKey = computed(
        () =>
            `${markdownParseInput.value.locale}:${props.variant}:${markdownParseInput.value.final}`
    );

    const nodes = computed<ParsedNode[]>(() => {
        const input = markdownParseInput.value;
        if (!input.content) {
            return [];
        }

        return parseMarkdownToStructure(input.content, parser, {
            final: input.final,
        });
    });

    const maxLiveNodes = computed(() => {
        if (props.variant === 'reasoning') {
            return 320;
        }
        return 0;
    });

    const isTypewriterEnabled = computed(() => props.variant !== 'reasoning');

    const codeBlockProps = Object.freeze({
        showHeader: true,
        showCopyButton: true,
        showExpandButton: false,
        showPreviewButton: false,
        showFontSizeButtons: false,
    });

    const codeBlockMonacoOptions = Object.freeze({
        glyphMargin: false,
    });

    const codeBlockLightTheme = 'one-light';
    const codeBlockDarkTheme = 'one-dark-pro';
    const codeBlockThemes = [codeBlockLightTheme, codeBlockDarkTheme];

    async function handleMarkdownClick(event: MouseEvent) {
        const target = event.target as HTMLElement | null;
        if (!target) {
            return;
        }

        const codeElement = target.closest('code');
        if (!codeElement) {
            return;
        }

        const container = markdownContainerRef.value;
        if (!container || !container.contains(codeElement)) {
            return;
        }

        if (codeElement.closest('pre') || codeElement.closest('.code-block-container')) {
            return;
        }

        const text = codeElement.textContent?.trim();
        if (!text) {
            return;
        }

        try {
            await clipboardService.writeText(text);
            notify({
                title: 'TouchAI',
                body: t('common.copied'),
            });
        } catch (error) {
            console.error('[MarkdownContent] Failed to copy inline code:', error);
            notify({
                title: 'TouchAI',
                body: t('common.copyFailed'),
            });
        }
    }
</script>
