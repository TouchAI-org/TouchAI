// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { AttachmentIndex } from '@services/AgentService/infrastructure/attachments';
import {
    buildPromptAttachmentSlots,
    buildPromptTransportMessages,
} from '@services/AgentService/prompt/transport';
import type { PromptSnapshot } from '@services/AgentService/prompt/types';
import { describe, expect, it } from 'vitest';

function snapshot(overrides: Partial<PromptSnapshot> = {}): PromptSnapshot {
    return { systemPrompt: '', userPrompt: '', ...overrides } as PromptSnapshot;
}

function attachment(name: string, offset?: number): AttachmentIndex {
    return {
        id: name,
        type: 'image',
        path: `C:/tmp/${name}`,
        originPath: `C:/tmp/${name}`,
        name,
        supportStatus: 'supported',
        ...(offset === undefined ? {} : { draftInsertionOffset: offset }),
    };
}

describe('user writes a prompt with pasted attachments', () => {
    it('user sees the text split around each pasted attachment in draft order', () => {
        const slots = buildPromptAttachmentSlots('look at these two', [
            attachment('b.png', 13),
            attachment('a.png', 5),
        ]);

        expect(
            slots.map((slot) => (slot.type === 'text' ? slot.text : slot.attachment.name))
        ).toEqual(['look ', 'a.png', 'at these', 'b.png', ' two']);
    });

    it('user sees attachments without a draft position placed after the text', () => {
        const slots = buildPromptAttachmentSlots('describe', [attachment('a.png')]);

        expect(slots.map((slot) => slot.type)).toEqual(['text', 'attachment']);
        expect(slots[0]).toEqual({ type: 'text', text: 'describe' });
    });

    it('user sees a pasted position beyond the text clamped to the end', () => {
        const slots = buildPromptAttachmentSlots('hi', [attachment('a.png', 99)]);

        expect(slots.map((slot) => slot.type)).toEqual(['text', 'attachment']);
        expect(slots[0]).toEqual({ type: 'text', text: 'hi' });
    });

    it('user sees an attachment pasted at the very start kept before the text', () => {
        const slots = buildPromptAttachmentSlots('after the image', [attachment('a.png', 0)]);

        expect(slots.map((slot) => slot.type)).toEqual(['attachment', 'text']);
        expect(slots[1]).toEqual({ type: 'text', text: 'after the image' });
    });
});

describe('user sends a prompt to the model', () => {
    it('user sees the system prompt and their message in order', async () => {
        const messages = await buildPromptTransportMessages({
            snapshot: snapshot({ systemPrompt: 'You are TouchAI.', userPrompt: 'hello' }),
        });

        expect(messages).toEqual([
            { role: 'system', content: 'You are TouchAI.' },
            { role: 'user', content: 'hello' },
        ]);
    });

    it('user sees no system message when there is no system prompt', async () => {
        const messages = await buildPromptTransportMessages({
            snapshot: snapshot({ userPrompt: 'hello' }),
        });

        expect(messages.map((message) => message.role)).toEqual(['user']);
    });

    it('user sees a placeholder instead of an empty message when they send nothing', async () => {
        const messages = await buildPromptTransportMessages({ snapshot: snapshot() });

        expect(messages).toEqual([{ role: 'user', content: 'no prompt' }]);
    });

    it('user does not have an image the model cannot read sent with the prompt', async () => {
        const messages = await buildPromptTransportMessages({
            snapshot: snapshot({ userPrompt: 'what is this' }),
            attachments: [attachment('a.png')],
            supportsAttachments: false,
        });

        // The text is sent on its own; the unreadable image never reaches the model.
        expect(messages[0]).toEqual({ role: 'user', content: 'what is this' });
    });
});
