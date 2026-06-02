// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { native } from '@/services/NativeService';

import type { BoundDesktopContext, DesktopContextCapsule } from './types';

class DesktopContextService {
    async bindCapsule(capsuleId: string | null | undefined): Promise<BoundDesktopContext | null> {
        const normalizedCapsuleId = capsuleId?.trim();
        if (!normalizedCapsuleId) {
            return null;
        }

        try {
            return await native.desktopContext.bindCapsule(normalizedCapsuleId);
        } catch (error) {
            console.warn('[DesktopContextService] Failed to bind desktop context capsule:', error);
            return null;
        }
    }

    async getCapsule(capsuleId: string): Promise<DesktopContextCapsule | null> {
        return await native.desktopContext.getCapsule(capsuleId);
    }
}

export const desktopContextService = new DesktopContextService();

export type {
    BoundDesktopContext,
    DesktopContextActiveWindow,
    DesktopContextCapability,
    DesktopContextCapsule,
    DesktopContextClipboard,
    DesktopContextInclude,
    DesktopContextPromptMetadata,
    DesktopContextRedaction,
    DesktopContextScreenshot,
    DesktopContextSelectedText,
    DesktopContextToolRequest,
    DesktopContextTurnArtifact,
    UserMessageDesktopContext,
} from './types';
export { buildDesktopContextPromptMetadata, buildDesktopContextToolPayload } from './toolPayload';
