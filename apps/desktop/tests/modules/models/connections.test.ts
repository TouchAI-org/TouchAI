import { createModels } from '@touchai/models';
import type { ModelsHost } from '@touchai/models/contracts';
import { OpenAIProviderAdapter } from '@touchai/models/providers/openai';
import { describe, expect, it } from 'vitest';

import { createAttachmentRemoteRefs } from '@/modules/attachments';
import type { ProviderConnectionState } from '@/modules/models';
import { createModelsModule } from '@/modules/models';

describe('given Desktop-owned connection profiles and resource records', () => {
    it('user cannot redirect a frozen connection cache through per-request provider identity', async () => {
        const registry = createModels({
            providers: [
                {
                    driver: 'openai',
                    create: (config, host) => new OpenAIProviderAdapter(config, host),
                },
            ],
        });
        const states: ProviderConnectionState[] = [1, 2].map((id) => ({
            providerId: id,
            enabled: true,
            driver: 'openai',
            apiEndpoint: `https://endpoint-${id}.example.test/v1`,
            apiKey: `fixture-${id}`,
            config: { reasoning: { format: 'openai' } },
            updatedAt: '2026-11-14T00:00:00Z',
        }));
        const payloads: unknown[] = [];
        const module = createModelsModule({
            createProvider: registry.createConnection,
            fetch: async (_input, init) => {
                payloads.push(JSON.parse(String(init?.body)));
                return Response.json({ error: { message: 'fixture rejection' } }, { status: 400 });
            },
            readConnectionState: async (id) =>
                states.find((state) => state.providerId === id) ?? null,
            createResources: (options) =>
                createAttachmentRemoteRefs({
                    ...options,
                    store: {
                        read: async (attachmentId, providerId) => ({
                            id: attachmentId,
                            ref: `file-${providerId}-${attachmentId}`,
                            expiresAt: null,
                            createdAt: '2026-11-15T00:00:00Z',
                        }),
                        touch: async () => undefined,
                        write: async () => undefined,
                    },
                }),
        });
        try {
            for (const state of states) {
                const connection = module.createConnection(state);
                const resourceKey = connection.resourceKey(7);
                const request = {
                    model: 'fixture',
                    providerId: 999,
                    messages: [
                        {
                            role: 'user' as const,
                            content: [
                                {
                                    type: 'file' as const,
                                    kind: 'pdf' as const,
                                    resourceKey,
                                    name: 'fixture.pdf',
                                    size: 3,
                                    mimeType: 'application/pdf',
                                    base64Data: 'cGRm',
                                },
                            ],
                        },
                    ],
                };
                await expect(connection.provider.request(request)).rejects.toThrow(
                    'fixture rejection'
                );
                connection.dispose();
            }
            expect(payloads.map((payload) => JSON.stringify(payload).match(/file-\d-7/g))).toEqual([
                ['file-1-7'],
                ['file-2-7'],
            ]);
        } finally {
            module.dispose();
        }
    });

    it('user sees revocation as a configuration state before a new network effect', async () => {
        const registry = createModels({
            providers: [
                {
                    driver: 'openai',
                    create: (config, host) => new OpenAIProviderAdapter(config, host),
                },
            ],
        });
        let enabled = true;
        const profile = {
            providerId: 1,
            driver: 'openai' as const,
            apiEndpoint: 'https://fixture.example.test/v1',
            config: null,
        };
        const host: ModelsHost = {
            fetch: async () => {
                throw new Error('unexpected network effect');
            },
            remoteRefs: {
                read: async () => null,
                touch: async () => undefined,
                write: async () => undefined,
            },
        };
        const module = createModelsModule({
            createProvider: registry.createConnection,
            fetch: host.fetch,
            readConnectionState: async () => ({ ...profile, enabled }),
            createResources: () => ({
                remoteRefs: host.remoteRefs,
                resourceKey: () => undefined,
                dispose: () => undefined,
            }),
        });
        try {
            const connection = module.createConnection(profile);
            enabled = false;
            await expect(connection.provider.listModels()).rejects.toMatchObject({
                code: 'PROVIDER_DISABLED',
            });
        } finally {
            module.dispose();
        }
    });

    it('user cannot reuse an older upload after editing its provider profile or disposing its connection', async () => {
        let current = true;
        const resources = createAttachmentRemoteRefs({
            providerId: 1,
            bindingUpdatedAt: '2026-11-15T00:00:00Z',
            isCurrentBinding: async () => current,
            store: {
                read: async () => ({
                    id: 1,
                    ref: 'file-old-endpoint',
                    expiresAt: null,
                    createdAt: '2026-11-14T00:00:00Z',
                }),
                touch: async () => undefined,
                write: async () => undefined,
            },
        });
        const key = resources.resourceKey(7)!;
        expect(await resources.remoteRefs.read(key)).toBeNull();
        current = false;
        expect(await resources.remoteRefs.read(key)).toBeNull();
        resources.dispose();
        expect(resources.resourceKey(7)).toBeUndefined();
        expect(await resources.remoteRefs.read(key)).toBeNull();
    });

    it.each(['apiEndpoint', 'driver', 'apiKey', 'config'] as const)(
        'user cannot start a new model effect through the previous binding after editing %s',
        async (field) => {
            const registry = createModels({
                providers: [
                    {
                        driver: 'openai',
                        create: (config, host) => new OpenAIProviderAdapter(config, host),
                    },
                ],
            });
            const profile: ProviderConnectionState = {
                providerId: 1,
                enabled: true,
                driver: 'openai',
                apiEndpoint: 'https://fixture.invalid/v1',
                apiKey: 'fixture-credential',
                config: null,
            };
            let current = structuredClone(profile);
            const requests: string[] = [];
            const module = createModelsModule({
                createProvider: registry.createConnection,
                fetch: async (url) => {
                    requests.push(String(url));
                    return Response.json({ data: [{ id: 'fixture' }] });
                },
                readConnectionState: async () => current,
                createResources: () => ({
                    remoteRefs: {
                        read: async () => null,
                        touch: async () => {},
                        write: async () => {},
                    },
                    resourceKey: () => undefined,
                    dispose: () => {},
                }),
            });
            try {
                const connection = module.createConnection(profile);
                current = {
                    ...current,
                    [field]: {
                        apiEndpoint: 'https://replacement.invalid/v1',
                        driver: 'openai-compatible',
                        apiKey: 'replacement-credential',
                        config: { headers: { 'X-Fixture': 'replacement' } },
                    }[field],
                };
                await expect(connection.provider.listModels()).rejects.toMatchObject({
                    code: 'PROVIDER_BINDING_REVOKED',
                });
                expect(requests).toEqual([]);
            } finally {
                module.dispose();
            }
        }
    );

    it('user can release one turn without closing another lease and receives a fresh identity after the final release', async () => {
        const registry = createModels({
            providers: [
                {
                    driver: 'openai',
                    create: (config, host) => new OpenAIProviderAdapter(config, host),
                },
            ],
        });
        const profile: ProviderConnectionState = {
            providerId: 1,
            enabled: true,
            driver: 'openai',
            apiEndpoint: 'https://fixture.invalid/v1',
            config: null,
        };
        const module = createModelsModule({
            createProvider: registry.createConnection,
            fetch: async () => Response.json({ data: [{ id: 'fixture' }] }),
            readConnectionState: async () => profile,
            createResources: () => ({
                remoteRefs: {
                    read: async () => null,
                    touch: async () => {},
                    write: async () => {},
                },
                resourceKey: () => undefined,
                dispose: () => {},
            }),
        });
        try {
            const first = module.acquireConnection(profile);
            const second = module.acquireConnection(profile);
            expect(second.connectionKey).toBe(first.connectionKey);
            first.dispose();
            await expect(first.provider.listModels()).rejects.toThrow('MODEL_CONNECTION_DISPOSED');
            expect((await second.provider.listModels()).map((model) => model.id)).toEqual([
                'fixture',
            ]);
            second.dispose();
            const next = module.acquireConnection(profile);
            expect(next.connectionKey).not.toBe(first.connectionKey);
            expect((await next.provider.listModels()).map((model) => model.id)).toEqual([
                'fixture',
            ]);
            next.dispose();
        } finally {
            module.dispose();
        }
    });
});
