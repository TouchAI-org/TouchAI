import type { Editor } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import type { Node as PmNode } from '@tiptap/pm/model';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { TextSelection } from '@tiptap/pm/state';
import { VueNodeViewRenderer } from '@tiptap/vue-3';
import type { Component } from 'vue';

import type { SelectedSkill } from '@/services/AgentService/skills';
import { normalizeSkillPath } from '@/services/AgentService/skills/path';

import { appendTagSeparator, createSearchTagNode } from '../factory';
import { registerSearchTag } from '../registry';
import SkillTagView from './SkillTagView.vue';

export const SKILL_TAG_NODE = 'skillTag';

export type SkillTagAttrs = SelectedSkill;

const SkillTagNode = createSearchTagNode({
    name: SKILL_TAG_NODE,
    kind: 'skill',
    parseTag: 'span[data-skill-tag]',
    addAttributes() {
        return {
            name: { default: null },
            path: { default: null },
        };
    },
    getRootAttributes(HTMLAttributes) {
        return {
            'data-skill-tag': '',
            'data-skill-name': HTMLAttributes.name || '',
            'data-skill-path': HTMLAttributes.path || '',
            title: HTMLAttributes.name || '',
        };
    },
    renderChildren(HTMLAttributes) {
        return [
            ['span', { class: 'search-tag-icon search-tag-icon--skill' }, ''],
            [
                'span',
                { class: 'search-tag-label search-tag-label--skill' },
                HTMLAttributes.name || '',
            ],
        ];
    },
    addNodeView: () => VueNodeViewRenderer(SkillTagView as Component),
});

export function insertSkillTag(
    editor: Editor,
    attrs: SkillTagAttrs,
    triggerToken?: string,
    triggerSuffix = ''
) {
    const inserted = editor
        .chain()
        .focus()
        .command(({ tr, state }: { tr: Transaction; state: EditorState }) => {
            const skillTagType = state.schema.nodes.skillTag;
            if (!skillTagType) return false;

            const { from, to, empty } = state.selection;
            const pos = triggerToken ? from - triggerToken.length : from;
            const end = triggerToken ? to + triggerSuffix.length : to;
            if (
                pos < 1 ||
                end > state.doc.content.size ||
                (triggerToken &&
                    (!empty ||
                        state.doc.textBetween(pos, end, '\n', '\ufffc') !==
                            triggerToken + triggerSuffix))
            )
                return false;
            const node = skillTagType.create(attrs);
            closeHistory(tr);
            tr.replaceWith(pos, end, node);
            const cursor = triggerToken
                ? appendTagSeparator(tr, pos + node.nodeSize)
                : pos + node.nodeSize;
            tr.setSelection(TextSelection.create(tr.doc, cursor));
            return true;
        })
        .run();
    if (inserted) editor.view.dispatch(closeHistory(editor.state.tr));
}

export function getSkillTags(editor: Editor): SkillTagAttrs[] {
    const tags: SkillTagAttrs[] = [];
    const seenPaths = new Set<string>();

    editor.state.doc.descendants((node: PmNode) => {
        if (node.type.name !== SKILL_TAG_NODE) {
            return true;
        }

        const path = String(node.attrs.path || '');
        if (!path || seenPaths.has(normalizeSkillPath(path))) {
            return true;
        }

        seenPaths.add(normalizeSkillPath(path));
        tags.push({
            name: String(node.attrs.name || ''),
            path,
        });
        return true;
    });

    return tags;
}

registerSearchTag({
    name: SKILL_TAG_NODE,
    kind: 'skill',
    node: SkillTagNode,
    collectNodeId: (pmNode) =>
        pmNode.type.name === SKILL_TAG_NODE ? String(pmNode.attrs.path || '') || null : null,
});
