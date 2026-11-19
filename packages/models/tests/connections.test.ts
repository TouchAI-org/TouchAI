import { describe, expect, it } from 'vitest';

import type { AiRequestOptions, ModelsHost, RemoteRefWrite } from '../src/contracts';
import { createModels } from '../src/index';
import { OpenAIProviderAdapter } from '../src/providers/openai';
import { OpenAICompatibleProviderAdapter } from '../src/providers/openai-compatible';

function host(fetch: typeof globalThis.fetch): ModelsHost & { saved: RemoteRefWrite[] } {
    const saved: RemoteRefWrite[] = [];
    return {
        fetch,
        saved,
        remoteRefs: {
            read: async () => null,
            touch: async () => undefined,
            write: async (_key, entry) => {
                saved.push(entry);
            },
        },
    };
}

const compatible = {
    driver: 'openai-compatible' as const,
    create: (
        config: ConstructorParameters<typeof OpenAICompatibleProviderAdapter>[0],
        io: ModelsHost
    ) => new OpenAICompatibleProviderAdapter(config, io),
};
const openai = {
    driver: 'openai' as const,
    create: (config: ConstructorParameters<typeof OpenAIProviderAdapter>[0], io: ModelsHost) =>
        new OpenAIProviderAdapter(config, io),
};

describe('given independently configured provider connections', () => {
    it('user keeps endpoints and credentials isolated when discovering models', async () => {
        const requests: { url: string; authorization: string | null }[] = [];
        const io = host(async (input, init) => {
            requests.push({
                url: String(input),
                authorization: new Headers(init?.headers).get('authorization'),
            });
            return Response.json({ data: [{ id: 'fixture-model' }] });
        });
        const models = createModels({ providers: [compatible] });
        const first = models.createConnection({
            driver: 'openai-compatible',
            config: {
                apiEndpoint: 'https://first.example.test/v1',
                apiKey: 'first-fixture-key',
            },
            host: io,
        });
        const second = models.createConnection({
            driver: 'openai-compatible',
            config: {
                apiEndpoint: 'https://second.example.test/gateway',
                apiKey: 'second-fixture-key',
            },
            host: io,
        });
        expect(requests).toEqual([]);
        expect(await first.listModels()).toEqual([{ id: 'fixture-model', name: 'fixture-model' }]);
        expect(await second.listModels()).toEqual([{ id: 'fixture-model', name: 'fixture-model' }]);
        expect(requests).toEqual([
            {
                url: 'https://first.example.test/v1/models',
                authorization: 'Bearer first-fixture-key',
            },
            {
                url: 'https://second.example.test/gateway/models',
                authorization: 'Bearer second-fixture-key',
            },
        ]);
    });

    it('user keeps creation-time headers when the caller changes its configuration object', async () => {
        const headers: string[] = [];
        const io = host(async (_input, init) => {
            headers.push(new Headers(init?.headers).get('x-fixture') ?? 'missing');
            return Response.json({ data: [] });
        });
        const config = {
            apiEndpoint: 'https://example.test/v1',
            config: { headers: { 'x-fixture': 'original' } },
        };
        const models = createModels({ providers: [compatible] });
        const connection = models.createConnection({
            driver: 'openai-compatible',
            config,
            host: io,
        });
        config.config.headers['x-fixture'] = 'changed';
        await connection.listModels();
        expect(headers).toEqual(['original']);
    });

    it('user sees a missing driver rejected instead of an implicit provider', () => {
        const models = createModels({ providers: [] });
        expect(() =>
            models.createConnection({
                driver: 'openai',
                config: { apiEndpoint: 'https://example.test' },
                host: host(async () => Response.json({})),
            })
        ).toThrow('Provider driver is not registered: openai');
    });

    it('user sees duplicate driver registration rejected before a connection is created', () => {
        expect(() => createModels({ providers: [compatible, compatible] })).toThrow(
            'Duplicate provider driver: openai-compatible'
        );
    });
});

describe('given independent attachment upload lifetimes', () => {
    it('user can upload on another connection after one endpoint permanently rejects uploads', async () => {
        const uploaded: string[] = [];
        const io = host(async (input) => {
            const url = String(input);
            if (url.endsWith('/files')) {
                uploaded.push(url);
                return url.includes('first.')
                    ? new Response('', { status: 403 })
                    : Response.json({ id: 'file-fixture' });
            }
            return Response.json({ error: { message: 'fixture rejection' } }, { status: 400 });
        });
        const models = createModels({ providers: [openai] });
        const request: AiRequestOptions = {
            model: 'fixture-model',
            messages: [
                {
                    role: 'user',
                    content: [
                        {
                            type: 'file',
                            name: 'fixture.pdf',
                            resourceKey: 'opaque-resource',
                            size: 3,
                            mimeType: 'application/pdf',
                            kind: 'pdf',
                            base64Data: 'cGRm',
                        },
                    ],
                },
            ],
        };
        const first = models.createConnection({
            driver: 'openai',
            config: {
                apiEndpoint: 'https://first.example.test/v1',
                config: { reasoning: { format: 'openai' } },
            },
            host: io,
        });
        const second = models.createConnection({
            driver: 'openai',
            config: {
                apiEndpoint: 'https://second.example.test/v1',
                config: { reasoning: { format: 'openai' } },
            },
            host: io,
        });
        await expect(first.request(request)).rejects.toThrow('fixture rejection');
        await expect(second.request(request)).rejects.toThrow('fixture rejection');
        expect(uploaded).toEqual([
            'https://first.example.test/v1/files',
            'https://second.example.test/v1/files',
        ]);
        expect(io.saved).toEqual([
            {
                ref: 'file-fixture',
                mimeType: 'application/pdf',
                expiresAt: null,
            },
        ]);
    });
});
