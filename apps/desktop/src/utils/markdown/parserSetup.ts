// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

/**
 * Markdown 解析器单例与预热。
 *
 * 解析器（markdown-it + 插件 + tokenizer 配置）不是零成本对象，而组件里
 * `<script setup>` 顶层代码会随每个实例执行一次——一条消息有多个文本部件时，
 * 就会创建多份等价的解析器。放到模块级后只建一次，所有组件共享。
 *
 * 预热只使用 markstream-vue 官方提供的 `preloadExtendedLanguageIcons()`：
 * 代码高亮运行时体积大，是否要提前拉起需要实测，故不在这里顺手调用。
 */

import { full as markdownItEmoji } from 'markdown-it-emoji';
import {
    enableKatex,
    enableMermaid,
    getMarkdown,
    type MarkdownIt,
    preloadExtendedLanguageIcons,
} from 'markstream-vue';

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

export const markdownEmojiPlugin = markdownItEmoji as unknown as Parameters<MarkdownIt['use']>[0];

let basePluginsApplied = false;

/**
 * 注册与具体组件无关的基础插件（emoji、katex、mermaid）。
 *
 * 幂等：多个组件实例、预热流程都可以安全调用。
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

let warmupStarted = false;

/** 预热 Markdown 渲染链（幂等，失败静默）。 */
export function warmUpMarkdownRuntime(): void {
    if (warmupStarted) {
        return;
    }

    warmupStarted = true;
    const startedAt = import.meta.env.DEV ? performance.now() : 0;
    applyMarkdownBasePlugins();
    void preloadExtendedLanguageIcons().catch(() => undefined);

    // 跑一次极短解析，让 markdown-it 的 tokenizer 与节点构建完成首次初始化。
    try {
        finishedMarkdownParser.render('# warmup\n\n| a | b |\n| - | - |\n| 1 | 2 |\n');
    } catch {
        // 解析器不可用（例如测试环境整体 mock）时忽略。
    }

    if (import.meta.env.DEV) {
        console.warn('[md-warmup]', { ms: Math.round(performance.now() - startedAt) });
    }
}

/**
 * 在首屏之后的空闲时段预热。
 *
 * 目标是把"启动后第一次打开会话"才付的初始化成本挪到用户不感知的时候。
 */
export function scheduleMarkdownWarmup(): void {
    const run = () => warmUpMarkdownRuntime();
    const requestIdle = (
        globalThis as {
            requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
        }
    ).requestIdleCallback;

    if (typeof requestIdle === 'function') {
        requestIdle(run, { timeout: 3000 });
        return;
    }

    setTimeout(run, 1500);
}
