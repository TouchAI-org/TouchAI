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
        @copy="handleMarkdownCopy"
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
        markdownItOptions: {
            breaks: true,
        },
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
    const SHELL_VARIABLE_PATTERN =
        /^\$(?:\{(?:env:)?[A-Za-z_][A-Za-z0-9_]*\}|env:[A-Za-z_][A-Za-z0-9_]*|[A-Za-z_][A-Za-z0-9_]*)/;

    function startsInlineMathSpan(content: string, index: number): boolean {
        for (let cursor = index + 1; cursor < content.length; cursor += 1) {
            const char = content[cursor];
            if (char === '\n') {
                return false;
            }
            if (char === '\\') {
                cursor += 1;
                continue;
            }
            if (char === '$') {
                const firstContentChar = content[index + 1];
                const lastContentChar = content[cursor - 1];
                return (
                    cursor > index + 1 &&
                    firstContentChar !== undefined &&
                    lastContentChar !== undefined &&
                    !/\s/.test(firstContentChar) &&
                    !/\s/.test(lastContentChar)
                );
            }
        }

        return false;
    }

    function shouldEscapeShellVariable(content: string, index: number): boolean {
        if (startsInlineMathSpan(content, index)) {
            return false;
        }

        const match = content.slice(index).match(SHELL_VARIABLE_PATTERN);
        return match !== null;
    }

    function escapeShellVariablesOutsideCode(content: string): string {
        let result = '';
        let index = 0;
        let inFence = false;
        let inInlineCode = false;

        while (index < content.length) {
            if (!inInlineCode && content.startsWith('```', index)) {
                inFence = !inFence;
                result += '```';
                index += 3;
                continue;
            }

            const char = content[index];
            if (!inFence && char === '`') {
                inInlineCode = !inInlineCode;
                result += char;
                index += 1;
                continue;
            }

            if (
                !inFence &&
                !inInlineCode &&
                char === '$' &&
                shouldEscapeShellVariable(content, index)
            ) {
                result += String.raw`\$`;
                index += 1;
                continue;
            }

            result += char;
            index += 1;
        }

        return result;
    }

    const markdownParseInput = computed(() => ({
        content: escapeShellVariablesOutsideCode(props.content),
        final: props.final,
        locale: locale.value,
    }));
    const markdownRenderKey = computed(() => `${markdownParseInput.value.locale}:${props.variant}`);

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

    const codeBlockMonacoOptions = computed(() => ({
        glyphMargin: false,
        autoScrollInitial: !props.final,
    }));

    const codeBlockLightTheme = 'one-light';
    const codeBlockDarkTheme = 'one-dark-pro';
    const codeBlockThemes = [codeBlockLightTheme, codeBlockDarkTheme];
    const clipboardBlockTags = new Set([
        'address',
        'article',
        'aside',
        'blockquote',
        'dd',
        'div',
        'dl',
        'dt',
        'figcaption',
        'figure',
        'footer',
        'h1',
        'h2',
        'h3',
        'h4',
        'h5',
        'h6',
        'header',
        'hr',
        'li',
        'main',
        'nav',
        'ol',
        'p',
        'pre',
        'section',
        'ul',
    ]);

    function escapeClipboardHtml(value: string): string {
        return value
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function normalizeClipboardCellText(cell: HTMLTableCellElement): string {
        return (cell.textContent ?? '').replace(/\s+/g, ' ').trim();
    }

    function serializeTableSectionForClipboard(
        section: HTMLTableSectionElement | null,
        sectionTag: 'thead' | 'tbody' | 'tfoot'
    ): { html: string; textRows: string[] } {
        if (!section) {
            return { html: '', textRows: [] };
        }

        let html = `<${sectionTag}>`;
        const textRows: string[] = [];

        for (const row of Array.from(section.rows)) {
            html += '<tr>';
            const textCells: string[] = [];

            for (const cell of Array.from(row.cells)) {
                const tag = cell.tagName.toLowerCase() === 'th' ? 'th' : 'td';
                const text = normalizeClipboardCellText(cell);
                const colspan = cell.colSpan > 1 ? ` colspan="${cell.colSpan}"` : '';
                const rowspan = cell.rowSpan > 1 ? ` rowspan="${cell.rowSpan}"` : '';

                html += `<${tag}${colspan}${rowspan}>${escapeClipboardHtml(text)}</${tag}>`;
                textCells.push(text);
            }

            html += '</tr>';
            textRows.push(textCells.join('\t'));
        }

        html += `</${sectionTag}>`;
        return { html, textRows };
    }

    function serializeLooseTableRowsForClipboard(table: HTMLTableElement) {
        const sectionRows = new Set<HTMLTableRowElement>([
            ...Array.from(table.tHead?.rows ?? []),
            ...Array.from(table.tBodies).flatMap((section) => Array.from(section.rows)),
            ...Array.from(table.tFoot?.rows ?? []),
        ]);
        const looseRows = Array.from(table.rows).filter((row) => !sectionRows.has(row));

        if (!looseRows.length) {
            return { html: '', textRows: [] };
        }

        let html = '<tbody>';
        const textRows: string[] = [];

        for (const row of looseRows) {
            html += '<tr>';
            const textCells: string[] = [];

            for (const cell of Array.from(row.cells)) {
                const tag = cell.tagName.toLowerCase() === 'th' ? 'th' : 'td';
                const text = normalizeClipboardCellText(cell);
                const colspan = cell.colSpan > 1 ? ` colspan="${cell.colSpan}"` : '';
                const rowspan = cell.rowSpan > 1 ? ` rowspan="${cell.rowSpan}"` : '';

                html += `<${tag}${colspan}${rowspan}>${escapeClipboardHtml(text)}</${tag}>`;
                textCells.push(text);
            }

            html += '</tr>';
            textRows.push(textCells.join('\t'));
        }

        html += '</tbody>';
        return { html, textRows };
    }

    function serializeTableForClipboard(table: HTMLTableElement): { html: string; text: string } {
        const sections = [
            serializeTableSectionForClipboard(table.tHead, 'thead'),
            ...Array.from(table.tBodies).map((section) =>
                serializeTableSectionForClipboard(section, 'tbody')
            ),
            serializeLooseTableRowsForClipboard(table),
            serializeTableSectionForClipboard(table.tFoot, 'tfoot'),
        ];

        return {
            html: `<table>${sections.map((section) => section.html).join('')}</table>`,
            text: sections
                .flatMap((section) => section.textRows)
                .filter(Boolean)
                .join('\n'),
        };
    }

    function cloneSelectedMarkdownContents(): HTMLDivElement | null {
        const container = markdownContainerRef.value;
        const selection = window.getSelection();
        if (!container || !selection || selection.rangeCount === 0 || selection.isCollapsed) {
            return null;
        }

        const wrapper = document.createElement('div');
        for (let index = 0; index < selection.rangeCount; index += 1) {
            const range = selection.getRangeAt(index);
            if (!range.intersectsNode(container)) {
                continue;
            }

            wrapper.append(range.cloneContents());
        }

        return wrapper.hasChildNodes() ? wrapper : null;
    }

    function replaceRenderedTablesWithSemanticTables(root: HTMLElement) {
        for (const table of Array.from(root.querySelectorAll<HTMLTableElement>('table'))) {
            const template = document.createElement('template');
            template.innerHTML = serializeTableForClipboard(table).html;
            const semanticTable = template.content.firstElementChild;

            if (semanticTable instanceof HTMLTableElement) {
                table.replaceWith(semanticTable);
            }
        }
    }

    function normalizeClipboardPlainText(value: string): string {
        return value
            .replace(/\u00a0/g, ' ')
            .replace(/[ \t]+\n/g, '\n')
            .replace(/\n[ \t]+/g, '\n')
            .replace(/\n{2,}/g, '\n')
            .trim();
    }

    function serializeNodePlainTextForClipboard(node: Node): string {
        if (node.nodeType === Node.TEXT_NODE) {
            return node.textContent ?? '';
        }

        if (!(node instanceof HTMLElement)) {
            return Array.from(node.childNodes).map(serializeNodePlainTextForClipboard).join('');
        }

        const tagName = node.tagName.toLowerCase();
        if (tagName === 'br') {
            return '\n';
        }
        if (node instanceof HTMLTableElement) {
            return `\n${serializeTableForClipboard(node).text}\n`;
        }

        const text = Array.from(node.childNodes).map(serializeNodePlainTextForClipboard).join('');
        if (!clipboardBlockTags.has(tagName)) {
            return text;
        }

        const trimmed = text.trim();
        return trimmed ? `\n${trimmed}\n` : '';
    }

    function serializeSelectionPlainTextForClipboard(root: Node): string {
        return normalizeClipboardPlainText(
            Array.from(root.childNodes).map(serializeNodePlainTextForClipboard).join('')
        );
    }

    function findSelectedMarkdownTables(): HTMLTableElement[] {
        const container = markdownContainerRef.value;
        const selection = window.getSelection();
        if (!container || !selection || selection.rangeCount === 0 || selection.isCollapsed) {
            return [];
        }

        const tables = Array.from(container.querySelectorAll<HTMLTableElement>('table'));
        if (!tables.length) {
            return [];
        }

        const selectedTables: HTMLTableElement[] = [];
        for (let index = 0; index < selection.rangeCount; index += 1) {
            const range = selection.getRangeAt(index);
            for (const table of tables) {
                if (range.intersectsNode(table) && !selectedTables.includes(table)) {
                    selectedTables.push(table);
                }
            }
        }

        return selectedTables;
    }

    function handleMarkdownCopy(event: ClipboardEvent) {
        const clipboardData = event.clipboardData;
        if (!clipboardData) {
            return;
        }

        const selectedTables = findSelectedMarkdownTables();
        if (!selectedTables.length) {
            return;
        }

        const selectedContents = cloneSelectedMarkdownContents();
        if (selectedContents?.querySelector('table')) {
            replaceRenderedTablesWithSemanticTables(selectedContents);
            clipboardData.setData('text/html', selectedContents.innerHTML);
            clipboardData.setData(
                'text/plain',
                serializeSelectionPlainTextForClipboard(selectedContents)
            );
        } else {
            const serializedTables = selectedTables.map(serializeTableForClipboard);
            clipboardData.setData(
                'text/html',
                serializedTables.map((table) => table.html).join('')
            );
            clipboardData.setData(
                'text/plain',
                serializedTables
                    .map((table) => table.text)
                    .filter(Boolean)
                    .join('\n\n')
            );
        }
        event.preventDefault();
    }

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
