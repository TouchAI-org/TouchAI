import { webcrypto } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DesktopModelMessage } from '@/adapters/models/input';
import {
    maskDesktopModelMessages,
    prepareUnmaskedPrivacyReplay,
    restorePrivacyChunk,
} from '@/adapters/models/privacy';
import { DEFAULT_PRIVACY_FILTER_SETTINGS } from '@/modules/privacy/public';

const settings = { ...DEFAULT_PRIVACY_FILTER_SETTINGS, enabled: true, useLocalModel: false };
beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => vi.unstubAllGlobals());

describe('given overlapping detections and structured tool arguments', () => {
    it('user sends overlapping custom words and a key then all detected characters stay private and restore exactly', async () => {
        const key = 'sk-' + 'a'.repeat(32);
        const source = `token ${key} token sk-`;
        const result = await maskDesktopModelMessages([{ role: 'user', content: source }], {
            ...settings,
            maskedWords: ['token sk-'],
        });
        const outgoing = String(result.messages[0]!.content);
        expect(outgoing).not.toContain('a'.repeat(32));
        expect(result.session.restoreText(outgoing)).toBe(source);
        expect(result.session.protectionSummary().maskedCount).toBe(2);
    });

    it('user sends quoted private values in nested tool inputs then structure and unrelated values survive masking', async () => {
        const value = 'violet"river\\line\nnext';
        const input = { nested: [value, { token: 'company_abc', count: 4 }], ok: true };
        const source: DesktopModelMessage[] = [
            {
                role: 'assistant',
                content: [{ type: 'tool_use', id: 'call-1', name: 'tool', input }],
                tool_calls: [{ id: 'call-2', name: 'tool', arguments: JSON.stringify(input) }],
            },
        ];
        const before = JSON.stringify(source);
        const result = await maskDesktopModelMessages(source, {
            ...settings,
            maskedWords: [value],
            secretPrefixes: ['company_'],
        });
        const parts = result.messages[0]!.content;
        if (typeof parts === 'string' || parts[0]?.type !== 'tool_use')
            throw new Error('tool input missing');
        const maskedInput = parts[0].input;
        expect(JSON.stringify(maskedInput)).not.toContain('violet');
        expect(JSON.stringify(maskedInput)).not.toContain('company_abc');
        expect(maskedInput).toMatchObject({ nested: [expect.any(String), { count: 4 }], ok: true });
        expect(
            JSON.parse(result.session.restoreToolArguments(JSON.stringify(maskedInput)))
        ).toEqual(input);
        expect(
            JSON.parse(
                result.session.restoreToolArguments(result.messages[0]!.tool_calls![0]!.arguments)
            )
        ).toEqual(input);
        expect(JSON.stringify(source)).toBe(before);
    });

    it('user receives split tool arguments with quotes and newlines then every emitted buffer stays JSON safe and restoration is counted once', async () => {
        const value = 'violet"river\\line\nnext';
        const result = await maskDesktopModelMessages([{ role: 'user', content: value }], {
            ...settings,
            maskedWords: [value],
        });
        const placeholder = String(result.messages[0]!.content);
        const json = JSON.stringify({ value });
        const masked = JSON.stringify({ value: placeholder });
        const buffers = new Map<string, string>();
        let deltas = '';
        let raw = '';
        for (const char of masked) {
            raw += char;
            const chunk = restorePrivacyChunk(
                {
                    content: '',
                    done: false,
                    toolCallDeltas: [
                        { index: 0, callId: 'call-1', argumentsDelta: char, argumentsBuffer: raw },
                    ],
                },
                result.session,
                buffers
            );
            deltas += chunk.toolCallDeltas![0]!.argumentsDelta;
        }
        expect(JSON.parse(deltas)).toEqual(JSON.parse(json));
        const end = restorePrivacyChunk(
            {
                content: '',
                done: true,
                toolCallDeltas: [
                    { index: 0, callId: 'call-1', isComplete: true, argumentsBuffer: masked },
                ],
                toolCalls: [{ id: 'call-1', name: 'tool', arguments: masked }],
            },
            result.session,
            buffers
        );
        expect(JSON.parse(end.toolCallDeltas![0]!.argumentsBuffer!)).toEqual({ value });
        expect(JSON.parse(end.toolCalls![0]!.arguments)).toEqual({ value });
        expect(result.session.restorationSummary().maskedCount).toBe(1);
    });

    it('user receives private values only in reasoning then the restoration record includes that channel separately', async () => {
        const result = await maskDesktopModelMessages(
            [{ role: 'user', content: 'ada@example.test' }],
            settings
        );
        const placeholder = String(result.messages[0]!.content);
        const chunk = restorePrivacyChunk(
            { content: 'Answer', reasoning: placeholder, reasoningState: 'end', done: true },
            result.session,
            new Map()
        );
        expect(chunk.reasoning).toBe('ada@example.test');
        expect(result.session.restorationSummary().maskedCount).toBe(1);
        expect(result.session.restorationDetails().texts).toContain(placeholder);
    });

    it.each([false, true])(
        'user resumes signed private reasoning with exclusion %s then unavailable replay fails before local text can retain the old signature',
        async (excluded) => {
            await expect(
                maskDesktopModelMessages(
                    [
                        {
                            role: 'assistant',
                            content: [
                                {
                                    type: 'reasoning',
                                    text: 'ada@example.test',
                                    providerOptions: {
                                        anthropic: { signature: 'signature-of-original' },
                                    },
                                },
                            ],
                        },
                    ],
                    { ...settings, neverMask: excluded ? ['ada@example.test'] : [] }
                )
            ).rejects.toThrow();
        }
    );

    it('user continues a protected signed reasoning turn then the provider receives its exact signed bytes while local display stays restored', async () => {
        const original = 'ada@example.test';
        const result = await maskDesktopModelMessages(
            [{ role: 'user', content: original }],
            settings
        );
        const placeholder = String(result.messages[0]!.content);
        const providerOptions = { anthropic: { signature: 'protected-signature-for-replay' } };
        const restored = restorePrivacyChunk(
            {
                content: '',
                reasoning: placeholder,
                reasoningState: 'end',
                reasoningProviderOptions: providerOptions,
                done: true,
            },
            result.session,
            new Map()
        );
        expect(restored.reasoning).toBe(original);
        restorePrivacyChunk(
            { content: '', reasoningProviderOptions: providerOptions, done: true },
            result.session,
            new Map()
        );
        const next = await maskDesktopModelMessages(
            [
                { role: 'user', content: original },
                {
                    role: 'assistant',
                    content: [{ type: 'reasoning', text: restored.reasoning!, providerOptions }],
                },
            ],
            settings
        );
        expect(next.messages[1]!.content).toEqual([
            { type: 'reasoning', text: placeholder, providerOptions },
        ]);
        expect(
            prepareUnmaskedPrivacyReplay([
                { role: 'user', content: original },
                {
                    role: 'assistant',
                    content: [{ type: 'reasoning', text: original, providerOptions }],
                },
            ])
        ).toEqual([
            { role: 'user', content: original },
            {
                role: 'assistant',
                content: [{ type: 'reasoning', text: placeholder, providerOptions }],
            },
        ]);
    });
});
