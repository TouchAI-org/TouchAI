import { describe, expect, it } from 'vitest';

import {
    AiErrorCode,
    type AiRequestOptions,
    type ModelsHost,
    type RemoteRefRecord,
} from '../src/contracts';
import { buildModelMessages, createModels } from '../src/index';
import { OpenAIProviderAdapter } from '../src/providers/openai';

const providers = [
    {
        driver: 'openai' as const,
        create: (
            config: ConstructorParameters<typeof OpenAIProviderAdapter>[0],
            host: ModelsHost
        ) => new OpenAIProviderAdapter(config, host),
    },
];

function pdf(resourceKey: string) {
    return {
        type: 'file' as const,
        kind: 'pdf' as const,
        name: 'reference.pdf',
        size: 3,
        mimeType: 'application/pdf',
        base64Data: 'cGRm',
        resourceKey,
        anchorText: 'A pre-rendered reference',
        fallbackText: 'Pre-rendered unavailable content',
    };
}

function complete(): Response {
    const data = {
        id: 'fixture',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'fixture',
        choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }],
    };
    return new Response(`data: ${JSON.stringify(data)}\n\ndata: [DONE]\n\n`, {
        headers: { 'content-type': 'text/event-stream' },
    });
}

describe('given neutral media and connection-bound host I/O', () => {
    it('user keeps cached resources and credentials isolated across endpoints on both hits and misses', async () => {
        const outbound: { endpoint: string; authorization: string | null; body: unknown }[] = [];
        const models = createModels({ providers });
        const connections = ['first', 'second'].map((name) => {
            const cache = new Map<string, RemoteRefRecord>([
                ['hit', { ref: `file-${name}-hit`, expiresAt: null }],
            ]);
            const host: ModelsHost = {
                fetch: async (input, init) => {
                    if (String(input).endsWith('/files'))
                        return Response.json({ id: `file-${name}-miss` });
                    outbound.push({
                        endpoint: String(input),
                        authorization: new Headers(init?.headers).get('authorization'),
                        body: JSON.parse(String(init?.body)),
                    });
                    return complete();
                },
                remoteRefs: {
                    read: async (key) => cache.get(key) ?? null,
                    touch: async () => undefined,
                    write: async (key, reference) => {
                        cache.set(key, reference);
                    },
                },
            };
            return models.createConnection({
                driver: 'openai',
                host,
                config: {
                    apiEndpoint: `https://${name}.example.test/v1`,
                    apiKey: `${name}-fixture-key`,
                    config: { reasoning: { format: 'openai' } },
                },
            });
        });
        for (const key of ['hit', 'miss', 'miss']) {
            for (const connection of connections) {
                expect(
                    (
                        await connection.request({
                            model: 'fixture',
                            messages: [{ role: 'user', content: [pdf(key)] }],
                        })
                    ).content
                ).toBe('ok');
            }
        }
        expect(
            outbound.map(({ endpoint, authorization, body }) => ({
                endpoint,
                authorization,
                references: JSON.stringify(body).match(/file-(?:first|second)-(?:hit|miss)/g),
            }))
        ).toEqual(
            ['hit', 'miss', 'miss'].flatMap((key) =>
                ['first', 'second'].map((name) => ({
                    endpoint: `https://${name}.example.test/v1/chat/completions`,
                    authorization: `Bearer ${name}-fixture-key`,
                    references: [`file-${name}-${key}`],
                }))
            )
        );
    });

    it('user receives neutral transport observations without Desktop identities or persisted manifests', async () => {
        const result = await buildModelMessages({
            providerDriver: 'anthropic',
            modelId: 'fixture',
            messages: [{ role: 'user', content: [pdf('opaque-resource')] }],
        });
        expect(result.transport).toEqual([
            {
                messageIndex: 0,
                partIndex: 0,
                sourceRole: 'user',
                resolvedRole: 'user',
                messageContext: 'user',
                transportMode: 'inline-base64',
                messagePositionMode: 'inline',
                transportReason: 'pdf-inline-fallback',
                remoteRefStrategy: null,
            },
        ]);
        expect(Object.keys(result).sort()).toEqual(['messages', 'transport']);
    });

    it('user gets host-rendered semantic fallback text rather than provider-owned local tool instructions', async () => {
        const part = { ...pdf('opaque-resource'), kind: 'binary' as const };
        const result = await buildModelMessages({
            providerDriver: 'anthropic',
            modelId: 'fixture',
            messages: [{ role: 'user', content: [part] }],
        });
        expect(result.messages).toEqual([
            {
                role: 'user',
                content: [{ type: 'text', text: part.fallbackText }],
            },
        ]);
    });

    it('user can cancel a pending upload without a fallback generation request or cached late reference', async () => {
        const controller = new AbortController();
        const cancellation = new DOMException('cancelled', 'AbortError');
        const effects: string[] = [];
        const host: ModelsHost = {
            fetch: async (input, init) => {
                effects.push(String(input));
                if (effects.length > 1) {
                    return String(input).endsWith('/files')
                        ? Response.json({ id: 'file-after-cancellation' })
                        : complete();
                }
                return new Promise((_resolve, reject) => {
                    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
                        once: true,
                    });
                    controller.abort(cancellation);
                });
            },
            remoteRefs: {
                read: async () => null,
                touch: async () => undefined,
                write: async () => {
                    effects.push('cache-write');
                },
            },
        };
        const connection = createModels({ providers }).createConnection({
            driver: 'openai',
            host,
            config: {
                apiEndpoint: 'https://first.example.test/v1',
                config: { reasoning: { format: 'openai' } },
            },
        });
        const request: AiRequestOptions = {
            model: 'fixture',
            signal: controller.signal,
            messages: [{ role: 'user', content: [pdf('opaque-resource')] }],
        };
        await expect(connection.request(request)).rejects.toMatchObject({
            name: 'AiError',
            code: AiErrorCode.REQUEST_CANCELLED,
            cause: cancellation,
        });
        expect(effects).toEqual(['https://first.example.test/v1/files']);
        expect((await connection.request({ ...request, signal: undefined })).content).toBe('ok');
        expect(effects).toEqual([
            'https://first.example.test/v1/files',
            'https://first.example.test/v1/files',
            'cache-write',
            'https://first.example.test/v1/chat/completions',
        ]);
    });
});
