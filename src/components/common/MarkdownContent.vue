<!--
  - Copyright (c) 2026. Qian Cheng. Licensed under GPL v3
  -->

<template>
    <div :class="containerClass">
        <MarkdownRender
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

    function getTouchAiMarkdownParser(): MarkdownIt {
        if (!isConfigured) {
            setDefaultI18nMap(
                markstreamZhI18nMap as unknown as Parameters<typeof setDefaultI18nMap>[0]
            );
            languageMap[''] = '纯文本';
            languageMap.plaintext = '纯文本';
            languageMap.mermaid = '流程图';

            markdownParser.use(markdownItEmojiPlugin);

            enableKatex(() => import('katex'));
            enableMermaid(() => import('mermaid'));
            isConfigured = true;
        }

        return markdownParser;
    }
</script>

<script setup lang="ts">
    import MarkdownRender, { type ParsedNode, parseMarkdownToStructure } from 'markstream-vue';
    import { computed } from 'vue';

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

    const nodes = computed<ParsedNode[]>(() => {
        if (!props.content) {
            return [];
        }

        return parseMarkdownToStructure(props.content, parser, {
            final: props.final,
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
</script>
