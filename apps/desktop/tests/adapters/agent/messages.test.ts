import { describe, expect, it } from 'vitest';

import { createAgentMessageAdapter } from '@/adapters/agent/messages';
import type { DesktopModelMessage as AiMessage } from '@/adapters/models/input';
import { serializeCheckpointBoundary } from '@/modules/agent';

function messages(): AiMessage[] {
    return [
        {
            role: 'system',
            content: 'stored system',
            contextSource: { id: 2, fingerprint: 'system-proof' },
        },
        {
            role: 'user',
            content: 'historical data',
            contextSummary: {
                version: 2,
                id: '4227953b-0ab0-4f65-8ef0-0d985e84a34e',
                text: 'historical data',
                firstKeptMessageId: 9,
                systemMessageIds: [2],
            },
            contextSummaryPartId: 23,
        },
        {
            role: 'user',
            contextSource: { id: 9, fingerprint: 'media-proof' },
            content: [
                {
                    type: 'image',
                    kind: 'image',
                    name: 'fixture.png',
                    data: 'ZmFrZQ==',
                    size: 4,
                    mimeType: 'image/png',
                    semanticIntent: 'visual-reference',
                    sourcePath: '/fixture/cache/image',
                    meta: {
                        alias: 'A1',
                        order: 1,
                        type: 'image',
                        name: 'fixture.png',
                        mimeType: 'image/png',
                        originPath: '/fixture/original/image',
                        attachmentId: 42,
                        hash: 'fixture-hash',
                    },
                },
            ],
        },
    ];
}

describe('given a Desktop task owns stored provenance and media bindings', () => {
    it('user sends an unchanged saved message then its transport copy resolves the same source while edited content cannot reuse that proof', async () => {
        const adapter = createAgentMessageAdapter();
        const source = { id: 41, fingerprint: 'saved-proof' };
        const input: AiMessage = {
            role: 'user',
            content: [{ type: 'text', text: 'Contact ada@example.test' }],
            contextSource: source,
        };
        adapter.toCore([input]);
        expect(await adapter.resolveUserMessageSource(input.content)).toEqual(source);
        input.content = 'Changed';
        expect(await adapter.resolveUserMessageSource(input.content)).toBeUndefined();
        adapter.dispose();
    });

    it('user has identical text saved twice then transport review cannot guess which stored message was sent', async () => {
        const adapter = createAgentMessageAdapter();
        adapter.toCore(
            [41, 42].map((id) => ({
                role: 'user',
                content: 'Same text',
                contextSource: { id, fingerprint: `proof-${id}` },
            }))
        );
        expect(await adapter.resolveUserMessageSource('Same text')).toBeUndefined();
        adapter.dispose();
    });

    it('user compacts an old message out of context then its source proof is released while retained messages still resolve', async () => {
        const adapter = createAgentMessageAdapter();
        const core = adapter.toCore(
            [41, 42].map((id) => ({
                role: 'user',
                content: `Message ${id}`,
                contextSource: { id, fingerprint: `proof-${id}` },
            }))
        );
        adapter.retain([core[1]!]);
        expect(await adapter.resolveUserMessageSource('Message 41')).toBeUndefined();
        expect(await adapter.resolveUserMessageSource('Message 42')).toMatchObject({ id: 42 });
        adapter.dispose();
    });

    it('user keeps opaque Core references while restoring the original stored records at the Desktop boundary', () => {
        const adapter = createAgentMessageAdapter();
        const neutral = adapter.toCore(messages());
        expect(neutral[2]?.origin?.key).not.toBe('9');
        expect(neutral[2]?.origin?.fingerprint).toBe('media-proof');
        expect(neutral[1]?.summary).toMatchObject({
            text: 'historical data',
            systemMessageKeys: [neutral[0]?.origin?.key],
        });
        expect(Object.keys(neutral[1]?.summary ?? {})).not.toContain('version');
        const part = Array.isArray(neutral[2]?.content) ? neutral[2]?.content[0] : undefined;
        expect(part).toMatchObject({ type: 'image', data: 'ZmFrZQ==' });
        expect(Object.keys(part ?? {})).not.toEqual(
            expect.arrayContaining(['meta', 'sourcePath', 'attachmentId'])
        );
        expect(adapter.toDesktop(neutral)).toEqual(messages());
        adapter.dispose();
    });

    it('user cannot resolve another task resource or a disposed resource when changing connections', () => {
        const first = createAgentMessageAdapter();
        const second = createAgentMessageAdapter();
        const neutral = first.toCore(messages());
        expect(() => second.toDesktop([neutral[2]!])).toThrow('RESOURCE_BINDING_NOT_FOUND');
        first.dispose();
        expect(() => first.toDesktop([neutral[2]!])).toThrow('RESOURCE_BINDING_NOT_FOUND');
        second.dispose();
    });

    it('user can rebind the same attachment after a committed context releases its previous transport reference', () => {
        const adapter = createAgentMessageAdapter();
        const source = messages();
        const first = adapter.toCore(source);
        adapter.retain([first[0]!]);
        const rebound = adapter.toCore([source[2]!]);
        expect(adapter.toDesktop(rebound)).toEqual([source[2]]);
        adapter.dispose();
    });

    it('user cannot translate disposed task content or an unknown saved summary reference', () => {
        const adapter = createAgentMessageAdapter();
        expect(() =>
            adapter.toDesktop([
                { role: 'user', content: 'summary', summaryPartKey: 'foreign-part' },
            ])
        ).toThrow('CONTEXT_COMPACTION_FAILED');
        adapter.dispose();
        expect(() => adapter.toCoreContent('text')).toThrow('RESOURCE_BINDING_NOT_FOUND');
        expect(() => adapter.toDesktop([{ role: 'user', content: 'text' }])).toThrow(
            'RESOURCE_BINDING_NOT_FOUND'
        );
    });

    it('user retains the byte-compatible checkpoint boundary without persisting Core messages or opaque routing keys', () => {
        const serialized = serializeCheckpointBoundary({
            activeModel: { id: 7 },
            iteration: 3,
            modelSwitchCount: 1,
            modelLanguageContext: { locale: 'en-US', label: 'English' },
            executedBuiltInToolIds: ['read'],
            response: 'answer',
            reasoning: 'thought',
            outputParts: [{ type: 'text', content: 'answer' }],
        });
        expect(serialized).toBe(
            '{"activeModelId":7,"iteration":3,"modelSwitchCount":1,"modelLanguageContext":{"locale":"en-US","label":"English"},"executedBuiltInToolIds":["read"],"outputBoundary":{"textLength":6,"reasoningLength":7,"partCount":1}}'
        );
    });
});
