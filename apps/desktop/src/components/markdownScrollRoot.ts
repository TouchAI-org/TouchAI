// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { InjectionKey } from 'vue';

/**
 * 外层滚动容器解析器。
 *
 * 会话面板通过 provide 注入自己的滚动容器；Markdown 渲染器据此绑定 markstream 的
 * `virtualScroll.scrollRoot`，避免渲染器把溢出的 `pre` 误认成自身滚动根。
 */
export type MarkdownScrollRootResolver = () => HTMLElement | null;

export const MARKDOWN_SCROLL_ROOT_KEY: InjectionKey<MarkdownScrollRootResolver> = Symbol(
    'touchai-markdown-scroll-root'
);
