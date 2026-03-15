/**
 * 模型标签插件。
 * 在搜索栏中显示当前选中的 AI 模型，
 * 始终固定在文档 position 1（首段起始），整个编辑器最多只有一个模型标签。
 */

import type { Editor } from '@tiptap/core';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { TextSelection } from '@tiptap/pm/state';
import { VueNodeViewRenderer } from '@tiptap/vue-3';
import type { Component } from 'vue';

import { createSearchTagNode, createTagCloseButton } from '../factory';
import { registerSearchTag } from '../registry';
import ModelTagView from './ModelTagView.vue';

export const MODEL_TAG_NODE = 'modelTag';

/** 模型标签节点属性。 */
export interface ModelTagAttrs {
    /** 模型在 AI 服务中的唯一标识（如 gpt-4o） */
    modelId: string;
    /** 模型显示名称（如 GPT-4o） */
    modelName: string;
    /** 关联的 AI 服务商数据库 ID，用于发送请求时路由到正确的 provider */
    providerId: number | null;
}

const ModelTagNode = createSearchTagNode({
    name: MODEL_TAG_NODE,
    kind: 'model',
    parseTag: 'span[data-model-tag]',
    addAttributes() {
        return {
            modelId: { default: null },
            modelName: { default: null },
            providerId: { default: null },
        };
    },
    getRootAttributes(HTMLAttributes) {
        return {
            'data-model-tag': '',
            'data-model-id': HTMLAttributes.modelId || '',
        };
    },
    renderChildren(HTMLAttributes) {
        return [
            [
                'span',
                { class: 'search-tag-label search-tag-label--model' },
                `@${HTMLAttributes.modelName || ''}`,
            ],
            createTagCloseButton('model'),
        ];
    },
    addNodeView: () => VueNodeViewRenderer(ModelTagView as Component),
});

// ─── CRUD ────────────────────────────────────────────────────────

/**
 * 读取编辑器中的模型标签属性。
 * 通过遍历文档查找模型标签节点，避免依赖固定位置假设。
 */
export function getModelTag(editor: Editor): ModelTagAttrs | null {
    let result: ModelTagAttrs | null = null;
    editor.state.doc.descendants((node) => {
        if (node.type.name === MODEL_TAG_NODE) {
            result = {
                modelId: node.attrs.modelId,
                modelName: node.attrs.modelName,
                providerId: node.attrs.providerId,
            };
            return false; // 找到后停止遍历
        }
        return true;
    });
    return result;
}

/**
 * 插入模型标签（若已有则原子替换）。
 * 在同一 ProseMirror 事务中执行「删旧 + 插新」，
 * 避免 NodeSync 在中间状态检测到"标签被移除"而误清选择状态。
 * 新标签始终插入到文档开头（position 1）。
 */
export function insertModelTag(editor: Editor, attrs: ModelTagAttrs) {
    editor
        .chain()
        .focus()
        .command(({ tr, state }: { tr: Transaction; state: EditorState }) => {
            // 在同一事务中移除旧标签并插入新标签，
            // 避免 NodeSync 在中间状态检测到"标签被移除"而误清除选择状态。
            let existingPos: number | null = null;
            let existingSize = 0;
            state.doc.descendants((node, pos) => {
                if (node.type.name === MODEL_TAG_NODE && existingPos === null) {
                    existingPos = pos;
                    existingSize = node.nodeSize;
                    return false; // 找到后停止遍历
                }
                return true;
            });

            if (existingPos !== null) {
                tr.delete(existingPos, existingPos + existingSize);
            }

            const modelTagType = state.schema.nodes.modelTag;
            if (!modelTagType) return false;

            const node = modelTagType.create(attrs);
            tr.insert(1, node);
            tr.setSelection(TextSelection.create(tr.doc, 1 + node.nodeSize));
            return true;
        })
        .run();
}

/** 移除编辑器中的模型标签。通过遍历文档查找并删除第一个匹配的模型标签。 */
export function removeModelTag(editor: Editor) {
    editor.commands.command(({ tr, state }: { tr: Transaction; state: EditorState }) => {
        let found = false;
        state.doc.descendants((node, pos) => {
            if (node.type.name === MODEL_TAG_NODE && !found) {
                tr.delete(pos, pos + node.nodeSize);
                found = true;
                return false; // 停止遍历
            }
            return true;
        });
        return found;
    });
}

/**
 * 清空编辑器内容但保留模型标签。
 * 原理：读取当前标签 attrs → setContent 重建仅含标签的最小文档。
 * emitUpdate: true 使外层 onUpdate 回调能感知内容变化。
 */
export function clearEditorPreservingModelTag(editor: Editor) {
    const modelTag = getModelTag(editor);
    if (!modelTag) {
        editor.commands.clearContent(true);
        return;
    }

    editor.commands.setContent(
        {
            type: 'doc',
            content: [
                {
                    type: 'paragraph',
                    content: [
                        {
                            type: MODEL_TAG_NODE,
                            attrs: modelTag,
                        },
                    ],
                },
            ],
        },
        { emitUpdate: true }
    );
    editor.commands.focus('end');
}

// ─── 注册 ────────────────────────────────────────────────────────

registerSearchTag({
    name: MODEL_TAG_NODE,
    kind: 'model',
    node: ModelTagNode,
    collectNodeId: (pmNode) => (pmNode.type.name === MODEL_TAG_NODE ? pmNode.attrs.modelId : null),
});
