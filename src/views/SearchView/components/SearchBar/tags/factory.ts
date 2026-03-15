/**
 * 搜索标签节点工厂。
 * 封装所有标签节点的共性（inline、atom、selectable、统一 DOM 结构），
 * 各标签只需提供差异部分（属性、子元素渲染、Vue NodeView）。
 *
 * renderHTML 生成的 HTML 用于剪贴板复制；运行时若提供 addNodeView，
 * Vue NodeView 会完全替代 renderHTML 输出。
 */

import { mergeAttributes, Node, type NodeConfig } from '@tiptap/core';
import type { DOMOutputSpec } from '@tiptap/pm/model';

// Tiptap renderHTML 的 HTMLAttributes 参数即 Record<string, any>，
// 此处定义别名以保持一致性并集中抑制 lint 规则。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HTMLAttrs = Record<string, any>;

export interface SearchTagNodeOptions {
    /** Tiptap 节点名称（唯一标识，如 'modelTag'） */
    name: string;
    /** DOM data 属性类别（如 'model'），用于 CSS 选择器和 parseHTML */
    kind: string;
    /** 专用 HTML 标签选择器，用于从剪贴板/SSR HTML 解析回节点 */
    parseTag: string;
    /** 返回节点属性定义（含默认值），映射到 ProseMirror attrs */
    addAttributes: () => Record<string, { default: unknown }>;
    /** 追加到根 span 的额外 HTML 属性（如 data-model-id） */
    getRootAttributes?: (HTMLAttributes: HTMLAttrs) => HTMLAttrs;
    /** 渲染标签内部子元素（标签文本、图标、关闭按钮等） */
    renderChildren: (HTMLAttributes: HTMLAttrs) => DOMOutputSpec[];
    /** 可选的 Vue NodeView，运行时替代 renderHTML 输出 */
    addNodeView?: NodeConfig['addNodeView'];
}

/** 生成标签关闭按钮的 DOMOutputSpec，供 renderHTML 使用（剪贴板场景）。 */
export function createTagCloseButton(kind: string): DOMOutputSpec {
    return [
        'button',
        {
            class: `search-tag-close search-tag-close--${kind}`,
            'data-tag-close': '',
            type: 'button',
            contenteditable: 'false',
        },
        '×',
    ];
}

/**
 * 创建搜索标签 Tiptap Node 扩展。
 * 所有标签共享：inline + atom（不可编辑内部内容）+ selectable + 统一 DOM 骨架。
 *
 * @param options 标签差异化配置。
 * @returns Tiptap Node 扩展实例。
 */
export function createSearchTagNode(options: SearchTagNodeOptions) {
    return Node.create({
        name: options.name,
        group: 'inline',
        inline: true,
        // atom: 光标不能进入标签内部，整体作为一个不可分割单元
        atom: true,
        selectable: true,
        draggable: false,

        addAttributes() {
            return options.addAttributes();
        },

        parseHTML() {
            // 双规则解析：专用标签选择器（向后兼容）+ 通用 data 属性选择器（跨标签统一）
            return [
                { tag: options.parseTag },
                { tag: `span[data-search-tag][data-search-tag-kind="${options.kind}"]` },
            ];
        },

        renderHTML({ HTMLAttributes }: { HTMLAttributes: HTMLAttrs }) {
            return [
                'span',
                mergeAttributes(
                    HTMLAttributes,
                    {
                        'data-search-tag': '',
                        'data-search-tag-kind': options.kind,
                        class: `search-tag-chip search-tag-chip--${options.kind}`,
                        contenteditable: 'false',
                    },
                    options.getRootAttributes?.(HTMLAttributes) ?? {}
                ),
                [
                    'span',
                    { class: 'search-tag-content' },
                    ...options.renderChildren(HTMLAttributes),
                ],
            ];
        },

        ...(options.addNodeView ? { addNodeView: options.addNodeView } : {}),
    });
}
