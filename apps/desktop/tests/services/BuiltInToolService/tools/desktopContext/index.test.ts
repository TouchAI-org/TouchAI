import { beforeEach, describe, expect, it, vi } from 'vitest';

import { desktopContextTool } from '@/services/BuiltInToolService/tools/desktopContext';
import type { BaseBuiltInToolExecutionContext } from '@/services/BuiltInToolService/types';
import type { BoundDesktopContext } from '@/services/DesktopContextService/types';

const { captureSensitiveMock, createAttachmentMock } = vi.hoisted(() => ({
    captureSensitiveMock: vi.fn(),
    createAttachmentMock: vi.fn(),
}));

vi.mock('@/services/AgentService/infrastructure/attachments', () => ({
    createAttachment: createAttachmentMock,
}));

vi.mock('@/services/NativeService', () => ({
    native: {
        desktopContext: {
            captureSensitive: captureSensitiveMock,
        },
    },
}));

const desktopContext: BoundDesktopContext = {
    id: 'ctx-1',
    sequence: 1,
    capturedAt: '2026-06-02T12:00:00.000Z',
    boundAt: '2026-06-02T12:00:05.000Z',
    invocationSource: 'shortcut',
    platform: 'windows',
    summary: 'Visual Studio Code focused with a persisted desktop screenshot.',
    activeWindow: null,
    selectedText: {
        available: true,
        source: 'windows-uia-textpattern',
        text: 'selected text with token=secret-value',
        textLength: 37,
        truncated: false,
    },
    clipboard: {
        available: false,
        snapshotId: null,
        observedAt: null,
        text: null,
        textSummary: null,
        textLength: 0,
        imageCount: 0,
        fileCount: 0,
        reason: 'Clipboard is empty.',
    },
    screenshot: {
        available: true,
        path: 'E:/TouchAI/data/desktop-context/screenshots/ctx-1.png',
        mimeType: 'image/png',
        width: 1200,
        height: 800,
        target: 'active_display',
        persisted: true,
        capturedAt: '2026-06-02T12:00:00.000Z',
    },
    capabilities: [{ id: 'screenshot', supported: true, method: 'xcap-monitor-capture' }],
    redactions: [],
};

const approvedDesktopContext: BoundDesktopContext = {
    ...desktopContext,
    selectedText: {
        available: true,
        source: 'windows-uia-focused-textpattern',
        text: 'approved selected text',
        textLength: 22,
        truncated: false,
    },
    clipboard: {
        available: true,
        snapshotId: 'clip-approved',
        observedAt: 1770000000001,
        text: 'approved clipboard text',
        textSummary: 'approved clipboard text',
        textLength: 23,
        imageCount: 0,
        fileCount: 0,
    },
    screenshot: {
        available: true,
        path: 'E:/TouchAI/data/desktop-context/screenshots/ctx-1-approved.png',
        mimeType: 'image/png',
        width: 1600,
        height: 900,
        target: 'active_window',
        persisted: true,
        capturedAt: '2026-06-02T12:01:00.000Z',
    },
};

function createContext(
    overrides: Partial<BaseBuiltInToolExecutionContext> = {}
): BaseBuiltInToolExecutionContext {
    return {
        callId: 'call-1',
        iteration: 0,
        hasExecutedBuiltInTool: () => false,
        desktopContext,
        ...overrides,
    };
}

describe('desktopContextTool', () => {
    beforeEach(() => {
        captureSensitiveMock.mockReset();
        createAttachmentMock.mockReset();
        captureSensitiveMock.mockResolvedValue(approvedDesktopContext);
        createAttachmentMock.mockResolvedValue({
            id: 'attachment-1',
            type: 'image',
            path: approvedDesktopContext.screenshot.path,
            originPath: approvedDesktopContext.screenshot.path,
            name: 'ctx-1-approved.png',
            mimeType: 'image/png',
            supportStatus: 'supported',
        });
    });

    it('does not attach the screenshot for the safe default include set', async () => {
        const result = await desktopContextTool.execute({}, {}, createContext());

        expect(result.attachments).toBeUndefined();
        expect(createAttachmentMock).not.toHaveBeenCalled();
        expect(captureSensitiveMock).not.toHaveBeenCalled();
        const payload = JSON.parse(result.result);
        expect(payload).toMatchObject({
            available: true,
            summary: desktopContext.summary,
            selectedText: {
                available: true,
                textSummary: 'selected text with token=[REDACTED:secret]',
            },
        });
        expect(payload.selectedText).not.toHaveProperty('fullText');
        expect(payload).not.toHaveProperty('clipboard');
        expect(payload).not.toHaveProperty('screenshot');
    });

    it('does not require approval for the safe default include set', async () => {
        expect(
            desktopContextTool.buildApprovalRequest(
                {},
                {},
                'builtin__get_desktop_context',
                createContext()
            )
        ).toBeNull();
    });

    it.each([
        ['selected text full text', ['selected_text.full_text']],
        ['clipboard', ['clipboard.summary']],
        ['screenshot', ['screenshot.metadata']],
    ])('requires approval before reading %s context', async (_label, include) => {
        const approval = await desktopContextTool.buildApprovalRequest(
            { include },
            {},
            'builtin__get_desktop_context',
            createContext()
        );

        expect(approval).toMatchObject({
            title: expect.stringContaining('桌面上下文'),
            reason: expect.stringContaining('发送给模型'),
        });
    });

    it('captures approved sensitive context before building the tool payload', async () => {
        const result = await desktopContextTool.execute(
            {
                include: ['selected_text.full_text', 'clipboard.full_text', 'screenshot.image'],
                screenshotTarget: 'active_window',
            },
            {},
            createContext()
        );

        expect(captureSensitiveMock).toHaveBeenCalledWith(
            'ctx-1',
            ['selected_text.full_text', 'clipboard.full_text', 'screenshot.image'],
            'active_window'
        );
        expect(createAttachmentMock).toHaveBeenCalledWith(
            'image',
            'E:/TouchAI/data/desktop-context/screenshots/ctx-1-approved.png'
        );
        expect(result.attachments).toEqual([
            expect.objectContaining({
                id: 'attachment-1',
                type: 'image',
                path: 'E:/TouchAI/data/desktop-context/screenshots/ctx-1-approved.png',
            }),
        ]);
        expect(JSON.parse(result.result)).toMatchObject({
            selectedText: {
                fullText: 'approved selected text',
            },
            clipboard: {
                fullText: 'approved clipboard text',
            },
            screenshot: {
                path: 'E:/TouchAI/data/desktop-context/screenshots/ctx-1-approved.png',
            },
        });
        expect(result.desktopContextArtifact).toMatchObject({
            id: 'ctx-1',
            boundAt: '2026-06-02T12:00:05.000Z',
            screenshot: {
                path: 'E:/TouchAI/data/desktop-context/screenshots/ctx-1-approved.png',
            },
        });
    });

    it('returns the stale capsule reason when sensitive capture is unavailable', async () => {
        captureSensitiveMock.mockResolvedValue(null);

        const result = await desktopContextTool.execute(
            { include: ['selected_text.full_text'] },
            {},
            createContext()
        );

        expect(JSON.parse(result.result)).toMatchObject({
            selectedText: {
                available: true,
                fullText: 'selected text with token=secret-value',
            },
        });
        expect(result.desktopContextArtifact).toBeUndefined();
    });
});
