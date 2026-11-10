import type { JSONContent } from '@tiptap/core';

import type { InputHistorySnapshot } from '@/types/session';

export type UserMessageInlinePart =
    | {
          type: 'text';
          text: string;
      }
    | {
          type: 'skill';
          name: string;
          path: string;
      };

interface TiptapTextNode {
    type?: string;
    text?: string;
    attrs?: Record<string, unknown>;
    content?: TiptapTextNode[];
}

function isSkillNode(node: TiptapTextNode) {
    return node.type === 'skillTag' || node.type === 'skill-tag';
}

function pushText(parts: UserMessageInlinePart[], text: string) {
    if (!text) {
        return;
    }

    const previous = parts[parts.length - 1];
    if (previous?.type === 'text') {
        previous.text += text;
        return;
    }

    parts.push({
        type: 'text',
        text,
    });
}

function walkInlineNode(node: TiptapTextNode, parts: UserMessageInlinePart[]) {
    if (node.type === 'text') {
        pushText(parts, node.text ?? '');
        return;
    }

    if (isSkillNode(node)) {
        const name = String(node.attrs?.name ?? '');
        const path = String(node.attrs?.path ?? '');
        if (name && path) {
            parts.push({
                type: 'skill',
                name,
                path,
            });
        }
        return;
    }

    if (node.type === 'hardBreak') {
        pushText(parts, '\n');
        return;
    }

    for (const child of node.content ?? []) {
        walkInlineNode(child, parts);
    }
}

function buildPartsFromEditorDoc(editorDoc: JSONContent): UserMessageInlinePart[] {
    const root = editorDoc as TiptapTextNode;
    const parts: UserMessageInlinePart[] = [];
    const blocks = root.content ?? [];

    blocks.forEach((block, index) => {
        if (index > 0) {
            pushText(parts, '\n');
        }
        walkInlineNode(block, parts);
    });

    return parts;
}

export function buildUserMessageInlineParts(
    messageText: string,
    inputSnapshot?: InputHistorySnapshot
): UserMessageInlinePart[] {
    const fallbackText = inputSnapshot?.text ?? messageText;
    if (inputSnapshot?.editorDoc) {
        const parts = buildPartsFromEditorDoc(inputSnapshot.editorDoc);
        const editorText = parts.map((part) => (part.type === 'text' ? part.text : '')).join('');
        if (parts.length && editorText === fallbackText) {
            return parts;
        }
    }

    if (!inputSnapshot?.skills?.length) {
        return fallbackText ? [{ type: 'text', text: fallbackText }] : [];
    }

    const parts: UserMessageInlinePart[] = [];
    pushText(parts, fallbackText);
    for (const skill of inputSnapshot.skills) {
        parts.push({
            type: 'skill',
            name: skill.name,
            path: skill.path,
        });
    }
    return parts;
}
