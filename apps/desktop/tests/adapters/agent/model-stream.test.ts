import { createModels } from '@touchai/models';
import type { ModelsHost } from '@touchai/models/contracts';
import { OpenAIProviderAdapter } from '@touchai/models/providers/openai';
import { describe, expect, it } from 'vitest';

import { createAgentMessageAdapter } from '@/adapters/agent/messages';
import { createCoreModelStream } from '@/adapters/agent/model';
import type { AttachmentDeliveryManifestRequest } from '@/modules/attachments';
import { createAttachmentRemoteRefs } from '@/modules/attachments';
import { createModelsModule } from '@/modules/models';

describe('given Core uses a task message adapter and a frozen Desktop connection', () => {
    it('user receives a profile-scoped cache hit while Desktop retains the unchanged attachment delivery record', async () => {
        const registry = createModels({
            providers: [
                {
                    driver: 'openai',
                    create: (config, host) => new OpenAIProviderAdapter(config, host),
                },
            ],
        });
        const payloads: unknown[] = [];
        const manifests: AttachmentDeliveryManifestRequest[] = [];
        const messages = createAgentMessageAdapter();
        const profile = {
            providerId: 2,
            driver: 'openai' as const,
            apiEndpoint: 'https://second.invalid/v1',
            config: { reasoning: { format: 'openai' as const } },
        };
        const connections = createModelsModule({
            createProvider: registry.createConnection,
            fetch: async (_input, init) => {
                payloads.push(JSON.parse(String(init?.body)));
                return Response.json({ error: { message: 'fixture rejection' } }, { status: 400 });
            },
            readConnectionState: async () => ({ ...profile, enabled: true }),
            createResources: (options) =>
                createAttachmentRemoteRefs({
                    ...options,
                    store: {
                        read: async () => ({
                            id: 1,
                            ref: 'file-profile-two',
                            expiresAt: null,
                            createdAt: '2026-11-15T00:00:00Z',
                        }),
                        touch: async () => {},
                        write: async () => {},
                    },
                }),
        });
        try {
            const connection = connections.acquireConnection(profile);
            const stream = createCoreModelStream({
                connection,
                messages,
                languageContext: { locale: 'en-US', label: 'English' },
                nextRequestIndex: () => 7,
                saveManifest: async (manifest) => {
                    manifests.push(manifest);
                },
            });
            const request = {
                model: 'fixture-model',
                messages: messages.toCore([
                    {
                        role: 'user',
                        content: [
                            {
                                type: 'file',
                                kind: 'pdf',
                                name: 'fixture.pdf',
                                size: 3,
                                mimeType: 'application/pdf',
                                base64Data: 'cGRm',
                                sourcePath: '/fixture/cache',
                                semanticIntent: 'document-content',
                                meta: {
                                    alias: 'A1',
                                    order: 1,
                                    type: 'file',
                                    name: 'fixture.pdf',
                                    mimeType: 'application/pdf',
                                    originPath: '/fixture/original',
                                    attachmentId: 9,
                                    hash: 'fixture-hash',
                                },
                            },
                        ],
                    },
                ]),
            };
            await expect(
                (async () => {
                    for await (const chunk of stream(request)) {
                        expect(chunk).toBeDefined();
                    }
                })()
            ).rejects.toThrow('fixture rejection');
            expect(JSON.stringify(payloads)).toContain('file-profile-two');
            expect(JSON.stringify(payloads)).not.toContain('attachmentId');
            expect(manifests[0]).toMatchObject({
                requestIndex: 7,
                providerId: 2,
                modelId: 'fixture-model',
                entries: [
                    {
                        sourcePath: '/fixture/cache',
                        originPath: '/fixture/original',
                        attachmentId: 9,
                        hash: 'fixture-hash',
                        transportMode: 'provider-file-ref',
                        derivedKind: 'pdf',
                        semanticIntent: 'document-content',
                    },
                ],
            });
            expect(JSON.stringify(manifests)).not.toContain('resourceKey');
            connection.dispose();
        } finally {
            connections.dispose();
            messages.dispose();
        }
    });

    it('user receives invalid configuration without a network effect when the saved binding changes before Core streams', async () => {
        const registry = createModels({
            providers: [
                {
                    driver: 'openai',
                    create: (config, host) => new OpenAIProviderAdapter(config, host),
                },
            ],
        });
        const profile = {
            providerId: 1,
            driver: 'openai' as const,
            apiEndpoint: 'https://fixture.invalid/v1',
            config: null,
        };
        let endpoint = profile.apiEndpoint;
        const requests: string[] = [];
        const io: ModelsHost = {
            fetch: async (url) => {
                requests.push(String(url));
                return Response.json({ data: [{ id: 'fixture' }] });
            },
            remoteRefs: {
                read: async () => null,
                touch: async () => {},
                write: async () => {},
            },
        };
        const connections = createModelsModule({
            createProvider: registry.createConnection,
            fetch: io.fetch,
            readConnectionState: async () => ({
                ...profile,
                apiEndpoint: endpoint,
                enabled: true,
            }),
            createResources: () => ({
                remoteRefs: io.remoteRefs,
                resourceKey: () => undefined,
                dispose: () => {},
            }),
        });
        const messages = createAgentMessageAdapter();
        try {
            const connection = connections.acquireConnection(profile);
            endpoint = 'https://replacement.invalid/v1';
            const stream = createCoreModelStream({
                connection,
                messages,
                languageContext: { locale: 'en-US', label: 'English' },
                nextRequestIndex: () => 0,
                saveManifest: async () => {},
            });
            const request = {
                model: 'fixture',
                messages: [{ role: 'user' as const, content: 'request' }],
            };
            const result = (async () => {
                for await (const chunk of stream(request)) {
                    expect(chunk).toBeDefined();
                }
            })();
            await expect(result).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
            expect(requests).toEqual([]);
            endpoint = profile.apiEndpoint;
            await expect(connections.discoverModels(profile.providerId)).resolves.toMatchObject([
                { id: 'fixture' },
            ]);
            expect(requests).toHaveLength(1);
            connection.dispose();
        } finally {
            connections.dispose();
            messages.dispose();
        }
    });
});
