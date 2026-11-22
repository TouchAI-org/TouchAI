import { describe, expect, it, vi } from 'vitest';

import { createInputHistorySnapshot } from '@/app/api/agent/history';
import { handoffPromptSnippet } from '@/views/SearchView/composables/promptSnippetHandoff';

const existingSnapshot = createInputHistorySnapshot({
    text: 'Keep this text ',
    attachments: [
        {
            id: 'attachment-1',
            type: 'file',
            path: 'C:\\notes\\brief.txt',
            originPath: 'C:\\notes\\brief.txt',
            name: 'brief.txt',
        },
    ],
    skills: [{ name: 'review', path: 'C:\\skills\\review\\SKILL.md' }],
    editorDoc: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Keep this text ' }] }],
    },
});

describe('given a prompt snippet selection is being handed to the composer', () => {
    it('user choosing with insert-only sees the snippet at the caret and keeps the draft unsent', async () => {
        const insertedBodies: string[] = [];
        const submitted = vi.fn();
        const closePicker = vi.fn().mockResolvedValue(undefined);

        await handoffPromptSnippet({
            body: 'C:\\operator\\summarize-now',
            insertionMode: 'paste_only',
            insertTextAtCursor: (body) => insertedBodies.push(body),
            captureInputSnapshot: () => existingSnapshot,
            closePicker,
            submit: submitted,
        });

        expect(insertedBodies).toEqual(['C:\\operator\\summarize-now']);
        expect(closePicker).toHaveBeenCalledWith({ restoreFocus: true });
        expect(submitted).not.toHaveBeenCalled();
    });

    it('user choosing insert-and-send sees the complete edited draft submitted once', async () => {
        const insertedSnapshot = createInputHistorySnapshot({
            ...existingSnapshot,
            text: `${existingSnapshot.text}C:\\operator\\summarize-now`,
        });
        const submitted = vi.fn().mockResolvedValue(undefined);
        const closePicker = vi.fn().mockResolvedValue(undefined);

        await handoffPromptSnippet({
            body: 'C:\\operator\\summarize-now',
            insertionMode: 'paste_and_send',
            insertTextAtCursor: vi.fn(),
            captureInputSnapshot: () => insertedSnapshot,
            closePicker,
            submit: submitted,
        });

        expect(closePicker).toHaveBeenCalledWith({ restoreFocus: false });
        expect(submitted).toHaveBeenCalledTimes(1);
        expect(submitted).toHaveBeenCalledWith(insertedSnapshot);
        expect(submitted.mock.calls[0]?.[0]).toMatchObject({
            text: 'Keep this text C:\\operator\\summarize-now',
            attachments: existingSnapshot.attachments,
            skills: existingSnapshot.skills,
            editorDoc: existingSnapshot.editorDoc,
        });
    });
});
