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

function filePart(overrides: Partial<Part> = {}): Part {
    return {
        type: 'file',
        name: 'report.pdf',
        sourcePath: 'D:/cache/report.pdf',
        size: 8,
        mimeType: 'application/pdf',
        kind: 'pdf',
        base64Data: 'JVBERi0=',
        meta: { attachmentId: 7 },
        ...overrides,
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

describe('user sends an attachment to Google', () => {
    const GOOGLE_BASE_URL = 'https://generativelanguage.example.test/v1beta';

    function googleContext(overrides: Partial<ProviderAttachmentRequestContext> = {}) {
        return context({
            driver: 'google',
            providerId: 31,
            modelId: 'gemini-2.5-pro',
            apiTargets: {
                normalizedBaseUrl: GOOGLE_BASE_URL,
                sdkBaseUrl: GOOGLE_BASE_URL,
                generationTarget: GOOGLE_BASE_URL,
                discoveryTarget: GOOGLE_BASE_URL,
            },
            ...overrides,
        });
    }

    function uploadStart(uploadUrl: string | null) {
        return {
            ok: true,
            status: 200,
            statusText: 'OK',
            json: async () => ({}),
            headers: new Headers(uploadUrl ? { 'x-goog-upload-url': uploadUrl } : {}),
        } as unknown as Response;
    }

    function fileRecord(file: Record<string, unknown>) {
        return jsonResponse({ file });
    }

    it('user gets the processed file url once Google marks the upload active', async () => {
        resetRemoteRefMocks();
        const requestContext = googleContext();
        vi.mocked(requestContext.fetch)
            .mockResolvedValueOnce(uploadStart('https://upload.example.test/session-1'))
            .mockResolvedValueOnce(
                fileRecord({
                    name: 'files/abc',
                    uri: 'https://generativelanguage.example.test/v1beta/files/abc',
                    state: 'ACTIVE',
                    expirationTime: '2026-07-01T00:00:00.000Z',
                })
            );

        const resolved = await resolveProviderAttachmentRemoteRef(
            imagePart(),
            decision({ canReuseRemoteRef: false, shouldUpload: true }),
            requestContext
        );

        expect(resolved).toEqual({
            strategy: 'url',
            value: 'https://generativelanguage.example.test/v1beta/files/abc',
        });
        expect(upsertAttachmentRemoteRefMock).toHaveBeenCalledWith(
            expect.objectContaining({
                attachment_id: 7,
                provider_id: 31,
                remote_ref: 'https://generativelanguage.example.test/v1beta/files/abc',
                expires_at: '2026-07-01T00:00:00.000Z',
            })
        );
        expect(vi.mocked(requestContext.fetch).mock.calls[0]?.[0]).toBe(
            'https://generativelanguage.example.test/upload/v1beta/files'
        );
    });

    it('user still gets the message sent inline when Google uploads without naming the file', async () => {
        resetRemoteRefMocks();
        const requestContext = googleContext({ providerId: 40 });
        vi.mocked(requestContext.fetch)
            .mockResolvedValueOnce(uploadStart('https://upload.example.test/session-8'))
            .mockResolvedValueOnce(fileRecord({ uri: 'https://files.example.test/orphan' }));

        const resolved = await resolveProviderAttachmentRemoteRef(
            imagePart(),
            decision({ canReuseRemoteRef: false, shouldUpload: true }),
            requestContext
        );

        expect(resolved).toBeNull();
        expect(upsertAttachmentRemoteRefMock).not.toHaveBeenCalled();
    });

    it('user waits for the file to finish processing before it is used', async () => {
        resetRemoteRefMocks();
        const requestContext = googleContext({ providerId: 32 });
        vi.mocked(requestContext.fetch)
            .mockResolvedValueOnce(uploadStart('https://upload.example.test/session-2'))
            .mockResolvedValueOnce(fileRecord({ name: 'files/pending', state: 'PROCESSING' }))
            .mockResolvedValueOnce(
                fileRecord({
                    name: 'files/pending',
                    uri: 'https://generativelanguage.example.test/v1beta/files/pending',
                    state: 'ACTIVE',
                })
            );

        const resolved = await resolveProviderAttachmentRemoteRef(
            imagePart(),
            decision({ canReuseRemoteRef: false, shouldUpload: true }),
            requestContext
        );

        expect(resolved).toEqual({
            strategy: 'url',
            value: 'https://generativelanguage.example.test/v1beta/files/pending',
        });
        expect(upsertAttachmentRemoteRefMock).toHaveBeenCalledWith(
            expect.objectContaining({ expires_at: null })
        );
    }, 10_000);

    it('user still gets the message sent inline when Google fails to process the file', async () => {
        resetRemoteRefMocks();
        const requestContext = googleContext({ providerId: 33 });
        vi.mocked(requestContext.fetch)
            .mockResolvedValueOnce(uploadStart('https://upload.example.test/session-3'))
            .mockResolvedValueOnce(fileRecord({ name: 'files/bad', state: 'FAILED' }));

        const resolved = await resolveProviderAttachmentRemoteRef(
            imagePart(),
            decision({ canReuseRemoteRef: false, shouldUpload: true }),
            requestContext
        );

        expect(resolved).toBeNull();
        expect(upsertAttachmentRemoteRefMock).not.toHaveBeenCalled();
    });

    it('user still gets the message sent inline when Google answers the status check with junk', async () => {
        resetRemoteRefMocks();
        const requestContext = googleContext({ providerId: 34 });
        vi.mocked(requestContext.fetch)
            .mockResolvedValueOnce(uploadStart('https://upload.example.test/session-4'))
            .mockResolvedValueOnce(fileRecord({ name: 'files/junk', state: 'PROCESSING' }))
            .mockResolvedValueOnce(jsonResponse('not-a-file-record'));

        const resolved = await resolveProviderAttachmentRemoteRef(
            imagePart(),
            decision({ canReuseRemoteRef: false, shouldUpload: true }),
            requestContext
        );

        expect(resolved).toBeNull();
    });

    it('user still gets the message sent inline when Google returns no upload session', async () => {
        resetRemoteRefMocks();
        const requestContext = googleContext({ providerId: 35 });
        vi.mocked(requestContext.fetch).mockResolvedValueOnce(uploadStart(null));

        const resolved = await resolveProviderAttachmentRemoteRef(
            imagePart(),
            decision({ canReuseRemoteRef: false, shouldUpload: true }),
            requestContext
        );

        expect(resolved).toBeNull();
        expect(upsertAttachmentRemoteRefMock).not.toHaveBeenCalled();
    });

    it('user still gets the message sent inline when Google rejects the finalize step', async () => {
        resetRemoteRefMocks();
        const requestContext = googleContext({ providerId: 36 });
        vi.mocked(requestContext.fetch)
            .mockResolvedValueOnce(uploadStart('https://upload.example.test/session-5'))
            .mockResolvedValueOnce(jsonResponse({}, { status: 500 }));

        const resolved = await resolveProviderAttachmentRemoteRef(
            imagePart(),
            decision({ canReuseRemoteRef: false, shouldUpload: true }),
            requestContext
        );

        expect(resolved).toBeNull();
    });

    it('user does not keep retrying a provider whose upload endpoint is gone', async () => {
        resetRemoteRefMocks();
        const requestContext = googleContext({ providerId: 37 });
        vi.mocked(requestContext.fetch).mockResolvedValueOnce(jsonResponse({}, { status: 501 }));

        await expect(
            resolveProviderAttachmentRemoteRef(
                imagePart(),
                decision({ canReuseRemoteRef: false, shouldUpload: true }),
                requestContext
            )
        ).resolves.toBeNull();
        vi.mocked(requestContext.fetch).mockClear();

        await resolveProviderAttachmentRemoteRef(
            imagePart(),
            decision({ canReuseRemoteRef: false, shouldUpload: true }),
            requestContext
        );

        expect(requestContext.fetch).not.toHaveBeenCalled();
    });

    it('user still gets the message sent inline when the Google status lookup fails', async () => {
        resetRemoteRefMocks();
        const requestContext = googleContext({ providerId: 38 });
        vi.mocked(requestContext.fetch)
            .mockResolvedValueOnce(uploadStart('https://upload.example.test/session-6'))
            .mockResolvedValueOnce(fileRecord({ name: 'files/slow', state: 'PROCESSING' }))
            .mockResolvedValueOnce(jsonResponse({}, { status: 503 }));

        const resolved = await resolveProviderAttachmentRemoteRef(
            imagePart(),
            decision({ canReuseRemoteRef: false, shouldUpload: true }),
            requestContext
        );

        expect(resolved).toBeNull();
        expect(upsertAttachmentRemoteRefMock).not.toHaveBeenCalled();
    }, 10_000);

    it('user still gets the message sent inline when the Google upload never finishes processing', async () => {
        resetRemoteRefMocks();
        vi.useFakeTimers();
        const requestContext = googleContext({ providerId: 39 });
        const fetchMock = vi.mocked(requestContext.fetch);
        fetchMock.mockResolvedValueOnce(uploadStart('https://upload.example.test/session-7'));
        // Every status poll answers "still processing" so the polling budget runs out.
        fetchMock.mockResolvedValue(fileRecord({ name: 'files/stuck', state: 'PROCESSING' }));

        const resolution = resolveProviderAttachmentRemoteRef(
            imagePart(),
            decision({ canReuseRemoteRef: false, shouldUpload: true }),
            requestContext
        );
        // Each wait between polls is 500ms; the upload gives up after 20 of them.
        for (let poll = 0; poll < 25; poll += 1) {
            await vi.advanceTimersByTimeAsync(500);
        }

        await expect(resolution).resolves.toBeNull();
        expect(upsertAttachmentRemoteRefMock).not.toHaveBeenCalled();
        vi.useRealTimers();
    });
});

describe('user sends an attachment whose upload cannot be built', () => {
    it('user gets the file sent inline when the attachment has no uploadable content', async () => {
        resetRemoteRefMocks();
        const requestContext = context({ providerId: 51 });
        const emptyFile = filePart({ base64Data: undefined });

        const resolved = await resolveProviderAttachmentRemoteRef(
            emptyFile,
            decision({ canReuseRemoteRef: false, shouldUpload: true }),
            requestContext
        );

        expect(resolved).toBeNull();
        expect(requestContext.fetch).not.toHaveBeenCalled();
        expect(upsertAttachmentRemoteRefMock).not.toHaveBeenCalled();
    });

    it('user gets a text attachment uploaded as its text content', async () => {
        resetRemoteRefMocks();
        const requestContext = context({ providerId: 52 });
        vi.mocked(requestContext.fetch).mockResolvedValue(jsonResponse({ id: 'file-text' }));
        const textFile = filePart({
            name: 'notes.txt',
            mimeType: 'text/plain',
            kind: 'text',
            textContent: 'hello world',
            base64Data: undefined,
        });

        const resolved = await resolveProviderAttachmentRemoteRef(
            textFile,
            decision({ canReuseRemoteRef: false, shouldUpload: true }),
            requestContext
        );

        expect(resolved).toEqual({ strategy: 'openai-file-id', value: 'file-text' });
    });

    it('user gets the file sent inline when the provider accepts the upload without an id', async () => {
        resetRemoteRefMocks();
        const requestContext = context({ providerId: 53 });
        vi.mocked(requestContext.fetch).mockResolvedValue(jsonResponse({}));
        const resolved = await resolveProviderAttachmentRemoteRef(
            filePart(),
            decision({ canReuseRemoteRef: false, shouldUpload: true }),
            requestContext
        );

        expect(resolved).toBeNull();
        expect(upsertAttachmentRemoteRefMock).not.toHaveBeenCalled();
    });

    it('user keeps sending messages when the network error is not an Error object', async () => {
        resetRemoteRefMocks();
        const requestContext = context({ providerId: 54 });
        vi.mocked(requestContext.fetch).mockRejectedValue('Unauthorized');

        await expect(
            resolveProviderAttachmentRemoteRef(
                filePart(),
                decision({ canReuseRemoteRef: false, shouldUpload: true }),
                requestContext
            )
        ).resolves.toBeNull();
        vi.mocked(requestContext.fetch).mockClear();

        await resolveProviderAttachmentRemoteRef(
            filePart(),
            decision({ canReuseRemoteRef: false, shouldUpload: true }),
            requestContext
        );

        // The rejection says the provider will never accept uploads.
        expect(requestContext.fetch).not.toHaveBeenCalled();
    });

    it('user gets the file sent inline when the upload fails for no stated reason', async () => {
        resetRemoteRefMocks();
        const requestContext = context({ providerId: 55 });
        vi.mocked(requestContext.fetch).mockRejectedValue(undefined);

        const resolved = await resolveProviderAttachmentRemoteRef(
            filePart(),
            decision({ canReuseRemoteRef: false, shouldUpload: true }),
            requestContext
        );

        expect(resolved).toBeNull();
        expect(upsertAttachmentRemoteRefMock).not.toHaveBeenCalled();
    });

    it('user gets the file sent inline when the upload throws an unclassified error', async () => {
        resetRemoteRefMocks();
        const requestContext = context({ providerId: 56 });
        vi.mocked(requestContext.fetch).mockRejectedValue(new Error('socket hang up'));

        const resolved = await resolveProviderAttachmentRemoteRef(
            filePart(),
            decision({ canReuseRemoteRef: false, shouldUpload: true }),
            requestContext
        );

        expect(resolved).toBeNull();
        expect(upsertAttachmentRemoteRefMock).not.toHaveBeenCalled();
        vi.mocked(requestContext.fetch).mockClear();

        // A transient failure is retried on the next message rather than disabled.
        vi.mocked(requestContext.fetch).mockResolvedValue(jsonResponse({ id: 'file-retried' }));
        await expect(
            resolveProviderAttachmentRemoteRef(
                filePart(),
                decision({ canReuseRemoteRef: false, shouldUpload: true }),
                requestContext
            )
        ).resolves.toEqual({ strategy: 'openai-file-id', value: 'file-retried' });
    });
});

describe('user reuses a stored remote reference', () => {
    it('user keeps the stored reference when the touch fails', async () => {
        resetRemoteRefMocks();
        const requestContext = context({ providerId: 61 });
        findAttachmentRemoteRefMock.mockResolvedValue({
            id: 4,
            remote_ref: 'file-kept',
            expires_at: null,
        });
        touchAttachmentRemoteRefLastUsedMock.mockRejectedValue(new Error('db busy'));

        const resolved = await resolveProviderAttachmentRemoteRef(
            filePart(),
            decision(),
            requestContext
        );

        expect(resolved).toEqual({ strategy: 'openai-file-id', value: 'file-kept' });
        expect(requestContext.fetch).not.toHaveBeenCalled();
    });

    it('user gets the stored reference reused when its expiry cannot be read', async () => {
        resetRemoteRefMocks();
        const requestContext = context({ providerId: 62 });
        findAttachmentRemoteRefMock.mockResolvedValue({
            id: 5,
            remote_ref: 'file-unparsed',
            expires_at: 'sometime later',
        });

        const resolved = await resolveProviderAttachmentRemoteRef(
            filePart(),
            decision(),
            requestContext
        );

        expect(resolved).toEqual({ strategy: 'openai-file-id', value: 'file-unparsed' });
        expect(requestContext.fetch).not.toHaveBeenCalled();
    });
});
