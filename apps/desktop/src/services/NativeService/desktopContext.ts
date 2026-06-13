// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { invoke } from '@tauri-apps/api/core';

import type {
    BoundDesktopContext,
    DesktopContextCapsule,
    DesktopContextInclude,
    DesktopContextToolRequest,
} from '@/services/DesktopContextService/types';

export const desktopContext = {
    getCapsule(capsuleId: string): Promise<DesktopContextCapsule | null> {
        return invoke<DesktopContextCapsule | null>('desktop_context_get_capsule', {
            capsuleId,
        });
    },

    bindCapsule(capsuleId: string): Promise<BoundDesktopContext | null> {
        return invoke<BoundDesktopContext | null>('desktop_context_bind_capsule', {
            capsuleId,
        });
    },

    captureSensitive(
        capsuleId: string,
        include: DesktopContextInclude[],
        screenshotTarget?: DesktopContextToolRequest['screenshotTarget']
    ): Promise<DesktopContextCapsule | null> {
        return invoke<DesktopContextCapsule | null>('desktop_context_capture_sensitive', {
            capsuleId,
            include,
            screenshotTarget,
        });
    },

    persistScreenshot(turnId: number, capsuleId: string): Promise<string> {
        return invoke<string>('desktop_context_persist_screenshot', {
            turnId,
            capsuleId,
        });
    },

    clearPersistedScreenshots(): Promise<void> {
        return invoke<void>('desktop_context_clear_persisted_screenshots');
    },

    setCaptureEnabled(enabled: boolean): Promise<void> {
        return invoke<void>('desktop_context_set_capture_enabled', {
            enabled,
        });
    },

    setCaptureConfig(config: {
        captureSelectedText: boolean;
        captureBrowserUrl: boolean;
        enableScreenshotOcr: boolean;
    }): Promise<void> {
        return invoke<void>('desktop_context_set_capture_config', {
            captureSelectedText: config.captureSelectedText,
            captureBrowserUrl: config.captureBrowserUrl,
            enableScreenshotOcr: config.enableScreenshotOcr,
        });
    },
} as const;
