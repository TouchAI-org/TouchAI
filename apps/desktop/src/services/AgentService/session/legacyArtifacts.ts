// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { LegacyArtifactInfo, LegacyArtifactPayload, SessionMessage } from '@/types/session';

import {
    ensureLegacyArtifactPart,
    ensureLegacyArtifacts,
    findLegacyArtifactTarget,
    findLegacyArtifactTargetByCallId,
    removeLegacyArtifactByCallId,
    removeLegacyArtifactById,
    retargetLegacyArtifactPart,
} from './legacyArtifactRecords';

/** Read-only compatibility mapper for artifacts created before OpenUI replies. */
export class LegacyArtifactHistory {
    upsertArtifact(
        history: SessionMessage[],
        messageId: string,
        payload: LegacyArtifactPayload
    ): LegacyArtifactInfo | null {
        const targetMessage =
            findLegacyArtifactTarget(history, payload.widgetId, messageId)?.message ??
            findLegacyArtifactTargetByCallId(history, payload.callId, messageId)?.message ??
            history.find((message) => message.id === messageId);
        if (!targetMessage) return null;

        const artifacts = ensureLegacyArtifacts(targetMessage);
        const existing =
            artifacts.find((artifact) => artifact.widgetId === payload.widgetId) ??
            artifacts.find((artifact) => artifact.callId === payload.callId);

        if (existing) {
            const previousId = existing.widgetId;
            Object.assign(existing, payload, { id: payload.widgetId, updatedAt: Date.now() });
            retargetLegacyArtifactPart(targetMessage, previousId, payload.widgetId);
            ensureLegacyArtifactPart(targetMessage, payload.widgetId);
            return existing;
        }

        const artifact: LegacyArtifactInfo = {
            id: payload.widgetId,
            ...payload,
            updatedAt: Date.now(),
        };
        artifacts.push(artifact);
        ensureLegacyArtifactPart(targetMessage, payload.widgetId);
        return artifact;
    }

    removeArtifactById(
        history: SessionMessage[],
        widgetId: string,
        preferredMessageId?: string
    ): void {
        removeLegacyArtifactById(history, widgetId, preferredMessageId);
    }

    removeArtifactByCallId(history: SessionMessage[], callId: string): void {
        removeLegacyArtifactByCallId(history, callId);
    }
}
