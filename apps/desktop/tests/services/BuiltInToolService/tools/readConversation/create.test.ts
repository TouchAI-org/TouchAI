import { describe, expect, it, vi } from 'vitest';

import type { BaseBuiltInToolExecutionContext } from '@/modules/tools';
import {
    createReadConversationTools,
    DEFAULT_READ_CONVERSATION_TOOL_CONFIG,
    type ReadConversationHistory,
    type ReadConversationMessage,
    type ReadConversationSession,
} from '@/modules/tools';

const session: ReadConversationSession = {
    id: 1,
    session_id: 'session-1',
    title: 'Release checklist',
    model: 'model-a',
    created_at: '2026-01-01 00:00:00',
    archived: false,
};

function message(id: number, role: 'user' | 'assistant', content: string): ReadConversationMessage {
    return { id, role, created_at: `2026-01-01 00:00:0${id}`, content };
}

function output(result: { result: string }) {
    return JSON.parse(result.result) as {
        session: { session_id: string; title: string; model: string; archived: boolean };
        messages: Array<{
            message_id: number;
            role: string;
            text: string;
            truncated: boolean;
        }>;
        next_cursor: { message_id: number; direction: 'before' | 'after' } | null;
        has_more: boolean;
    };
}

function fixture(
    input: {
        session?: ReadConversationSession | null;
        messages?: ReadConversationMessage[];
    } = {}
) {
    const findSession = vi.fn<ReadConversationHistory['findSession']>(async () =>
        input.session === undefined ? session : input.session
    );
    const listMessages = vi.fn<ReadConversationHistory['listMessages']>(async (options) => {
        let rows = (input.messages ?? []).filter((entry) => options.roles.includes(entry.role));
        if (options.anchorId !== undefined) {
            rows =
                options.direction === 'before'
                    ? rows.filter((entry) => entry.id < options.anchorId!)
                    : rows.filter((entry) => entry.id > options.anchorId!);
        }
        const ordered = options.direction === 'before' ? [...rows].reverse() : rows;
        const page = ordered.slice(0, options.limit);
        return options.direction === 'before' ? page.reverse() : page;
    });
    const hasMessage = vi.fn<ReadConversationHistory['hasMessage']>(async (_sessionId, messageId) =>
        (input.messages ?? []).some((entry) => entry.id === messageId)
    );
    const history: ReadConversationHistory = { findSession, listMessages, hasMessage };

    const [descriptor] = createReadConversationTools({
        messages: {
            t: (key, params) => (params ? `${key} ${Object.values(params).join(' ')}` : key),
            tt: (text) => text,
        },
        history,
    });
    if (!descriptor) throw new Error('Missing conversation read descriptor');

    async function execute(
        args: Record<string, unknown>,
        options: { config?: { enabled: boolean }; signal?: AbortSignal } = {}
    ) {
        const config = options.config ?? DEFAULT_READ_CONVERSATION_TOOL_CONFIG;
        const context: BaseBuiltInToolExecutionContext = {
            callId: 'call',
            iteration: 1,
            signal: options.signal,
        };
        return descriptor!.execute(args, config, context);
    }

    return { execute, findSession, listMessages, hasMessage };
}

describe('given the conversation read builtin pages one session', () => {
    it('user reads the newest messages with session metadata by default', async () => {
        const { execute } = fixture({
            messages: [
                message(1, 'user', 'first'),
                message(2, 'assistant', 'second'),
                message(3, 'user', 'third'),
            ],
        });

        const result = await execute({ session_id: 'session-1' });
        const parsed = output(result);

        expect(result).toMatchObject({ isError: false, status: 'success' });
        expect(parsed.session).toMatchObject({
            session_id: 'session-1',
            title: 'Release checklist',
            archived: false,
        });
        expect(parsed.messages.map((entry) => entry.message_id)).toEqual([1, 2, 3]);
        expect(parsed.next_cursor).toBeNull();
        expect(parsed.has_more).toBe(false);
    });

    it('user walks toward older messages with the returned cursor', async () => {
        const { execute } = fixture({
            messages: [1, 2, 3, 4, 5].map((id) =>
                message(id, id % 2 === 0 ? 'assistant' : 'user', `message ${id}`)
            ),
        });

        const first = output(await execute({ session_id: 'session-1', limit: 2 }));
        expect(first.messages.map((entry) => entry.message_id)).toEqual([4, 5]);
        expect(first.has_more).toBe(true);
        expect(first.next_cursor).toEqual({ message_id: 4, direction: 'before' });

        const second = output(
            await execute({
                session_id: 'session-1',
                limit: 2,
                message_id: first.next_cursor!.message_id,
            })
        );
        expect(second.messages.map((entry) => entry.message_id)).toEqual([2, 3]);
        expect(second.next_cursor).toEqual({ message_id: 2, direction: 'before' });

        const third = output(
            await execute({
                session_id: 'session-1',
                limit: 2,
                message_id: second.next_cursor!.message_id,
            })
        );
        expect(third.messages.map((entry) => entry.message_id)).toEqual([1]);
        expect(third.has_more).toBe(false);
        expect(third.next_cursor).toBeNull();
    });

    it('user walks toward newer messages after an anchor', async () => {
        const { execute } = fixture({
            messages: [1, 2, 3, 4, 5].map((id) => message(id, 'user', `message ${id}`)),
        });

        const parsed = output(
            await execute({
                session_id: 'session-1',
                message_id: 2,
                direction: 'after',
                limit: 2,
            })
        );

        expect(parsed.messages.map((entry) => entry.message_id)).toEqual([3, 4]);
        expect(parsed.has_more).toBe(true);
        expect(parsed.next_cursor).toEqual({ message_id: 4, direction: 'after' });
    });

    it('user sees per-message truncation when the character cap applies', async () => {
        const { execute } = fixture({
            messages: [message(1, 'user', 'a'.repeat(60))],
        });

        const parsed = output(
            await execute({ session_id: 'session-1', max_chars_per_message: 50 })
        );

        expect(parsed.messages[0]).toMatchObject({
            message_id: 1,
            text: 'a'.repeat(50),
            truncated: true,
        });
    });

    it('user only receives the selected role', async () => {
        const { execute } = fixture({
            messages: [message(1, 'user', 'asked'), message(2, 'assistant', 'answered')],
        });

        const parsed = output(await execute({ session_id: 'session-1', role: 'assistant' }));

        expect(parsed.messages.map((entry) => entry.role)).toEqual(['assistant']);
    });

    it('user gets a readable error for an unknown session', async () => {
        const { execute, listMessages } = fixture({ session: null });

        const result = await execute({ session_id: 'missing' });

        expect(result).toMatchObject({ isError: true, status: 'error' });
        expect(result.result).toContain('builtInTools.readConversation.notFound');
        expect(listMessages).not.toHaveBeenCalled();
    });

    it('user gets a readable disabled error without touching conversation data', async () => {
        const { execute, findSession, listMessages } = fixture();

        const result = await execute({ session_id: 'session-1' }, { config: { enabled: false } });

        expect(result).toMatchObject({ isError: true, status: 'error' });
        expect(result.result).toContain('builtInTools.readConversation.disabled');
        expect(findSession).not.toHaveBeenCalled();
        expect(listMessages).not.toHaveBeenCalled();
    });

    it('user walks every older page without gaps when the byte budget splits a long conversation', async () => {
        const messages = Array.from({ length: 20 }, (_, index) =>
            message(index + 1, index % 2 === 0 ? 'user' : 'assistant', '会'.repeat(1500))
        );
        const { execute } = fixture({ messages });

        const seen: number[] = [];
        let anchor: number | undefined;
        for (let page = 0; page < 20; page += 1) {
            const parsed = output(
                await execute(
                    anchor === undefined
                        ? { session_id: 'session-1', limit: 20 }
                        : { session_id: 'session-1', limit: 20, message_id: anchor }
                )
            );
            expect(parsed.messages.map((entry) => entry.message_id)).toEqual(
                [...parsed.messages.map((entry) => entry.message_id)].sort(
                    (left, right) => left - right
                )
            );
            seen.push(...parsed.messages.map((entry) => entry.message_id));
            if (!parsed.has_more) break;
            expect(parsed.next_cursor?.direction).toBe('before');
            anchor = parsed.next_cursor!.message_id;
        }

        expect([...seen].sort((left, right) => left - right)).toEqual(
            Array.from({ length: 20 }, (_, index) => index + 1)
        );
    });

    it('user walks every newer page without gaps when the byte budget splits a long conversation', async () => {
        const messages = Array.from({ length: 20 }, (_, index) =>
            message(index + 1, 'user', '会'.repeat(1500))
        );
        const { execute } = fixture({ messages });

        const seen: number[] = [];
        let anchor = 1;
        for (let page = 0; page < 20; page += 1) {
            const parsed = output(
                await execute({
                    session_id: 'session-1',
                    limit: 20,
                    message_id: anchor,
                    direction: 'after',
                })
            );
            seen.push(...parsed.messages.map((entry) => entry.message_id));
            if (!parsed.has_more) break;
            expect(parsed.next_cursor?.direction).toBe('after');
            anchor = parsed.next_cursor!.message_id;
        }

        expect(seen).toEqual(Array.from({ length: 19 }, (_, index) => index + 2));
    });

    it('user receives at most 50 KiB even with escaped text and a very long title', async () => {
        const { execute } = fixture({
            session: { ...session, title: 'T'.repeat(60_000) },
            messages: [message(1, 'user', '\u0001'.repeat(10_000))],
        });

        const result = await execute({
            session_id: 'session-1',
            max_chars_per_message: 8000,
        });
        const parsed = output(result);

        expect(new TextEncoder().encode(result.result).length).toBeLessThanOrEqual(50 * 1024);
        expect(parsed.session.title.length).toBeLessThanOrEqual(201);
        expect(parsed.messages[0]?.truncated).toBe(true);
        expect(parsed.messages).toHaveLength(1);
        expect(parsed.has_more).toBe(false);
        expect(parsed.next_cursor).toBeNull();
    });

    it('user receives at most 50 KiB when the stored model id is oversized', async () => {
        const { execute } = fixture({
            session: { ...session, model: 'M'.repeat(60_000) },
            messages: [message(1, 'user', 'hello')],
        });

        const result = await execute({ session_id: 'session-1' });
        const parsed = output(result);

        expect(result).toMatchObject({ isError: false, status: 'success' });
        expect(new TextEncoder().encode(result.result).length).toBeLessThanOrEqual(50 * 1024);
        expect(parsed.session.model.length).toBeLessThanOrEqual(65);
        expect(parsed.messages.map((entry) => entry.message_id)).toEqual([1]);
    });

    it('user gets a readable error when the anchor belongs to another conversation', async () => {
        const { execute, listMessages } = fixture({
            messages: [message(1, 'user', 'first')],
        });

        const result = await execute({ session_id: 'session-1', message_id: 999 });

        expect(result).toMatchObject({ isError: true, status: 'error' });
        expect(result.result).toContain('builtInTools.readConversation.invalidAnchor');
        expect(listMessages).not.toHaveBeenCalled();
    });
});
