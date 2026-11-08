// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { LegacyArtifactInfo, SessionMessage } from '@/types/session';

export interface LegacyArtifactTarget {
    message: SessionMessage;
    artifact: LegacyArtifactInfo;
}

export function ensureLegacyArtifacts(message: SessionMessage): LegacyArtifactInfo[] {
    if (!message.legacyArtifacts) {
        message.legacyArtifacts = [];
    }

    return message.legacyArtifacts;
}

export function ensureLegacyArtifactPart(message: SessionMessage, artifactId: string): void {
    if (message.parts.some((part) => part.type === 'widget' && part.widgetId === artifactId))
        return;
    message.parts.push({ id: crypto.randomUUID(), type: 'widget', widgetId: artifactId });
}

export function removeLegacyArtifactPart(message: SessionMessage, artifactId: string): void {
    message.parts = message.parts.filter(
        (part) => !(part.type === 'widget' && part.widgetId === artifactId)
    );
}

export function retargetLegacyArtifactPart(
    message: SessionMessage,
    previousArtifactId: string,
    nextArtifactId: string
): void {
    if (previousArtifactId === nextArtifactId) return;
    for (const part of message.parts) {
        if (part.type === 'widget' && part.widgetId === previousArtifactId)
            part.widgetId = nextArtifactId;
    }
}

export function removeLegacyArtifactById(
    history: SessionMessage[],
    artifactId: string,
    preferredMessageId?: string
): void {
    const target = findLegacyArtifactTarget(history, artifactId, preferredMessageId);
    if (!target) return;
    target.message.legacyArtifacts = target.message.legacyArtifacts?.filter(
        (artifact) => artifact.widgetId !== artifactId
    );
    removeLegacyArtifactPart(target.message, artifactId);
}

export function removeLegacyArtifactByCallId(history: SessionMessage[], callId: string): void {
    for (const message of history) {
        if (message.role !== 'assistant' || !message.legacyArtifacts?.length) continue;
        const removedArtifactIds = message.legacyArtifacts
            .filter((artifact) => artifact.callId === callId)
            .map((artifact) => artifact.widgetId);
        if (removedArtifactIds.length === 0) continue;
        message.legacyArtifacts = message.legacyArtifacts.filter(
            (artifact) => !removedArtifactIds.includes(artifact.widgetId)
        );
        for (const artifactId of removedArtifactIds) removeLegacyArtifactPart(message, artifactId);
    }
}

export function findLegacyArtifactTargetByCallId(
    history: SessionMessage[],
    callId: string,
    preferredMessageId?: string
): LegacyArtifactTarget | null {
    return findArtifactTargetInHistory(history, preferredMessageId, (artifact) => {
        return artifact.callId === callId;
    });
}

export function findLegacyArtifactTarget(
    history: SessionMessage[],
    widgetId: string,
    preferredMessageId?: string
): LegacyArtifactTarget | null {
    return findArtifactTargetInHistory(history, preferredMessageId, (artifact) => {
        return artifact.widgetId === widgetId;
    });
}

function findArtifactTargetInHistory(
    history: SessionMessage[],
    preferredMessageId: string | undefined,
    matches: (artifact: LegacyArtifactInfo) => boolean
): LegacyArtifactTarget | null {
    if (preferredMessageId) {
        const preferredMessage = history.find((message) => message.id === preferredMessageId);
        const preferredArtifact = preferredMessage?.legacyArtifacts?.find(matches);
        if (preferredMessage && preferredArtifact) {
            return { message: preferredMessage, artifact: preferredArtifact };
        }
    }

    for (let index = history.length - 1; index >= 0; index -= 1) {
        const message = history[index];
        if (!message || message.role !== 'assistant' || message.id === preferredMessageId) {
            continue;
        }

        const artifact = message.legacyArtifacts?.find(matches);
        if (artifact) {
            return { message, artifact };
        }
    }

    return null;
}
