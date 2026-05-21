/**
 * 附件标签插件。
 * 在搜索栏中显示用户拖入/粘贴的文件（图片缩略图或文件名），
 * 支持多个附件标签并排显示。标签可根据当前模型能力动态置灰。
 */

import type { Editor } from '@tiptap/core';
import type { DOMOutputSpec } from '@tiptap/pm/model';
import type { Node as PmNode } from '@tiptap/pm/model';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { TextSelection } from '@tiptap/pm/state';
import { VueNodeViewRenderer } from '@tiptap/vue-3';
import type { Component } from 'vue';

import { type AttachmentSupportStatus } from '@/services/AgentService/infrastructure/attachments';

import { createSearchTagNode, createTagCloseButton } from '../factory';
import { isRegisteredTagNode, registerSearchTag } from '../registry';
import AttachmentTagView from './AttachmentTagView.vue';

export const ATTACHMENT_TAG_NODE = 'attachmentTag';

/**
 * 附件标签节点属性。
 */
export interface AttachmentTagAttrs {
    /**
     * 附件唯一标识，关联外层附件数据
     */
    attachmentId: string;
    /**
     * 当前输入内提供给模型使用的顺序别名。
     */
    alias: string;
    /**
     * 文件名，用于显示和提示
     */
    fileName: string;
    /**
     * 文件类型：image 显示缩略图，file 显示文件名
     */
    fileType: 'image' | 'file';
    /**
     * 图片预览 URL（convertFileSrc 生成的本地协议地址）
     */
    preview?: string;
    /**
     * 附件对当前模型的支持状态，用于控制标签置灰显示。仅运行时使用，不序列化到剪贴板。
     */
    supportStatus?: AttachmentSupportStatus;
}

const AttachmentTagNode = createSearchTagNode({
    name: ATTACHMENT_TAG_NODE,
    kind: 'attachment',
    parseTag: 'span[data-attachment-tag]',
    addAttributes() {
        return {
            attachmentId: { default: null },
            alias: { default: null },
            fileName: { default: null },
            fileType: { default: 'file' },
            preview: { default: null },
            // renderHTML 返回空对象，使 supportStatus 不输出到剪贴板 HTML，
            // 因为它是运行时状态（依赖当前模型能力），粘贴后应重新计算。
            supportStatus: { default: 'supported', renderHTML: () => ({}) },
        };
    },
    getRootAttributes(HTMLAttributes) {
        const isImage = HTMLAttributes.fileType === 'image';
        const name = HTMLAttributes.fileName || 'file';
        const alias = HTMLAttributes.alias || '';
        return {
            'data-attachment-tag': '',
            'data-attachment-id': HTMLAttributes.attachmentId || '',
            'data-attachment-alias': alias,
            class: isImage ? 'search-tag-chip--image' : '',
            title: name,
        };
    },
    renderChildren(HTMLAttributes) {
        const isImage = HTMLAttributes.fileType === 'image';
        const name = HTMLAttributes.fileName || 'file';
        // 文件名超过 12 字符时截断为 10 字符 + 省略号，防止标签过宽
        const truncated = name.length > 12 ? name.slice(0, 10) + '…' : name;

        const children: DOMOutputSpec[] = [];

        if (HTMLAttributes.preview) {
            children.push([
                'img',
                {
                    src: HTMLAttributes.preview,
                    class: 'attachment-tag-preview',
                    alt: name,
                },
            ]);
        }

        if (!isImage) {
            children.push([
                'span',
                { class: 'search-tag-label search-tag-label--attachment' },
                truncated,
            ]);
        }

        children.push(createTagCloseButton('attachment'));
        return children;
    },
    addNodeView: () => VueNodeViewRenderer(AttachmentTagView as Component),
});

// ─── CRUD ────────────────────────────────────────────────────────

interface InsertAttachmentTagOptions {
    textOffset?: number;
    sameOffsetIndex?: number;
}

/**
 * 插入附件标签；剪贴板 mixed payload 可通过 textOffset 保持原 HTML 位置。
 */
export function insertAttachmentTag(
    editor: Editor,
    attrs: AttachmentTagAttrs,
    options: InsertAttachmentTagOptions = {}
) {
    const chain = editor.chain().focus(typeof options.textOffset === 'number' ? undefined : 'end');

    chain
        .command(({ tr, state }: { tr: Transaction; state: EditorState }) => {
            const attachmentTagType = state.schema.nodes.attachmentTag;
            if (!attachmentTagType) return false;
            const node = attachmentTagType.create(attrs);
            const pos = resolveAttachmentTagInsertPosition(state, options);
            tr.insert(pos, node);
            tr.setSelection(TextSelection.create(tr.doc, pos + node.nodeSize));
            return true;
        })
        .run();
}

/**
 * 解析附件标签应该插入的编辑器位置。
 */
function resolveAttachmentTagInsertPosition(
    state: EditorState,
    options: InsertAttachmentTagOptions
) {
    // 普通附件仍跟随当前光标；mixed payload 才按纯文本 offset 定位。
    if (typeof options.textOffset !== 'number') {
        return state.selection.to;
    }

    const basePosition = resolveTextOffsetPosition(state, options.textOffset);
    return advancePastInlineTagsAtPosition(state, basePosition, options.sameOffsetIndex ?? 0);
}

/**
 * 将纯文本 offset 解析为 ProseMirror 文档位置。
 */
function resolveTextOffsetPosition(state: EditorState, textOffset: number) {
    const targetOffset = Math.max(0, Math.floor(textOffset));
    const { doc } = state;
    let consumedText = 0;
    let nodePos = 0;

    //1. ProseMirror position 包含段落边界，这里把纯文本 offset 映射回文档 position。
    for (let index = 0; index < doc.childCount; index += 1) {
        const node = doc.child(index);
        const nodeStart = nodePos + 1;
        const textLength = node.textContent.length;
        if (targetOffset <= consumedText + textLength) {
            return resolveTextOffsetInsideNode(node, nodeStart, targetOffset - consumedText);
        }

        consumedText += textLength;
        const nextNodePos = nodePos + node.nodeSize;

        if (index < doc.childCount - 1) {
            //2. 段落之间按一个换行计入 offset，对齐 clipboardDraft 合并文本后的语义。
            if (targetOffset <= consumedText + 1) {
                return targetOffset === consumedText
                    ? nodeStart + node.content.size
                    : nextNodePos + 1;
            }
            consumedText += 1;
        }

        nodePos = nextNodePos;
    }

    return Math.max(1, doc.content.size - 1);
}

/**
 * 将纯文本 offset 解析到单个文档节点内部。
 */
function resolveTextOffsetInsideNode(node: PmNode, nodeStart: number, textOffset: number) {
    let remainingText = Math.max(0, textOffset);
    let childOffset = 0;

    for (let index = 0; index < node.childCount; index += 1) {
        const child = node.child(index);
        const childPos = nodeStart + childOffset;

        if (child.isText) {
            const length = child.text?.length ?? 0;
            if (remainingText <= length) {
                return childPos + remainingText;
            }
            remainingText -= length;
        } else if (child.type.name === 'hardBreak') {
            if (remainingText === 0) {
                return childPos;
            }
            remainingText -= 1;
        }

        childOffset += child.nodeSize;
    }

    return nodeStart + node.content.size;
}

/**
 * 从指定位置跳过已存在的连续内联标签。
 */
function advancePastInlineTagsAtPosition(state: EditorState, position: number, tagCount: number) {
    let currentPosition = position;
    let skippedTags = 0;

    // 同一个文本 offset 可能对应多张连续图片，按已插入数量跳过已有标签。
    while (skippedTags < tagCount) {
        const nodeAfter = state.doc.resolve(currentPosition).nodeAfter;
        if (!nodeAfter || !isRegisteredTagNode(nodeAfter)) {
            break;
        }

        currentPosition += nodeAfter.nodeSize;
        skippedTags += 1;
    }

    return currentPosition;
}

/**
 * 按 attachmentId 移除编辑器中的第一个匹配附件标签。
 */
export function removeAttachmentTag(editor: Editor, attachmentId: string) {
    editor.commands.command(({ tr, state }: { tr: Transaction; state: EditorState }) => {
        let found = false;
        state.doc.descendants((node: PmNode, pos: number) => {
            if (
                node.type.name === ATTACHMENT_TAG_NODE &&
                node.attrs.attachmentId === attachmentId &&
                !found
            ) {
                tr.delete(pos, pos + node.nodeSize);
                found = true;
            }
        });
        return found;
    });
}

/**
 * 读取编辑器中的全部附件标签属性。
 */
export function getAttachmentTags(editor: Editor): AttachmentTagAttrs[] {
    const tags: AttachmentTagAttrs[] = [];

    editor.state.doc.descendants((node: PmNode) => {
        if (node.type.name !== ATTACHMENT_TAG_NODE) {
            return true;
        }

        tags.push({
            attachmentId: node.attrs.attachmentId,
            alias: node.attrs.alias,
            fileName: node.attrs.fileName,
            fileType: node.attrs.fileType,
            preview: node.attrs.preview ?? undefined,
            supportStatus: node.attrs.supportStatus,
        });

        return true;
    });

    return tags;
}

/**
 * 按 attachmentId 原位更新附件标签属性。
 */
export function updateAttachmentTag(editor: Editor, attrs: AttachmentTagAttrs) {
    editor.commands.command(({ tr, state }: { tr: Transaction; state: EditorState }) => {
        let updated = false;

        state.doc.descendants((node: PmNode, pos: number) => {
            if (
                node.type.name !== ATTACHMENT_TAG_NODE ||
                node.attrs.attachmentId !== attrs.attachmentId ||
                updated
            ) {
                return true;
            }

            tr.setNodeMarkup(pos, undefined, {
                ...node.attrs,
                ...attrs,
            });
            updated = true;
            return false;
        });

        return updated;
    });
}

/**
 * 根据模型能力批量更新编辑器中所有附件标签的 supportStatus。
 * 使用「先收集再批量应用」模式：遍历文档收集需要更新的节点，
 * 然后在单次事务中通过 setNodeMarkup 修改属性。
 * 原子节点的 nodeSize 不随属性变化，因此位置映射始终稳定。
 */
export function updateAttachmentTagsSupport(
    editor: Editor,
    capabilities: { supportsImages: boolean; supportsFiles: boolean }
) {
    editor.commands.command(({ tr, state }: { tr: Transaction; state: EditorState }) => {
        const updates: { pos: number; attrs: Record<string, unknown> }[] = [];

        state.doc.descendants((node: PmNode, pos: number) => {
            if (node.type.name !== ATTACHMENT_TAG_NODE) return;
            const fileType = node.attrs.fileType;
            let status: AttachmentSupportStatus = 'supported';
            if (fileType === 'image' && !capabilities.supportsImages) {
                status = 'unsupported-image';
            } else if (fileType === 'file' && !capabilities.supportsFiles) {
                status = 'unsupported-file';
            }
            if (node.attrs.supportStatus !== status) {
                updates.push({ pos, attrs: { ...node.attrs, supportStatus: status } });
            }
        });

        for (const { pos, attrs } of updates) {
            tr.setNodeMarkup(pos, undefined, attrs);
        }
        return updates.length > 0;
    });
}

// ─── 注册 ────────────────────────────────────────────────────────

registerSearchTag({
    name: ATTACHMENT_TAG_NODE,
    kind: 'attachment',
    node: AttachmentTagNode,
    collectNodeId: (pmNode) =>
        pmNode.type.name === ATTACHMENT_TAG_NODE ? pmNode.attrs.attachmentId : null,
});
