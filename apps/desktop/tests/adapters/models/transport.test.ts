import { describe, expect, it, vi } from 'vitest';

import type { DesktopModelRequest as AiRequestOptions } from '@/adapters/models/input';
import { prepareModelRequest } from '@/adapters/models/transport';
import type { ToolDeclaration } from '@/modules/tools';

describe('given Desktop attachment records at the provider boundary', () => {
    it('user retains the exact persisted delivery shape while the provider receives opaque media', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-11-15T00:00:00.000Z'));
        const manifests: unknown[] = [];
        const tool: ToolDeclaration = {
            name: 'fixture',
            description: 'read',
            input_schema: { type: 'object', properties: {} },
            adaptiveTimeoutCeilingMs: 5000,
        };
        const input: AiRequestOptions = {
            model: 'fixture',
            attachmentRequestIndex: 4,
            messages: [
                {
                    role: 'user',
                    content: [
                        {
                            type: 'file',
                            name: 'fixture.pdf',
                            sourcePath: '/fixture/cache.pdf',
                            size: 3,
                            mimeType: 'application/pdf',
                            kind: 'pdf',
                            semanticIntent: 'document-content',
                            base64Data: 'cGRm',
                            meta: {
                                alias: 'A1',
                                order: 0,
                                type: 'file',
                                name: 'fixture.pdf',
                                mimeType: 'application/pdf',
                                originPath: '/fixture/original.pdf',
                                attachmentId: 7,
                                hash: 'fixture-hash',
                            },
                        },
                    ],
                },
            ],
            tools: [tool],
            onAttachmentManifestResolved: (manifest) => {
                manifests.push(manifest);
            },
        };
        try {
            const output = prepareModelRequest(input, {
                driver: 'openai',
                providerId: 9,
                resourceKey: () => 'opaque-reference',
            });
            expect(output.messages).toEqual([
                {
                    role: 'user',
                    content: [
                        {
                            type: 'file',
                            name: 'fixture.pdf',
                            size: 3,
                            mimeType: 'application/pdf',
                            kind: 'pdf',
                            base64Data: 'cGRm',
                            resourceKey: 'opaque-reference',
                            anchorText:
                                '[Attachment A1]\nname: fixture.pdf\ntype: file\norigin_path: /fixture/original.pdf\nmime_type: application/pdf',
                            fallbackText:
                                '[Not inlined: binary content. Local path: /fixture/original.pdf. Use the Read tool with this path when the content is needed.]',
                        },
                    ],
                },
            ]);
            expect(output.tools).toEqual([
                {
                    name: 'fixture',
                    description: 'read',
                    input_schema: {
                        type: 'object',
                        properties: {},
                    },
                },
            ]);
            await output.onTransportResolved?.([
                {
                    messageIndex: 0,
                    partIndex: 0,
                    sourceRole: 'user',
                    resolvedRole: 'user',
                    messageContext: 'user',
                    transportMode: 'provider-file-ref',
                    messagePositionMode: 'inline',
                    transportReason: 'pdf-prefers-provider-file-ref',
                    remoteRefStrategy: 'openai-file-id',
                },
            ]);
            expect(JSON.stringify(manifests)).toBe(
                JSON.stringify([
                    {
                        requestIndex: 4,
                        providerDriver: 'openai',
                        providerId: 9,
                        modelId: 'fixture',
                        entries: [
                            {
                                messageIndex: 0,
                                partIndex: 0,
                                sourceRole: 'user',
                                resolvedRole: 'user',
                                messageContext: 'user',
                                alias: 'A1',
                                order: 0,
                                type: 'file',
                                name: 'fixture.pdf',
                                size: 3,
                                mimeType: 'application/pdf',
                                originPath: '/fixture/original.pdf',
                                sourcePath: '/fixture/cache.pdf',
                                attachmentId: 7,
                                hash: 'fixture-hash',
                                derivedKind: 'pdf',
                                semanticIntent: 'document-content',
                                transportMode: 'provider-file-ref',
                                messagePositionMode: 'inline',
                                transportReason: 'pdf-prefers-provider-file-ref',
                                remoteRefStrategy: 'openai-file-id',
                            },
                        ],
                        createdAt: '2026-11-15T00:00:00.000Z',
                    },
                ])
            );
        } finally {
            vi.useRealTimers();
        }
    });
});
