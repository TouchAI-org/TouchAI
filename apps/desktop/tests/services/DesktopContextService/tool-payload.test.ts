// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { describe, expect, it } from 'vitest';

import {
    buildDesktopContextPromptMetadata,
    buildDesktopContextToolPayload,
} from '@/services/DesktopContextService/toolPayload';
import type { BoundDesktopContext } from '@/services/DesktopContextService/types';

const context: BoundDesktopContext = {
    id: 'ctx-1',
    sequence: 7,
    capturedAt: '2026-06-02T12:00:00.000Z',
    boundAt: '2026-06-02T12:00:05.000Z',
    invocationSource: 'shortcut',
    platform: 'windows',
    summary: 'Visual Studio Code focused with selected Rust error text.',
    activeWindow: {
        title: 'main.rs - TouchAI',
        appName: 'Visual Studio Code',
        processName: 'Code.exe',
        processId: 123,
        windowHandle: '0x123',
        bounds: { x: 0, y: 0, width: 1200, height: 800 },
    },
    selectedText: {
        available: true,
        source: 'win32-edit-control',
        text: 'selected compiler error with sk-live-secret-token and Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
        textLength: 102,
        truncated: false,
    },
    clipboard: {
        available: true,
        snapshotId: 'clip-1',
        observedAt: 1770000000000,
        text: 'clipboard secret',
        textSummary: 'clipboard secret',
        textLength: 16,
        imageCount: 0,
        fileCount: 0,
    },
    screenshot: {
        available: true,
        path: 'E:/TouchAI/data/session-context/ctx-1.png',
        mimeType: 'image/png',
        width: 1200,
        height: 800,
        target: 'active_display',
        persisted: true,
        capturedAt: '2026-06-02T12:00:00.000Z',
    },
    capabilities: [{ id: 'screenshot', supported: true, method: 'gdi' }],
    redactions: [{ field: 'clipboard.fullText', reason: 'not requested by default' }],
};

describe('buildDesktopContextToolPayload', () => {
    it('returns unavailable when no capsule is bound to the turn', () => {
        expect(buildDesktopContextToolPayload(null)).toEqual({
            available: false,
            reason: 'No desktop context capsule is bound to this turn.',
        });
    });

    it('uses a safe default include set with redacted selected text but no clipboard or screenshot contents', () => {
        const payload = buildDesktopContextToolPayload(context);

        expect(payload).toMatchObject({
            available: true,
            capsuleId: 'ctx-1',
            summary: context.summary,
            activeWindow: context.activeWindow,
            selectedText: {
                available: true,
                source: 'win32-edit-control',
                textSummary:
                    'selected compiler error with [REDACTED:secret] and Authorization: [REDACTED:secret]',
                textLength: 102,
                truncated: false,
            },
            capabilities: context.capabilities,
        });
        expect(payload.redactions).toEqual(
            expect.arrayContaining([
                ...context.redactions,
                {
                    field: 'selectedText.textSummary',
                    reason: 'Sensitive-looking selected text was redacted before default prompt/tool exposure.',
                },
            ])
        );
        expect(payload.selectedText).not.toHaveProperty('fullText');
        expect(payload).not.toHaveProperty('clipboard');
        expect(payload).not.toHaveProperty('screenshot');
    });

    it('returns selected text metadata only when explicitly requested', () => {
        const payload = buildDesktopContextToolPayload(context, {
            include: ['selected_text.summary'],
        });

        expect(payload.selectedText).toMatchObject({
            available: true,
            source: 'win32-edit-control',
            textSummary:
                'selected compiler error with [REDACTED:secret] and Authorization: [REDACTED:secret]',
            textLength: 102,
            truncated: false,
        });
        expect(payload.selectedText).not.toHaveProperty('fullText');
    });

    it('returns clipboard metadata only when explicitly requested', () => {
        const payload = buildDesktopContextToolPayload(context, {
            include: ['clipboard.summary'],
        });

        expect(payload.clipboard).toMatchObject({
            textSummary: 'clipboard secret',
            textLength: 16,
        });
        expect(payload.clipboard).not.toHaveProperty('fullText');
    });

    it('returns screenshot metadata only when explicitly requested', () => {
        const payload = buildDesktopContextToolPayload(context, {
            include: ['screenshot.metadata'],
        });

        expect(payload.screenshot).toMatchObject({
            available: true,
            width: 1200,
            height: 800,
            persisted: true,
        });
        expect(payload.screenshot).not.toHaveProperty('path');
    });

    it('returns sensitive fields only when the include array asks for them', () => {
        const payload = buildDesktopContextToolPayload(context, {
            include: ['selected_text.full_text', 'clipboard.full_text', 'screenshot.image'],
        });

        expect(payload).not.toHaveProperty('summary');
        expect(payload.selectedText).toMatchObject({
            fullText:
                'selected compiler error with sk-live-secret-token and Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
        });
        expect(payload.clipboard).toMatchObject({
            fullText: 'clipboard secret',
        });
        expect(payload.screenshot).toMatchObject({
            path: 'E:/TouchAI/data/session-context/ctx-1.png',
            persisted: true,
        });
    });

    it('exposes screenshot availability in prompt metadata without leaking the image path', () => {
        expect(buildDesktopContextPromptMetadata(context)).toMatchObject({
            capsuleId: 'ctx-1',
            summary: 'Visual Studio Code focused with selected Rust error text.',
            selectedTextSummary:
                'selected compiler error with [REDACTED:secret] and Authorization: [REDACTED:secret]',
            screenshotAvailable: true,
            screenshotPersisted: true,
            screenshotWidth: 1200,
            screenshotHeight: 800,
        });
    });
});
