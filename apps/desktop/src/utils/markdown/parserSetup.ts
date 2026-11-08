// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * Markdown 解析器单例。
 *
 * 解析器（markdown-it + 插件 + tokenizer 配置）不是零成本对象，而组件里
 * `<script setup>` 顶层代码会随每个实例执行一次——一条消息有多个文本部件时，
 * 就会创建多份等价的解析器。放到模块级后只建一次，所有组件共享。
 */

import { full as markdownItEmoji } from 'markdown-it-emoji';
import { enableKatex, enableMermaid, getMarkdown, type MarkdownIt } from 'markstream-vue';

/** 流式内容用的解析器（增量缓存）。 */
export const streamingMarkdownParser = getMarkdown('touchai-markdown-stream', {
    enableContainers: false,
    markdownItOptions: {
        breaks: true,
    },
});

/** 已完成内容用的解析器（独立增量缓存，避免与流式共享 tokenizer 状态）。 */
export const finishedMarkdownParser = getMarkdown('touchai-markdown-static', {
    enableContainers: false,
    markdownItOptions: {
        breaks: true,
    },
});

const markdownEmojiPlugin = markdownItEmoji as unknown as Parameters<MarkdownIt['use']>[0];

let basePluginsApplied = false;

/**
 * 注册与具体组件无关的基础插件（emoji、katex、mermaid）。
 *
 * 幂等：多个组件实例都可以安全调用。
 */
export function applyMarkdownBasePlugins(): void {
    if (basePluginsApplied) {
        return;
    }

    basePluginsApplied = true;
    streamingMarkdownParser.use(markdownEmojiPlugin);
    finishedMarkdownParser.use(markdownEmojiPlugin);
    enableKatex(() => import('katex'));
    enableMermaid(() => import('mermaid'));
}
