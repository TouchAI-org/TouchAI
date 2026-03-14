/**
 * 附件标签插件。
 * 在搜索栏中显示用户拖入/粘贴的文件（图片缩略图或文件名），
 * 支持多个附件标签并排显示。标签可根据当前模型能力动态置灰。
 */

import { type AttachmentSupportStatus } from '@services/AiService/attachments';
import type { Editor } from '@tiptap/core';
import type { DOMOutputSpec } from '@tiptap/pm/model';
import type { Node as PmNode } from '@tiptap/pm/model';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { TextSelection } from '@tiptap/pm/state';
import { VueNodeViewRenderer } from '@tiptap/vue-3';
import type { Component } from 'vue';

import { createSearchTagNode, createTagCloseButton } from '../factory';
import { registerSearchTag } from '../registry';
import AttachmentTagView from './AttachmentTagView.vue';

export const ATTACHMENT_TAG_NODE = 'attachmentTag';

/** 附件标签节点属性。 */
export interface AttachmentTagAttrs {
    /** 附件唯一标识，关联外层附件数据 */
    attachmentId: string;
    /** 文件名，用于显示和提示 */
    fileName: string;
    /** 文件类型：image 显示缩略图，file 显示文件名 */
    fileType: 'image' | 'file';
    /** 图片预览 URL（convertFileSrc 生成的本地协议地址） */
    preview?: string;
    /** 附件对当前模型的支持状态，用于控制标签置灰显示。仅运行时使用，不序列化到剪贴板。 */
    supportStatus?: AttachmentSupportStatus;
}

const AttachmentTagNode = createSearchTagNode({
    name: ATTACHMENT_TAG_NODE,
    kind: 'attachment',
    parseTag: 'span[data-attachment-tag]',
    addAttributes() {
        return {
            attachmentId: { default: null },
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
        return {
            'data-attachment-tag': '',
            'data-attachment-id': HTMLAttributes.attachmentId || '',
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

/** 在编辑器末尾插入附件标签，并将光标移至新节点之后。 */
export function insertAttachmentTag(editor: Editor, attrs: AttachmentTagAttrs) {
    editor
        .chain()
        .focus('end')
        .command(({ tr, state }: { tr: Transaction; state: EditorState }) => {
            const attachmentTagType = state.schema.nodes.attachmentTag;
            if (!attachmentTagType) return false;
            const node = attachmentTagType.create(attrs);
            const pos = state.selection.to;
            tr.insert(pos, node);
            tr.setSelection(TextSelection.create(tr.doc, pos + node.nodeSize));
            return true;
        })
        .run();
}

/** 按 attachmentId 移除编辑器中的第一个匹配附件标签。 */
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
