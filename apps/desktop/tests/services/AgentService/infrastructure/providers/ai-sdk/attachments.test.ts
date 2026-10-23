// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { AttachmentTransportDecision } from '@services/AgentService/contracts/protocol';
import {
    type ProviderAttachmentRequestContext,
    resolveProviderAttachmentRemoteRef,
} from '@services/AgentService/infrastructure/providers/ai-sdk/attachments';
import { describe, expect, it, vi } from 'vitest';

const {
    findAttachmentRemoteRefMock,
    touchAttachmentRemoteRefLastUsedMock,
    upsertAttachmentRemoteRefMock,
} = vi.hoisted(() => ({
    findAttachmentRemoteRefMock: vi.fn(),
    touchAttachmentRemoteRefLastUsedMock: vi.fn(),
    upsertAttachmentRemoteRefMock: vi.fn(),
}));

vi.mock('@database/queries', () => ({
    findAttachmentRemoteRef: findAttachmentRemoteRefMock,
    touchAttachmentRemoteRefLastUsed: touchAttachmentRemoteRefLastUsedMock,
    upsertAttachmentRemoteRef: upsertAttachmentRemoteRefMock,
}));

type Part = Parameters<typeof resolveProviderAttachmentRemoteRef>[0];

function imagePart(overrides: Partial<Part> = {}): Part {
    return {
        type: 'image',
        name: 'chart.png',
        sourcePath: 'D:/cache/chart.png',
        size: 8,
        mimeType: 'image/png',
        data: 'iVBORw0KGgo=',
        kind: 'image',
        meta: { attachmentId: 7 },
        ...overrides,
    } as Part;
}

function filePart(): Part {
    return {
        type: 'file',
        name: 'report.pdf',
        sourcePath: 'D:/cache/report.pdf',
        size: 8,
        mimeType: 'application/pdf',
        kind: 'pdf',
        base64Data: 'JVBERi0=',
        meta: { attachmentId: 7 },
    } as Part;
}

function context(overrides: Partial<ProviderAttachmentRequestContext> = {}) {
    return {
        driver: 'openai' as const,
        providerId: 3,
        modelId: 'gpt-5',
        apiTargets: { sdkBaseUrl: 'https://api.example.test/v1' },
        apiKey: 'secret',
        customHeaders: {},
        fetch: vi.fn(),
        ...overrides,
    } as ProviderAttachmentRequestContext;
}

function decision(
    overrides: Partial<AttachmentTransportDecision> = {}
): AttachmentTransportDecision {
    return {
        canReuseRemoteRef: true,
        shouldUpload: true,
        ...overrides,
    } as AttachmentTransportDecision;
}

function jsonResponse(payload: unknown, init: { status?: number } = {}) {
    return {
        ok: (init.status ?? 200) < 400,
        status: init.status ?? 200,
        statusText: init.status === 404 ? 'Not Found' : 'OK',
        json: async () => payload,
        headers: new Headers(),
    } as unknown as Response;
}

function resetRemoteRefMocks() {
    findAttachmentRemoteRefMock.mockReset();
    touchAttachmentRemoteRefLastUsedMock.mockReset();
    upsertAttachmentRemoteRefMock.mockReset();
    findAttachmentRemoteRefMock.mockResolvedValue(undefined);
    touchAttachmentRemoteRefLastUsedMock.mockResolvedValue(undefined);
    upsertAttachmentRemoteRefMock.mockResolvedValue(undefined);
}

describe('user sends an attachment to a provider that can store files', () => {
    it('user has the file uploaded once and reused on the next message', async () => {
        resetRemoteRefMocks();
        const requestContext = context();
        vi.mocked(requestContext.fetch).mockResolvedValue(jsonResponse({ id: 'file-abc' }));

        const resolved = await resolveProviderAttachmentRemoteRef(
            filePart(),
            decision(),
            requestContext
        );

        expect(resolved).toEqual({ strategy: 'openai-file-id', value: 'file-abc' });
        expect(upsertAttachmentRemoteRefMock).toHaveBeenCalledWith(
            expect.objectContaining({
                attachment_id: 7,
                provider_id: 3,
                remote_ref: 'file-abc',
                mime_type: 'application/pdf',
            })
        );
    });

    it('user does not upload the same file again when a stored reference is still valid', async () => {
        resetRemoteRefMocks();
        const requestContext = context();
        findAttachmentRemoteRefMock.mockResolvedValue({
            id: 1,
            remote_ref: 'file-reused',
            expires_at: null,
        });

        const resolved = await resolveProviderAttachmentRemoteRef(
            filePart(),
            decision(),
            requestContext
        );

        expect(resolved).toEqual({ strategy: 'openai-file-id', value: 'file-reused' });
        expect(requestContext.fetch).not.toHaveBeenCalled();
        expect(upsertAttachmentRemoteRefMock).not.toHaveBeenCalled();
        expect(touchAttachmentRemoteRefLastUsedMock).toHaveBeenCalledWith({ id: 1 });
    });

    it('user sees the file uploaded again once the stored reference expired', async () => {
        resetRemoteRefMocks();
        const requestContext = context();
        findAttachmentRemoteRefMock.mockResolvedValue({
            id: 1,
            remote_ref: 'file-stale',
            expires_at: new Date(Date.now() - 60_000).toISOString(),
        });
        vi.mocked(requestContext.fetch).mockResolvedValue(jsonResponse({ id: 'file-fresh' }));

        const resolved = await resolveProviderAttachmentRemoteRef(
            filePart(),
            decision(),
            requestContext
        );

        expect(resolved).toEqual({ strategy: 'openai-file-id', value: 'file-fresh' });
    });

    it('user still sends the message when the provider refuses file uploads', async () => {
        resetRemoteRefMocks();
        const requestContext = context({ providerId: 11 });
        vi.mocked(requestContext.fetch).mockResolvedValue(jsonResponse({}, { status: 404 }));

        const resolved = await resolveProviderAttachmentRemoteRef(
            filePart(),
            decision(),
            requestContext
        );

        // Falling back to inline transport keeps the message usable.
        expect(resolved).toBeNull();
    });

    it('user does not retry uploads the provider permanently rejects', async () => {
        resetRemoteRefMocks();
        const requestContext = context({ providerId: 12 });
        vi.mocked(requestContext.fetch).mockResolvedValue(jsonResponse({}, { status: 403 }));

        await expect(
            resolveProviderAttachmentRemoteRef(filePart(), decision(), requestContext)
        ).resolves.toBeNull();
        vi.mocked(requestContext.fetch).mockClear();

        await resolveProviderAttachmentRemoteRef(filePart(), decision(), requestContext);

        expect(requestContext.fetch).not.toHaveBeenCalled();
    });

    it('user gets no remote reference for a driver that cannot store files', async () => {
        resetRemoteRefMocks();
        const requestContext = context({ driver: 'anthropic' });

        const resolved = await resolveProviderAttachmentRemoteRef(
            filePart(),
            decision(),
            requestContext
        );

        expect(resolved).toBeNull();
        expect(requestContext.fetch).not.toHaveBeenCalled();
    });

    it('user does not upload an image the model sends inline anyway', async () => {
        resetRemoteRefMocks();
        const requestContext = context();

        const resolved = await resolveProviderAttachmentRemoteRef(
            imagePart(),
            decision({ canReuseRemoteRef: false, shouldUpload: false }),
            requestContext
        );

        expect(resolved).toBeNull();
        expect(requestContext.fetch).not.toHaveBeenCalled();
    });

    it('user gets no remote reference when the provider is unknown', async () => {
        resetRemoteRefMocks();
        const requestContext = context({ providerId: undefined });

        const resolved = await resolveProviderAttachmentRemoteRef(
            filePart(),
            decision(),
            requestContext
        );

        expect(resolved).toBeNull();
        expect(requestContext.fetch).not.toHaveBeenCalled();
    });

    it('user gets no remote reference for an attachment that was never stored', async () => {
        resetRemoteRefMocks();
        const requestContext = context();
        const unstored = imagePart();
        unstored.meta = { ...unstored.meta, attachmentId: null };

        const resolved = await resolveProviderAttachmentRemoteRef(
            unstored,
            decision(),
            requestContext
        );

        expect(resolved).toBeNull();
        expect(requestContext.fetch).not.toHaveBeenCalled();
    });
});
