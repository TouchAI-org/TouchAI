import type { Editor, JSONContent } from '@tiptap/core';
import { Extension } from '@tiptap/core';
import Placeholder from '@tiptap/extension-placeholder';
import type { Node as PmNode } from '@tiptap/pm/model';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { NodeSelection, Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import StarterKit from '@tiptap/starter-kit';

import {
    getAllSearchTags,
    getSearchTag,
    getSearchTagNodes,
    isRegisteredTagNode,
} from '../tags/registry';

export const SEARCH_TAG_SELECTOR = '[data-search-tag]';
export const SEARCH_TAG_CLOSE_SELECTOR = '[data-tag-close]';
export const SEARCH_TAG_INTERACTIVE_SELECTOR = `${SEARCH_TAG_SELECTOR}, ${SEARCH_TAG_CLOSE_SELECTOR}`;
export const DEFAULT_PLACEHOLDER = '写下你的需求...';

export function findSearchTagChip(target: Element | null) {
    return target?.closest(SEARCH_TAG_SELECTOR) as HTMLElement | null;
}

export function isSearchTagDomTarget(target: Element | null) {
    return Boolean(target?.closest(SEARCH_TAG_INTERACTIVE_SELECTOR));
}

/** 判断目标是否为编辑器空白区域（editor host 或 tiptap 根元素）。 */
export function isBlankEditorAreaTarget(target: HTMLElement) {
    return (
        target.classList.contains('search-bar-editor-host') || target.classList.contains('tiptap')
    );
}

/** 从鼠标事件中解析目标 HTMLElement（兼容 Text 节点）。 */
export function resolveMouseEventTarget(event: MouseEvent): HTMLElement | null {
    const raw = event.target;
    return raw instanceof HTMLElement ? raw : raw instanceof Text ? raw.parentElement : null;
}

// ─── 节点同步插件 ─────────────────────────────────────────────────
//
// NodeSync 通过 appendTransaction 钩子检测标签节点的增删：
// 每次文档变化时，收集新旧状态中各标签类型的 ID 集合，
// 差异部分通过 onTagRemoved 回调通知上层同步业务状态。
// 设计为泛化接口（tagName + id），新增标签类型无需修改此处。

interface NodeSyncCallbacks {
    /** 当标签节点从文档中被移除时触发（tagName 为节点类型名，id 为节点唯一标识） */
    onTagRemoved?: (tagName: string, id: string) => void;
}

const nodeSyncPluginKey = new PluginKey('nodeSync');
const tagRangeSelectionPluginKey = new PluginKey('tagRangeSelection');

/**
 * 创建节点同步 ProseMirror 插件。
 * 在每次文档变化的 appendTransaction 中比较新旧状态，
 * 检测被移除的标签节点并触发回调。
 */
function createNodeSyncPlugin(callbacks: NodeSyncCallbacks) {
    return new Plugin({
        key: nodeSyncPluginKey,
        appendTransaction(
            transactions: readonly Transaction[],
            oldState: EditorState,
            newState: EditorState
        ) {
            // 编程式清空编辑器时通过 meta 标记跳过同步检查
            if (transactions.some((tr) => tr.getMeta(nodeSyncPluginKey))) return null;
            // 仅在文档发生变化时检查
            if (!transactions.some((tr) => tr.docChanged)) return null;

            const allTags = getAllSearchTags();
            const oldIds = new Map<string, Set<string>>();
            const newIds = new Map<string, Set<string>>();

            for (const tag of allTags) {
                oldIds.set(tag.name, new Set());
                newIds.set(tag.name, new Set());
            }

            // 通过 node.type.name 直接查 Map，避免对每个节点遍历所有标签类型
            oldState.doc.descendants((node: PmNode) => {
                const tag = getSearchTag(node.type.name);
                if (!tag) return;
                const id = tag.collectNodeId(node);
                if (id !== null) oldIds.get(tag.name)!.add(id);
            });

            newState.doc.descendants((node: PmNode) => {
                const tag = getSearchTag(node.type.name);
                if (!tag) return;
                const id = tag.collectNodeId(node);
                if (id !== null) newIds.get(tag.name)!.add(id);
            });

            // 检测被移除的节点
            for (const tag of allTags) {
                for (const id of oldIds.get(tag.name)!) {
                    if (!newIds.get(tag.name)!.has(id)) {
                        callbacks.onTagRemoved?.(tag.name, id);
                    }
                }
            }

            return null;
        },
    });
}

const NodeSyncExtension = Extension.create<NodeSyncCallbacks>({
    name: 'nodeSync',

    addOptions() {
        return {
            onTagRemoved: undefined,
        };
    },

    addProseMirrorPlugins() {
        return [createNodeSyncPlugin(this.options), createTagRangeSelectionPlugin()];
    },
});

/**
 * 创建范围选区装饰插件。
 * 当用户拖拽选区跨越原子标签节点时，为被选中的标签添加视觉高亮样式，
 * 因为原子节点无法被浏览器原生 ::selection 样式覆盖。
 */
function createTagRangeSelectionPlugin() {
    return new Plugin({
        key: tagRangeSelectionPluginKey,
        props: {
            decorations(state) {
                const { doc, selection } = state;
                if (selection.empty || selection instanceof NodeSelection) {
                    return null;
                }

                const decorations: Decoration[] = [];
                doc.nodesBetween(selection.from, selection.to, (node, pos) => {
                    if (isRegisteredTagNode(node)) {
                        decorations.push(
                            Decoration.node(pos, pos + node.nodeSize, {
                                class: 'search-tag-range-selected',
                            })
                        );
                    }
                });

                if (!decorations.length) {
                    return null;
                }

                return DecorationSet.create(doc, decorations);
            },
        },
    });
}

/** 若光标前方紧邻一个标签节点，返回该标签的起始位置。 */
function getTagStartBeforeCursor(doc: PmNode, from: number) {
    const $from = doc.resolve(from);
    const nodeBefore = $from.nodeBefore;
    if (!nodeBefore || !isRegisteredTagNode(nodeBefore)) {
        return null;
    }

    return from - nodeBefore.nodeSize;
}

/** 若光标后方紧邻一个标签节点，返回该标签的结束位置。 */
function getTagEndAfterCursor(doc: PmNode, from: number) {
    const $from = doc.resolve(from);
    const nodeAfter = $from.nodeAfter;
    if (!nodeAfter || !isRegisteredTagNode(nodeAfter)) {
        return null;
    }

    return from + nodeAfter.nodeSize;
}

/** 当前选区为标签 NodeSelection 时，删除该标签。 */
function removeSelectedTag(editor: Editor) {
    const { selection } = editor.state;
    if (!(selection instanceof NodeSelection) || !isRegisteredTagNode(selection.node)) {
        return false;
    }

    return editor.commands.command(({ tr }: { tr: Transaction; state: EditorState }) => {
        tr.delete(selection.from, selection.to);
        return true;
    });
}

/** 光标紧贴标签右侧时，Backspace 删除光标前方的标签。 */
function removeTagBeforeCursor(editor: Editor) {
    const { selection } = editor.state;
    if (!selection.empty) {
        return false;
    }

    const from = selection.from;
    const tagStart = getTagStartBeforeCursor(editor.state.doc, from);
    if (tagStart == null) {
        return false;
    }

    return editor.commands.command(({ tr }: { tr: Transaction }) => {
        tr.delete(tagStart, from);
        return true;
    });
}

/**
 * Shift+Arrow 跨标签扩展选区。
 * 标签为原子节点，ProseMirror 默认无法将选区延伸穿过它，
 * 此函数手动将 selection.head 跳过标签的整个宽度。
 */
function extendSelectionAcrossTag(editor: Editor, direction: 'left' | 'right') {
    const { doc, selection } = editor.state;

    if (selection instanceof NodeSelection && isRegisteredTagNode(selection.node)) {
        const anchor = direction === 'left' ? selection.to : selection.from;
        const head = direction === 'left' ? selection.from : selection.to;

        return editor.commands.command(({ tr }: { tr: Transaction }) => {
            tr.setSelection(TextSelection.create(tr.doc, anchor, head));
            return true;
        });
    }

    const target =
        direction === 'left'
            ? getTagStartBeforeCursor(doc, selection.head)
            : getTagEndAfterCursor(doc, selection.head);

    if (target == null) {
        return false;
    }

    return editor.commands.command(({ tr }: { tr: Transaction }) => {
        tr.setSelection(TextSelection.create(tr.doc, selection.anchor, target));
        return true;
    });
}

/**
 * Arrow 键跨标签移动光标。
 * 标签为原子节点，光标无法停留在其内部；
 * 碰到标签时直接跳到标签的另一端。
 */
function moveCursorAcrossTag(editor: Editor, direction: 'left' | 'right') {
    const { doc, selection } = editor.state;

    if (selection instanceof NodeSelection && isRegisteredTagNode(selection.node)) {
        const target = direction === 'left' ? selection.from : selection.to;
        return editor.commands.command(({ tr }: { tr: Transaction }) => {
            tr.setSelection(TextSelection.create(tr.doc, target));
            return true;
        });
    }

    if (!selection.empty) {
        return false;
    }

    const from = selection.from;

    if (direction === 'right') {
        const target = getTagEndAfterCursor(doc, from);
        if (target == null) {
            return selection.$head.parentOffset === selection.$head.parent.content.size;
        }

        return editor.commands.command(({ tr }: { tr: Transaction }) => {
            tr.setSelection(TextSelection.create(tr.doc, target));
            return true;
        });
    }

    const target = getTagStartBeforeCursor(doc, from);
    if (target == null) {
        return selection.$head.parentOffset === 0;
    }

    return editor.commands.command(({ tr }: { tr: Transaction }) => {
        tr.setSelection(TextSelection.create(tr.doc, target));
        return true;
    });
}

// ─── 搜索键盘快捷键 ─────────────────────────────────────────────

const SearchKeyboard = Extension.create({
    name: 'searchKeyboard',

    addKeyboardShortcuts() {
        return {
            Enter: () => {
                // 阻止 ProseMirror 创建新段落；提交/转发由外层捕获阶段监听处理
                return true;
            },
            'Shift-Enter': ({ editor }: { editor: Editor }) => {
                return editor.commands.setHardBreak();
            },
            Backspace: ({ editor }: { editor: Editor }) => {
                return removeSelectedTag(editor) || removeTagBeforeCursor(editor);
            },
            ArrowLeft: ({ editor }: { editor: Editor }) => {
                return moveCursorAcrossTag(editor, 'left');
            },
            ArrowRight: ({ editor }: { editor: Editor }) => {
                return moveCursorAcrossTag(editor, 'right');
            },
            'Shift-ArrowLeft': ({ editor }: { editor: Editor }) => {
                return extendSelectionAcrossTag(editor, 'left');
            },
            'Shift-ArrowRight': ({ editor }: { editor: Editor }) => {
                return extendSelectionAcrossTag(editor, 'right');
            },
        };
    },
});

// ─── 扩展工厂 ─────────────────────────────────────────────────────

export interface CreateSearchEditorOptions {
    placeholder?: string;
    onTagRemoved?: (tagName: string, id: string) => void;
}

/**
 * 创建搜索编辑器的 Tiptap 扩展列表。
 * 返回扩展数组，传给 `new Editor({ extensions })`。
 */
export function createSearchEditorExtensions(options: CreateSearchEditorOptions) {
    const { placeholder, onTagRemoved } = options;

    return [
        StarterKit.configure({
            bold: false,
            italic: false,
            strike: false,
            code: false,
            codeBlock: false,
            heading: false,
            bulletList: false,
            orderedList: false,
            listItem: false,
            blockquote: false,
            horizontalRule: false,
            dropcursor: false,
            gapcursor: false,
            // 保留：document、paragraph、text、hardBreak、history
        }),
        Placeholder.configure({
            placeholder: placeholder || DEFAULT_PLACEHOLDER,
        }),
        ...getSearchTagNodes(),
        NodeSyncExtension.configure({
            onTagRemoved,
        }),
        SearchKeyboard,
    ];
}

// ─── 辅助函数 ─────────────────────────────────────────────────────

/** 从编辑器中提取纯文本，排除标签内容。 */
export function getEditorText(editor: Editor): string {
    return editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n', '');
}

/**
 * 检查编辑器内容是否为纯文本（不含任何自定义节点）。
 * 只允许 doc / paragraph / text 三种基础节点；
 * 任何自定义原子节点（模型标签、附件标签等）均视为非纯文本。
 *
 * @param editor Tiptap 编辑器实例。
 * @returns 仅含基础节点时为 true。
 */
export function isPlainText(editor: Editor): boolean {
    let plain = true;
    editor.state.doc.descendants((node) => {
        if (node.isText || node.type.name === 'doc' || node.type.name === 'paragraph') {
            return;
        }
        plain = false;
        // 返回 false 终止 ProseMirror descendants 遍历，提前退出。
        return false;
    });
    return plain;
}

/** 判断光标是否在文档起始位置。 */
export function isCursorAtDocStart(editor: Editor): boolean {
    const { from, to } = editor.state.selection;
    return from <= 1 && to <= 1;
}

export function getEditorJSON(editor: Editor): JSONContent {
    return editor.getJSON();
}

/** 从 JSON 恢复编辑器内容。 */
export function setEditorJSON(editor: Editor, json: JSONContent) {
    editor.commands.setContent(json);
}

/**
 * 用纯文本重建编辑器内容。
 */
export function setEditorText(editor: Editor, text: string) {
    if (!text) {
        clearEditor(editor);
        return;
    }

    const paragraphs = text.split('\n').map((line) => {
        if (!line) {
            return { type: 'paragraph' };
        }

        return {
            type: 'paragraph',
            content: [{ type: 'text', text: line }],
        };
    });

    setEditorJSON(editor, {
        type: 'doc',
        content: paragraphs,
    });
}

/** 清空编辑器内容。 */
export function clearEditor(editor: Editor) {
    editor.commands.clearContent(true);
}

/**
 * 清空编辑器内容并通过 transaction meta 跳过 NodeSync 同步检查。
 * 用于编程式清空（如进入模型搜索模式），避免误触发标签移除回调。
 */
export function clearEditorSkipSync(editor: Editor) {
    editor.commands.command(({ tr, state }) => {
        const emptyDoc = state.schema.topNodeType.createAndFill();
        if (!emptyDoc) return false;
        tr.replaceWith(0, state.doc.content.size, emptyDoc.content);
        tr.setMeta(nodeSyncPluginKey, 'skip');
        return true;
    });
}

// ─── 标签点击处理 ─────────────────────────────────────────────────

/**
 * 将标签 DOM 元素对应的 ProseMirror 节点选中为 NodeSelection。
 * posAtDOM 返回的位置可能略有偏差，因此先尝试 nodeAt，再 fallback 到 nodeBefore。
 */
function selectTagNode(editor: Editor, chip: HTMLElement) {
    try {
        const { state, view } = editor;
        const pos = view.posAtDOM(chip, 0);
        let node = state.doc.nodeAt(pos) ?? state.doc.resolve(pos).nodeAfter;
        let nodePos = pos;

        if (!node || !isRegisteredTagNode(node)) {
            const resolved = state.doc.resolve(pos);
            node = resolved.nodeBefore;
            if (!node || !isRegisteredTagNode(node)) {
                return false;
            }
            nodePos = pos - node.nodeSize;
        }

        view.dispatch(state.tr.setSelection(NodeSelection.create(state.doc, nodePos)));
        view.focus();
        return true;
    } catch {
        return false;
    }
}

export function handleEditorClick(editor: Editor, event: MouseEvent) {
    const target = resolveMouseEventTarget(event);

    if (!target) {
        return;
    }

    const chip = findSearchTagChip(target);
    if (chip) {
        const { selection } = editor.state;
        if (!selection.empty && !(selection instanceof NodeSelection)) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        selectTagNode(editor, chip);
    }
}
