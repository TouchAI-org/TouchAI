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
    const clipboardSemanticTags = new Set([
        'a',
        'blockquote',
        'br',
        'code',
        'del',
        'em',
        'h1',
        'h2',
        'h3',
        'h4',
        'h5',
        'h6',
        'hr',
        'i',
        'img',
        'li',
        'ol',
        'p',
        'pre',
        's',
        'strong',
        'sub',
        'sup',
        'table',
        'tbody',
        'td',
        'tfoot',
        'th',
        'thead',
        'tr',
        'u',
        'ul',
    ]);
    const clipboardSkippedTags = new Set([
        'button',
        'canvas',
        'input',
        'option',
        'script',
        'select',
        'style',
        'svg',
        'textarea',
    ]);
    const clipboardTableStructureTags = new Set([
        'table',
        'tbody',
        'td',
        'tfoot',
        'th',
        'thead',
        'tr',
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

    const clipboardTableAttributes =
        ' border="1" cellspacing="0" cellpadding="4" style="border-collapse: collapse;"';
    const clipboardCellStyle = ' style="border: 1px solid #000; padding: 4px;"';
    const clipboardAllowedLinkProtocols = new Set([
        'file:',
        'ftp:',
        'http:',
        'https:',
        'mailto:',
        'tel:',
    ]);
    const clipboardAllowedImageProtocols = new Set(['blob:', 'cid:', 'file:', 'http:', 'https:']);

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

                html += `<${tag}${colspan}${rowspan}${clipboardCellStyle}>${escapeClipboardHtml(text)}</${tag}>`;
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

                html += `<${tag}${colspan}${rowspan}${clipboardCellStyle}>${escapeClipboardHtml(text)}</${tag}>`;
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
            html: `<table${clipboardTableAttributes}>${sections.map((section) => section.html).join('')}</table>`,
            text: sections
                .flatMap((section) => section.textRows)
                .filter(Boolean)
                .join('\n'),
        };
    }

    function normalizeClipboardUrl(value: string): string {
        return Array.from(value.trim())
            .filter((char) => {
                const charCode = char.charCodeAt(0);
                return charCode > 0x1f && charCode !== 0x7f && !/\s/.test(char);
            })
            .join('');
    }

    function getClipboardUrlProtocol(value: string): string | null {
        const protocolMatch = /^([a-z][a-z0-9+.-]*:)/i.exec(value);
        return protocolMatch?.[1]?.toLowerCase() ?? null;
    }

    function isSafeClipboardHref(value: string): boolean {
        const normalized = normalizeClipboardUrl(value);
        if (!normalized) {
            return false;
        }

        if (normalized.startsWith('#')) {
            return true;
        }

        const protocol = getClipboardUrlProtocol(normalized);
        return protocol ? clipboardAllowedLinkProtocols.has(protocol) : true;
    }

    function isSafeClipboardImageSource(value: string): boolean {
        const normalized = normalizeClipboardUrl(value);
        if (!normalized || normalized.startsWith('#')) {
            return false;
        }
        if (/^data:image\//i.test(normalized)) {
            return true;
        }

        const protocol = getClipboardUrlProtocol(normalized);
        return protocol ? clipboardAllowedImageProtocols.has(protocol) : true;
    }

    function isClipboardSkippedElement(element: HTMLElement): boolean {
        if (
            clipboardSkippedTags.has(element.tagName.toLowerCase()) ||
            element.hidden ||
            element.getAttribute('aria-hidden') === 'true'
        ) {
            return true;
        }

        const normalizedStyle = element.getAttribute('style')?.replace(/\s+/g, '').toLowerCase();

        return Boolean(
            normalizedStyle?.includes('display:none') ||
            normalizedStyle?.includes('visibility:hidden') ||
            normalizedStyle?.includes('opacity:0')
        );
    }

    function isClipboardInlineBoundaryNode(node: Node | null): boolean {
        if (!node) {
            return false;
        }
        if (node.nodeType === Node.TEXT_NODE) {
            return Boolean(node.textContent?.trim());
        }
        if (!(node instanceof HTMLElement) || isClipboardSkippedElement(node)) {
            return false;
        }

        const tagName = node.tagName.toLowerCase();
        return !clipboardBlockTags.has(tagName) && !clipboardTableStructureTags.has(tagName);
    }

    function findClipboardBoundarySibling(node: Node, direction: 'previous' | 'next'): Node | null {
        let sibling = direction === 'previous' ? node.previousSibling : node.nextSibling;
        while (sibling) {
            if (sibling.nodeType === Node.TEXT_NODE) {
                if (sibling.textContent?.trim()) {
                    return sibling;
                }
            } else if (!(sibling instanceof HTMLElement) || !isClipboardSkippedElement(sibling)) {
                return sibling;
            }

            sibling = direction === 'previous' ? sibling.previousSibling : sibling.nextSibling;
        }

        return null;
    }

    function hasPreviousWhitespaceInSkippedSiblingRun(node: Node): boolean {
        let sibling = node.previousSibling;
        while (sibling) {
            if (sibling.nodeType === Node.TEXT_NODE) {
                return !sibling.textContent?.trim();
            }
            if (sibling instanceof HTMLElement && isClipboardSkippedElement(sibling)) {
                sibling = sibling.previousSibling;
                continue;
            }

            return false;
        }

        return false;
    }

    function serializeTextHtmlForClipboard(textNode: Text): string {
        const value = textNode.textContent ?? '';
        const hasInlineBefore = isClipboardInlineBoundaryNode(
            findClipboardBoundarySibling(textNode, 'previous')
        );
        const hasInlineAfter = isClipboardInlineBoundaryNode(
            findClipboardBoundarySibling(textNode, 'next')
        );

        if (!value.trim()) {
            return hasInlineBefore &&
                hasInlineAfter &&
                !hasPreviousWhitespaceInSkippedSiblingRun(textNode)
                ? ' '
                : '';
        }

        let normalized = value.replace(/\s+/g, ' ');
        if (!hasInlineBefore || hasPreviousWhitespaceInSkippedSiblingRun(textNode)) {
            normalized = normalized.trimStart();
        }
        if (!hasInlineAfter) {
            normalized = normalized.trimEnd();
        }

        return normalized ? escapeClipboardHtml(normalized) : '';
    }

    function serializeTextPlainTextForClipboard(textNode: Text): string {
        const value = textNode.textContent ?? '';
        const hasInlineBefore = isClipboardInlineBoundaryNode(
            findClipboardBoundarySibling(textNode, 'previous')
        );
        const hasInlineAfter = isClipboardInlineBoundaryNode(
            findClipboardBoundarySibling(textNode, 'next')
        );

        if (!value.trim()) {
            return hasInlineBefore &&
                hasInlineAfter &&
                !hasPreviousWhitespaceInSkippedSiblingRun(textNode)
                ? ' '
                : '';
        }

        let normalized = value.replace(/\s+/g, ' ');
        if (!hasInlineBefore || hasPreviousWhitespaceInSkippedSiblingRun(textNode)) {
            normalized = normalized.trimStart();
        }
        if (!hasInlineAfter) {
            normalized = normalized.trimEnd();
        }

        return normalized;
    }

    function escapeMarkdownLinkDestination(value: string): string {
        return value.replace(/\\/g, '\\\\').replace(/\)/g, '\\)');
    }

    function serializeImageForClipboard(image: HTMLImageElement): string {
        const source = image.getAttribute('src')?.trim();
        if (!source || !isSafeClipboardImageSource(source)) {
            return '';
        }

        const attributes = [`src="${escapeClipboardHtml(source)}"`];
        const alt = image.getAttribute('alt')?.trim();
        const title = image.getAttribute('title')?.trim();

        if (alt) {
            attributes.push(`alt="${escapeClipboardHtml(alt)}"`);
        }
        if (title) {
            attributes.push(`title="${escapeClipboardHtml(title)}"`);
        }

        return `<img ${attributes.join(' ')}>`;
    }

    function serializeChildrenHtmlForClipboard(node: Node): string {
        return Array.from(node.childNodes).map(serializeNodeHtmlForClipboard).join('');
    }

    function serializeListItemChildrenHtmlForClipboard(listItem: HTMLElement): string {
        return Array.from(listItem.childNodes)
            .map((child) => serializeListItemChildHtmlForClipboard(child))
            .join('');
    }

    function serializeListItemChildHtmlForClipboard(child: Node): string {
        if (child instanceof HTMLParagraphElement) {
            return serializeChildrenHtmlForClipboard(child);
        }

        if (child instanceof HTMLElement && shouldUnwrapClipboardListItemElement(child)) {
            return serializeListItemChildrenHtmlForClipboard(child);
        }

        return serializeNodeHtmlForClipboard(child);
    }

    function shouldUnwrapClipboardListItemElement(element: HTMLElement): boolean {
        const tagName = element.tagName.toLowerCase();
        if (tagName === 'p') {
            return true;
        }

        return (
            tagName === 'div' ||
            tagName === 'span' ||
            element.classList.contains('markdown-renderer') ||
            element.classList.contains('node-slot') ||
            element.classList.contains('node-content')
        );
    }

    function serializeNodeHtmlForClipboard(node: Node): string {
        if (node.nodeType === Node.TEXT_NODE) {
            return serializeTextHtmlForClipboard(node as Text);
        }

        if (!(node instanceof HTMLElement)) {
            return serializeChildrenHtmlForClipboard(node);
        }

        const tagName = node.tagName.toLowerCase();
        if (isClipboardSkippedElement(node)) {
            return '';
        }
        if (node instanceof HTMLTableElement) {
            return serializeTableForClipboard(node).html;
        }
        if (node instanceof HTMLImageElement) {
            return serializeImageForClipboard(node);
        }
        if (tagName === 'br') {
            return '<br>';
        }
        if (tagName === 'hr') {
            return '<hr>';
        }
        if (tagName === 'pre') {
            return `<pre><code>${escapeClipboardHtml(node.textContent ?? '')}</code></pre>`;
        }

        const children =
            tagName === 'li'
                ? serializeListItemChildrenHtmlForClipboard(node)
                : serializeChildrenHtmlForClipboard(node);
        if (!children || !clipboardSemanticTags.has(tagName)) {
            return children;
        }

        if (tagName === 'a') {
            const href = node.getAttribute('href')?.trim();
            const title = node.getAttribute('title')?.trim();
            const attributes: string[] = [];

            if (href && isSafeClipboardHref(href)) {
                attributes.push(`href="${escapeClipboardHtml(href)}"`);
            }
            if (title) {
                attributes.push(`title="${escapeClipboardHtml(title)}"`);
            }

            return `<a${attributes.length ? ` ${attributes.join(' ')}` : ''}>${children}</a>`;
        }
        if (tagName === 'ol') {
            const attributes: string[] = [];
            const start = parseClipboardIntegerAttribute(node, 'start');
            const type = node.getAttribute('type')?.trim();

            if (start !== null && start !== 1) {
                attributes.push(`start="${start}"`);
            }
            if (node.hasAttribute('reversed')) {
                attributes.push('reversed');
            }
            if (type && ['1', 'a', 'A', 'i', 'I'].includes(type)) {
                attributes.push(`type="${type}"`);
            }

            return `<ol${attributes.length ? ` ${attributes.join(' ')}` : ''}>${children}</ol>`;
        }
        if (tagName === 'li') {
            const value = parseClipboardIntegerAttribute(node, 'value');
            const attributes = value !== null ? ` value="${value}"` : '';

            return `<li${attributes}>${children}</li>`;
        }

        return `<${tagName}>${children}</${tagName}>`;
    }

    function serializeSelectionHtmlForClipboard(root: Node): string {
        return serializeChildrenHtmlForClipboard(root).trim();
    }

    type ClipboardListElement = HTMLOListElement | HTMLUListElement;

    function parseClipboardIntegerAttribute(element: Element, name: string): number | null {
        const rawValue = element.getAttribute(name)?.trim();
        if (!rawValue) {
            return null;
        }

        const parsed = Number.parseInt(rawValue, 10);
        return Number.isFinite(parsed) ? parsed : null;
    }

    function getClipboardElementForRangeNode(node: Node): HTMLElement | null {
        if (node instanceof HTMLElement) {
            return node;
        }

        return node.parentElement;
    }

    function closestClipboardListElement(node: Node): ClipboardListElement | null {
        const element = getClipboardElementForRangeNode(node);
        const list = element?.closest('ol, ul');

        return list instanceof HTMLOListElement || list instanceof HTMLUListElement ? list : null;
    }

    function findSingleClipboardListParent(range: Range): ClipboardListElement | null {
        const startList = closestClipboardListElement(range.startContainer);
        const endList = closestClipboardListElement(range.endContainer);

        return startList && startList === endList ? startList : null;
    }

    function directClipboardListItems(list: ClipboardListElement): HTMLLIElement[] {
        return Array.from(list.children).filter(
            (child): child is HTMLLIElement => child instanceof HTMLLIElement
        );
    }

    function resolveOrderedListStartForRange(list: HTMLOListElement, range: Range): number | null {
        const items = directClipboardListItems(list);
        const selectedItemIndex = items.findIndex((item) => range.intersectsNode(item));
        if (selectedItemIndex < 0) {
            return null;
        }

        const reversed = list.hasAttribute('reversed');
        let nextNumber =
            parseClipboardIntegerAttribute(list, 'start') ?? (reversed ? items.length : 1);

        for (let index = 0; index <= selectedItemIndex; index += 1) {
            const item = items[index];
            if (!item) {
                return null;
            }

            const itemNumber = parseClipboardIntegerAttribute(item, 'value') ?? nextNumber;
            if (index === selectedItemIndex) {
                return itemNumber;
            }

            nextNumber = itemNumber + (reversed ? -1 : 1);
        }

        return null;
    }

    function applyClipboardListAttributes(
        targetList: ClipboardListElement,
        sourceList: ClipboardListElement,
        range: Range
    ) {
        if (
            !(targetList instanceof HTMLOListElement) ||
            !(sourceList instanceof HTMLOListElement)
        ) {
            return;
        }

        const start = resolveOrderedListStartForRange(sourceList, range);
        const type = sourceList.getAttribute('type')?.trim();

        if (start !== null && (start !== 1 || sourceList.hasAttribute('start'))) {
            targetList.setAttribute('start', String(start));
        }
        if (sourceList.hasAttribute('reversed')) {
            targetList.setAttribute('reversed', '');
        }
        if (type && ['1', 'a', 'A', 'i', 'I'].includes(type)) {
            targetList.setAttribute('type', type);
        }
    }

    function isIgnorableClipboardWhitespaceNode(node: Node): boolean {
        return node.nodeType === Node.TEXT_NODE && !(node.textContent ?? '').trim();
    }

    function wrapTopLevelListItemsForClipboard(
        root: DocumentFragment | HTMLElement,
        sourceList: ClipboardListElement | null,
        range: Range
    ) {
        if (!sourceList) {
            return;
        }

        let child: Node | null = root.firstChild;
        while (child) {
            if (!(child instanceof HTMLLIElement)) {
                child = child.nextSibling;
                continue;
            }

            const list = document.createElement(sourceList.tagName.toLowerCase()) as
                | HTMLOListElement
                | HTMLUListElement;
            applyClipboardListAttributes(list, sourceList, range);
            root.insertBefore(list, child);

            while (child) {
                if (isIgnorableClipboardWhitespaceNode(child)) {
                    const nextSibling: Node | null = child.nextSibling;
                    child.parentNode?.removeChild(child);
                    child = nextSibling;
                    continue;
                }
                if (!(child instanceof HTMLLIElement)) {
                    break;
                }

                const nextSibling: Node | null = child.nextSibling;
                list.appendChild(child);
                child = nextSibling;
            }
        }
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

            const selectedContent = range.cloneContents();
            wrapTopLevelListItemsForClipboard(
                selectedContent,
                findSingleClipboardListParent(range),
                range
            );
            wrapper.append(selectedContent);
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
            return serializeTextPlainTextForClipboard(node as Text);
        }

        if (!(node instanceof HTMLElement)) {
            return Array.from(node.childNodes).map(serializeNodePlainTextForClipboard).join('');
        }

        const tagName = node.tagName.toLowerCase();
        if (isClipboardSkippedElement(node)) {
            return '';
        }
        if (tagName === 'br') {
            return '\n';
        }
        if (node instanceof HTMLTableElement) {
            return `\n${serializeTableForClipboard(node).text}\n`;
        }
        if (node instanceof HTMLImageElement) {
            const source = node.getAttribute('src')?.trim();
            return source && isSafeClipboardImageSource(source) && node.alt ? `[${node.alt}]` : '';
        }
        if (tagName === 'pre') {
            return `\n${node.textContent ?? ''}\n`;
        }
        if (tagName === 'a') {
            const text = normalizeClipboardPlainText(
                Array.from(node.childNodes).map(serializeNodePlainTextForClipboard).join('')
            );
            const href = node.getAttribute('href')?.trim();

            if (text && href && isSafeClipboardHref(href) && text !== href) {
                return `[${text}](${escapeMarkdownLinkDestination(href)})`;
            }

            return text;
        }
        if (tagName === 'ul' || tagName === 'ol') {
            const listItems = Array.from(node.children).filter(
                (child): child is HTMLLIElement => child instanceof HTMLLIElement
            );
            const reversed = tagName === 'ol' && node.hasAttribute('reversed');
            let nextNumber =
                tagName === 'ol'
                    ? (parseClipboardIntegerAttribute(node, 'start') ??
                      (reversed ? listItems.length : 1))
                    : 1;
            const listText = listItems
                .map((item) => {
                    const itemNumber =
                        tagName === 'ol'
                            ? (parseClipboardIntegerAttribute(item, 'value') ?? nextNumber)
                            : nextNumber;
                    nextNumber = itemNumber + (reversed ? -1 : 1);
                    const marker = tagName === 'ol' ? `${itemNumber}. ` : '- ';
                    return `${marker}${serializeSelectionPlainTextForClipboard(item)}`;
                })
                .join('\n');

            return listText ? `\n${listText}\n` : '';
        }

        const text = Array.from(node.childNodes).map(serializeNodePlainTextForClipboard).join('');
        if (tagName === 'li') {
            return normalizeClipboardPlainText(text);
        }
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

    function handleMarkdownCopy(event: ClipboardEvent) {
        const clipboardData = event.clipboardData;
        if (!clipboardData) {
            return;
        }

        const selectedContents = cloneSelectedMarkdownContents();
        if (!selectedContents) {
            return;
        }

        replaceRenderedTablesWithSemanticTables(selectedContents);
        clipboardData.setData('text/html', serializeSelectionHtmlForClipboard(selectedContents));
        clipboardData.setData(
            'text/plain',
            serializeSelectionPlainTextForClipboard(selectedContents)
        );
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
