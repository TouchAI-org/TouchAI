import { webcrypto } from 'node:crypto';

import type { AiStreamChunk } from '@touchai/models/contracts';
import { OpenAICompatibleProviderAdapter } from '@touchai/models/providers/openai-compatible';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DesktopModelRequest as AiRequestOptions } from '@/adapters/models/input';
import { prepareModelRequest } from '@/adapters/models/transport';
import { createDesktopPrivacyStream } from '@/app/workflows/agent/privacy';
import { createPrivacyReview, hashPrivacyText } from '@/modules/privacy';

import { createSettingsWindowFixture } from '../utils/settingsWindow';
import { getTauriInvokeCalls, mockTauriCommand } from '../utils/tauri';
const review = createPrivacyReview();
const { clearPrivacyReview, selectPrivacyAnnotations } = review;
let fixture: ReturnType<typeof createSettingsWindowFixture>;
const httpFetch = vi.fn();

const original = 'ada@example.test';
const text = `Contact ${original}.`;
const request: AiRequestOptions = {
    model: 'controlled-model',
    messages: [
        { role: 'user', content: text, contextSource: { id: 41, fingerprint: 'a'.repeat(64) } },
    ],
};

function adapter() {
    return new OpenAICompatibleProviderAdapter(
        { apiEndpoint: 'https://controlled.test/v1' },
        {
            fetch: httpFetch,
            remoteRefs: { read: async () => null, touch: async () => {}, write: async () => {} },
        }
    );
}

function response(placeholder: string): Response {
    const pieces = [placeholder.slice(0, 9), placeholder.slice(9)];
    const events = [
        ...pieces.map((content) => ({
            choices: [{ index: 0, delta: { content }, finish_reason: null }],
        })),
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ];
    return new Response(
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } }
    );
}

async function consume(options = request): Promise<AiStreamChunk[]> {
    const chunks: AiStreamChunk[] = [];
    const protect = createDesktopPrivacyStream({
        settings: fixture.window.privacySettings,
        review,
        context: () => ({ sessionId: 7, modelName: 'controlled-model' }),
        restored: () => {},
    });
    for await (const chunk of protect(options, (request) =>
        adapter().stream(
            prepareModelRequest(request, {
                driver: 'openai-compatible',
                providerId: 1,
                resourceKey: () => undefined,
            })
        )
    ))
        chunks.push(chunk);
    return chunks;
}

function outgoingPlaceholder(init: RequestInit): string {
    const body = JSON.parse(String(init.body)) as { messages: Array<{ content: string }> };
    const outgoing = body.messages[0]!.content;
    expect(outgoing).not.toContain(original);
    const placeholder = outgoing.match(/\{\{EMAIL_[0-9a-f]{16}\}\}/)?.[0];
    expect(placeholder).toBeDefined();
    return placeholder!;
}

async function setFailureAction(action: 'fallback-rules' | 'send-original') {
    fixture.values.set('privacy_filter_failure_action', action);
    await fixture.owner.api.refresh();
}

async function failLocalModel() {
    await fixture.window.privacySettings.updatePrivacyFilterSettings({
        ...fixture.window.privacySettings.getPrivacyFilterSettings(),
        useLocalModel: true,
    });
    mockTauriCommand('privacy_filter_model_status', { installed: true });
    mockTauriCommand('privacy_filter_detect', () => {
        throw new Error('Local detection unavailable');
    });
}

beforeEach(async () => {
    mockTauriCommand('privacy_filter_record_generation', 0);
    httpFetch.mockReset();
    vi.stubGlobal('crypto', webcrypto);
    clearPrivacyReview();
    fixture = createSettingsWindowFixture();
    await fixture.initialize();
    await fixture.window.privacySettings.updatePrivacyFilterSettings({
        ...fixture.window.privacySettings.getPrivacyFilterSettings(),
        enabled: true,
        useLocalModel: false,
    });
});
afterEach(() => {
    fixture.dispose();
    clearPrivacyReview();
    vi.unstubAllGlobals();
});

describe('given protected text passes through the installed provider SDK', () => {
    it('user receives a masked response then the exact sent placeholder is reviewable and the reply is restored across chunks', async () => {
        let placeholder = '';
        httpFetch.mockImplementation(async (_url: string, init: RequestInit) => {
            placeholder = outgoingPlaceholder(init);
            return response(placeholder);
        });

        const chunks = await consume();
        const annotations = selectPrivacyAnnotations(41, text, await hashPrivacyText(text));

        expect(chunks.map((chunk) => chunk.content).join('')).toBe(original);
        expect(annotations).toEqual([
            expect.objectContaining({
                messageId: 41,
                start: text.indexOf(original),
                end: text.indexOf(original) + original.length,
                original,
                placeholder,
                kind: 'email',
                rule: { id: 'email' },
            }),
        ]);
        expect(selectPrivacyAnnotations(42, text, await hashPrivacyText(text))).toEqual([]);
    });

    it('user chooses original sending on masking failure then an offline provider never receives an unmasked retry', async () => {
        await setFailureAction('send-original');
        httpFetch.mockImplementation(async (_url: string, init: RequestInit) => {
            outgoingPlaceholder(init);
            throw new Error('Controlled provider is offline');
        });

        await expect(consume()).rejects.toThrow('Controlled provider is offline');

        expect(httpFetch).toHaveBeenCalledTimes(1);
        expect(review.getReviewSnapshot().annotations).toEqual([]);
    });

    it('user cancels before the network request then no value claims masking protection', async () => {
        const controller = new AbortController();
        controller.abort();

        await expect(consume({ ...request, signal: controller.signal })).rejects.toMatchObject({
            name: 'AbortError',
        });

        expect(httpFetch).not.toHaveBeenCalled();
        expect(review.getReviewSnapshot().annotations).toEqual([]);
    });

    it('user clears review while the provider is responding then cleared mappings stay gone but the active reply still restores', async () => {
        httpFetch.mockImplementation(async (_url: string, init: RequestInit) => {
            const placeholder = outgoingPlaceholder(init);
            clearPrivacyReview();
            return response(placeholder);
        });

        const chunks = await consume();

        expect(chunks.map((chunk) => chunk.content).join('')).toBe(original);
        expect(review.getReviewSnapshot().annotations).toEqual([]);
    });
});

describe('given the local detector cannot finish masking', () => {
    it('user chooses original sending with unavailable signed replay then detector failure still blocks the invalid signed request', async () => {
        await setFailureAction('send-original');
        await failLocalModel();
        httpFetch.mockResolvedValue(response('reply'));

        await expect(
            consume({
                ...request,
                messages: [
                    ...request.messages,
                    {
                        role: 'assistant',
                        content: [
                            {
                                type: 'reasoning',
                                text: original,
                                providerOptions: {
                                    anthropic: { signature: 'unavailable-protocol-replay' },
                                },
                            },
                        ],
                    },
                ],
            })
        ).rejects.toMatchObject({ code: 'PRIVACY_REPLAY_BLOCKED' });
        expect(httpFetch).not.toHaveBeenCalled();
    });
    it('user clears history before the first response then old request details cannot be saved again', async () => {
        httpFetch.mockImplementation(async (_url: string, init: RequestInit) => {
            const placeholder = outgoingPlaceholder(init);
            clearPrivacyReview();
            return response(placeholder);
        });
        await consume();
        expect(getTauriInvokeCalls('privacy_filter_record_protection')).toEqual([]);
        expect(getTauriInvokeCalls('privacy_filter_record_restoration')).toEqual([]);
    });
    it('user chooses original sending then the provider receives the unchanged text without a new protection record or review marks', async () => {
        await setFailureAction('send-original');
        await failLocalModel();
        httpFetch.mockResolvedValue(response('reply'));

        expect((await consume()).map((chunk) => chunk.content).join('')).toBe('reply');

        expect(httpFetch).toHaveBeenCalledTimes(1);
        expect(JSON.parse(String(httpFetch.mock.lastCall?.[1].body)).messages).toEqual([
            { role: 'user', content: text },
        ]);
        expect(review.getReviewSnapshot().annotations).toEqual([]);
        expect(getTauriInvokeCalls('privacy_filter_record_protection')).toEqual([]);
    });

    it('user sends without choosing a failure action then a failed model falls back to rules and the reply still restores the replacement', async () => {
        await failLocalModel();
        httpFetch.mockImplementation(async (_url: string, init: RequestInit) =>
            response(outgoingPlaceholder(init))
        );

        expect((await consume()).map((chunk) => chunk.content).join('')).toBe(original);

        expect(review.getReviewSnapshot().annotations).toEqual([
            expect.objectContaining({ original, rule: { id: 'email' } }),
        ]);
        expect(getTauriInvokeCalls('privacy_filter_record_protection')).toEqual([
            expect.objectContaining({
                payload: expect.objectContaining({
                    record: expect.objectContaining({
                        mode: 'rules',
                        outcome: 'protected',
                        maskedCount: 1,
                    }),
                }),
            }),
        ]);
    });

    it.each([
        ['model', 'fallback-rules'],
        ['rules', 'send-original'],
    ] as const)(
        'user sends in %s mode with %s saved for model failure then a rules failure blocks the request',
        async (mode, action) => {
            await setFailureAction(action);
            if (mode === 'model') await failLocalModel();
            const sign = vi
                .spyOn(webcrypto.subtle, 'sign')
                .mockRejectedValueOnce(new Error('Local signing unavailable'));
            try {
                await expect(consume()).rejects.toMatchObject({ code: 'PRIVACY_FILTER_BLOCKED' });
            } finally {
                sign.mockRestore();
            }
            expect(httpFetch).not.toHaveBeenCalled();
            expect(review.getReviewSnapshot().annotations).toEqual([]);
        }
    );

    it('user cancels while detection is pending then the original is never sent despite the saved original-sending preference', async () => {
        await setFailureAction('send-original');
        await failLocalModel();
        const entered = Promise.withResolvers<void>();
        const detecting = Promise.withResolvers<never>();
        mockTauriCommand('privacy_filter_detect', () => {
            entered.resolve();
            return detecting.promise;
        });
        const controller = new AbortController();
        const cancelled = expect(
            consume({ ...request, signal: controller.signal })
        ).rejects.toMatchObject({
            name: 'AbortError',
        });
        await entered.promise;
        controller.abort();
        detecting.reject(new Error('Local detection unavailable'));
        await cancelled;

        expect(httpFetch).not.toHaveBeenCalled();
        expect(getTauriInvokeCalls('privacy_filter_record_protection')).toEqual([]);
    });
});
