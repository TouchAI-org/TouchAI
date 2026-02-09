<!--
  - Copyright (c) 2026. Qian Cheng. Licensed under GPL v3
  -->

<template>
    <div ref="containerRef" :class="containerClass" v-html="renderedHtml"></div>
</template>

<script setup lang="ts">
    import katex from '@vscode/markdown-it-katex';
    import hljs from 'highlight.js';
    import MarkdownIt from 'markdown-it';
    import abbr from 'markdown-it-abbr';
    import deflist from 'markdown-it-deflist';
    import footnote from 'markdown-it-footnote';
    import ins from 'markdown-it-ins';
    import mark from 'markdown-it-mark';
    import sub from 'markdown-it-sub';
    import sup from 'markdown-it-sup';
    import taskLists from 'markdown-it-task-lists';
    import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

    interface Props {
        content: string;
        variant?: 'default' | 'reasoning';
    }

    const props = withDefaults(defineProps<Props>(), {
        variant: 'default',
    });

    const containerRef = ref<HTMLElement | null>(null);

    const containerClass = computed(() => {
        if (props.variant === 'reasoning') {
            return 'prose prose-sm max-w-none';
        }
        return 'markdown-content prose prose-sm response-text max-w-none select-text';
    });

    // --- Markdown renderer (singleton) ---

    function escapeHtml(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function createMarkdownRenderer(): MarkdownIt {
        const md = new MarkdownIt({
            html: true,
            linkify: true,
            typographer: false,
            highlight: (str: string, lang: string) => {
                if (lang && hljs.getLanguage(lang)) {
                    try {
                        const highlighted = hljs.highlight(str, {
                            language: lang,
                            ignoreIllegals: true,
                        }).value;

                        return `<div class="code-block-wrapper">
                        <div class="code-block-header">
                            <span class="code-block-lang">${lang}</span>
                            <button class="code-copy-btn" data-code="${escapeHtml(str)}">
                                <svg class="copy-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                                </svg>
                                <span class="copy-text">复制</span>
                            </button>
                        </div>
                        <pre><code class="hljs language-${lang}">${highlighted}</code></pre>
                    </div>`;
                    } catch (err) {
                        console.error('Highlight error:', err);
                    }
                }

                try {
                    const result = hljs.highlightAuto(str);
                    const detectedLang = result.language || 'plaintext';

                    return `<div class="code-block-wrapper">
                    <div class="code-block-header">
                        <span class="code-block-lang">${detectedLang}</span>
                        <button class="code-copy-btn" data-code="${escapeHtml(str)}">
                            <svg class="copy-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                            </svg>
                            <span class="copy-text">复制</span>
                        </button>
                    </div>
                    <pre><code class="hljs">${result.value}</code></pre>
                </div>`;
                } catch (err) {
                    console.error('Auto highlight error:', err);
                }

                return `<div class="code-block-wrapper">
                <div class="code-block-header">
                    <span class="code-block-lang">text</span>
                    <button class="code-copy-btn" data-code="${escapeHtml(str)}">
                        <svg class="copy-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                        </svg>
                        <span class="copy-text">复制</span>
                    </button>
                </div>
                <pre><code>${escapeHtml(str)}</code></pre>
            </div>`;
            },
        });

        md.use(katex);
        md.use(footnote);
        md.use(mark);
        md.use(sub);
        md.use(sup);
        md.use(abbr);
        md.use(deflist);
        md.use(ins);
        md.use(taskLists, { enabled: true });

        return md;
    }

    let mdInstance: MarkdownIt | null = null;

    function getMd(): MarkdownIt {
        if (!mdInstance) {
            mdInstance = createMarkdownRenderer();
        }
        return mdInstance;
    }

    const renderedHtml = computed(() => {
        if (!props.content) return '';
        return getMd().render(props.content);
    });

    // --- Code copy button handler ---

    function handleCopyClick(event: Event) {
        const target = event.target as HTMLElement;
        const button = target.closest('.code-copy-btn') as HTMLButtonElement;
        if (!button) return;

        const code = button.getAttribute('data-code');
        if (!code) return;

        const textarea = document.createElement('textarea');
        textarea.innerHTML = code;
        const decodedCode = textarea.value;

        navigator.clipboard.writeText(decodedCode).then(() => {
            const copyText = button.querySelector('.copy-text');
            if (copyText) {
                const originalText = copyText.textContent;
                copyText.textContent = '已复制';
                setTimeout(() => {
                    copyText.textContent = originalText;
                }, 2000);
            }
        });
    }

    onMounted(() => {
        containerRef.value?.addEventListener('click', handleCopyClick);
    });

    onBeforeUnmount(() => {
        containerRef.value?.removeEventListener('click', handleCopyClick);
    });
</script>

<style scoped>
    /* Markdown 内容的颜色变量和基础样式 */
    .response-text {
        /* 文本颜色 */
        --color-text-primary: #111827; /* gray-900 */
        --color-text-secondary: #4b5563; /* gray-600 */

        /* 边框颜色 */
        --color-border-primary: #e5e7eb; /* gray-200 */

        /* 代码块颜色 */
        --color-code-bg: #f1ece1;
        --color-code-text: #691d1d;
        --color-code-block-bg: #1f2937; /* gray-800 */
        --color-code-block-text: #f9fafb; /* gray-50 */

        /* 链接颜色 */
        --color-link: #3b82f6; /* info-500 */
        --color-link-hover: #2563eb; /* info-600 */

        /* 基础样式 */
        font-family: 'Source Han Serif SC', 'Noto Serif SC', 'Source Serif Pro', 'Georgia', serif;
        font-size: 15px;
        line-height: 1.8;
        letter-spacing: 0.02em;
        color: var(--color-text-secondary);
    }

    .response-text :deep(h1),
    .response-text :deep(h2),
    .response-text :deep(h3),
    .response-text :deep(h4),
    .response-text :deep(h5),
    .response-text :deep(h6) {
        font-family: var(--font-serif);
        font-weight: 600;
        margin: 0.75em 0;
        color: var(--color-text-primary);
    }

    .response-text :deep(code) {
        font-family: 'JetBrains Mono', 'Fira Code', 'Consolas', 'Monaco', monospace;
        font-size: 0.9em;
        background-color: var(--color-code-bg);
        padding: 0.2em 0.4em;
        border-radius: 3px;
        color: var(--color-code-text);
    }

    .response-text :deep(pre) {
        font-family: 'JetBrains Mono', 'Fira Code', 'Consolas', 'Monaco', monospace;
        background-color: var(--color-code-block-bg);
        color: var(--color-code-block-text);
        border-radius: 6px;
        overflow-x: auto;
        line-height: 1.6;
    }

    .response-text :deep(pre code) {
        background-color: transparent;
        color: inherit;
        padding: 0;
    }

    .response-text :deep(p) {
        margin-bottom: 1em;
    }

    .response-text :deep(strong) {
        font-weight: 600;
        color: var(--color-text-primary);
    }

    .response-text :deep(a) {
        color: var(--color-link);
        text-decoration: none;
        border-bottom: 1px solid #dbeafe; /* primary-100 */
        transition: all 0.2s;
    }

    .response-text :deep(a:hover) {
        color: var(--color-link-hover);
        border-bottom-color: var(--color-link);
    }

    .response-text :deep(blockquote) {
        border-left: 4px solid var(--color-border-primary);
        padding-left: 1em;
        margin-left: 0;
        color: var(--color-text-secondary);
        font-style: italic;
    }

    .response-text :deep(ul),
    .response-text :deep(ol) {
        padding-left: 1.5em;
        margin-bottom: 1em;
    }

    .response-text :deep(li) {
        margin-bottom: 0.5em;
    }
</style>
