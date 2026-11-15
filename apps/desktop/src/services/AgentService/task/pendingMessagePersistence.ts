import {
    appendPendingMessage,
    clearPendingMessagesForSession,
    deletePendingMessage,
    findPendingMessagesBySessionId,
    reorderPendingMessages,
    updatePendingMessage,
    updatePendingMessagesModel,
} from '@database/queries';
import type { SessionPendingMessageEntity } from '@database/types';
import { log } from '@services/ObservabilityService';

import {
    type AttachmentIndex,
    ensurePersistedAttachmentIndex,
    hydratePersistedAttachmentByHash,
} from '@/services/AgentService/infrastructure/attachments';
import type { SelectedSkill } from '@/services/AgentService/skills';
import { createInputHistorySnapshot, type InputHistorySnapshot } from '@/types/session';
import { parseDbDateTimestamp, toDbTimestamp } from '@/utils/date';

import type { PendingUserMessage } from './types';

const PENDING_MESSAGE_PAYLOAD_VERSION = 1;

interface PendingAttachmentPayload {
    hash: string;
    originPath: string;
    name: string;
    type: AttachmentIndex['type'];
}

interface PendingMessagePayloadV1 {
    attachments: PendingAttachmentPayload[];
    skills?: Array<{ name: string; path: string }>;
    editorDoc?: InputHistorySnapshot['editorDoc'];
    excludeFromHistory?: boolean;
}

interface DecodedPendingMessage {
    message: PendingUserMessage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parsePayload(raw: string): PendingMessagePayloadV1 | null {
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!isRecord(parsed)) {
            return null;
        }

        const attachments = Array.isArray(parsed.attachments)
            ? parsed.attachments.filter((attachment): attachment is PendingAttachmentPayload => {
                  if (!isRecord(attachment)) {
                      return false;
                  }
                  return (
                      typeof attachment.hash === 'string' &&
                      attachment.hash.length > 0 &&
                      typeof attachment.originPath === 'string' &&
                      typeof attachment.name === 'string' &&
                      (attachment.type === 'image' || attachment.type === 'file')
                  );
              })
            : [];
        const skills = Array.isArray(parsed.skills)
            ? parsed.skills.filter((skill): skill is SelectedSkill => {
                  if (!isRecord(skill)) {
                      return false;
                  }
                  return typeof skill.name === 'string' && typeof skill.path === 'string';
              })
            : undefined;

        return {
            attachments,
            ...(skills?.length ? { skills } : {}),
            ...(isRecord(parsed.editorDoc)
                ? { editorDoc: parsed.editorDoc as InputHistorySnapshot['editorDoc'] }
                : {}),
            ...(parsed.excludeFromHistory === true ? { excludeFromHistory: true } : {}),
        };
    } catch {
        return null;
    }
}

async function snapshotAttachments(
    attachments: readonly AttachmentIndex[]
): Promise<PendingAttachmentPayload[]> {
    const results = await Promise.allSettled(
        attachments.map((attachment) => ensurePersistedAttachmentIndex(attachment))
    );
    const persisted: PendingAttachmentPayload[] = [];
    const seen = new Set<string>();

    for (const [index, result] of results.entries()) {
        const attachment = attachments[index];
        if (!attachment) {
            continue;
        }
        if (result.status === 'rejected') {
            log.error('[PendingMessagePersistence] Failed to cache attachment:', result.reason);
            continue;
        }
        if (!attachment.hash || seen.has(attachment.hash)) {
            continue;
        }
        seen.add(attachment.hash);
        persisted.push({
            hash: attachment.hash,
            originPath: attachment.originPath,
            name: attachment.name,
            type: attachment.type,
        });
    }

    return persisted;
}

async function serializePayload(message: PendingUserMessage): Promise<string> {
    const payload: PendingMessagePayloadV1 = {
        attachments: await snapshotAttachments(message.attachments),
        ...(message.inputSnapshot?.skills?.length
            ? {
                  skills: message.inputSnapshot.skills.map((skill) => ({
                      name: skill.name,
                      path: skill.path,
                  })),
              }
            : {}),
        ...(message.inputSnapshot?.editorDoc ? { editorDoc: message.inputSnapshot.editorDoc } : {}),
        ...(message.inputSnapshot?.excludeFromHistory ? { excludeFromHistory: true } : {}),
    };

    return JSON.stringify(payload);
}

function buildCreateData(sessionId: number, message: PendingUserMessage, payloadJson: string) {
    const timestamp = toDbTimestamp(new Date(message.createdAt));
    return {
        id: message.id,
        session_id: sessionId,
        prompt: message.prompt,
        model_id: message.modelId ?? null,
        provider_id: message.providerId ?? null,
        payload_version: PENDING_MESSAGE_PAYLOAD_VERSION,
        payload_json: payloadJson,
        created_at: timestamp,
        updated_at: timestamp,
    };
}

async function decodeRow(row: SessionPendingMessageEntity): Promise<DecodedPendingMessage | null> {
    const payload = parsePayload(row.payload_json);
    if (!payload) {
        log.error('[PendingMessagePersistence] Dropping an invalid pending message payload:', {
            id: row.id,
            sessionId: row.session_id,
        });
        await deletePendingMessage(row.id);
        return null;
    }

    const hydrated = await Promise.all(
        payload.attachments.map((attachment) =>
            hydratePersistedAttachmentByHash(attachment.hash, {
                originPath: attachment.originPath,
                name: attachment.name,
            })
        )
    );
    const attachments = hydrated.filter(
        (attachment): attachment is AttachmentIndex => attachment !== null
    );
    if (attachments.length !== payload.attachments.length) {
        log.warn('[PendingMessagePersistence] Dropped attachments missing from the cache:', {
            id: row.id,
            expected: payload.attachments.length,
            restored: attachments.length,
        });
    }

    const inputSnapshot = createInputHistorySnapshot({
        text: row.prompt,
        attachments,
        skills: payload.skills as SelectedSkill[] | undefined,
        editorDoc: payload.editorDoc ?? null,
        excludeFromHistory: payload.excludeFromHistory,
    });

    return {
        message: {
            id: row.id,
            prompt: row.prompt,
            attachments,
            inputSnapshot,
            modelId: row.model_id ?? undefined,
            providerId: row.provider_id ?? undefined,
            delivery: 'queue',
            createdAt: parseDbDateTimestamp(row.created_at),
        },
    };
}

export interface PendingMessageStore {
    enqueue(sessionId: number, message: PendingUserMessage): void;
    update(sessionId: number, message: PendingUserMessage): void;
    remove(sessionId: number, messageId: string): void;
    clear(sessionId: number): void;
    reorder(sessionId: number, orderedMessageIds: readonly string[]): void;
    updateModel(sessionId: number, modelId: string | null, providerId: number | null): void;
    flush(sessionId: number): Promise<void>;
    load(sessionId: number): Promise<PendingUserMessage[]>;
}

/**
 * Serializes pending-message writes per session and restores them from SQLite.
 *
 * Queue mutations stay synchronous for the UI. The returned promises are
 * allowed to settle in the background, but delivery awaits `flush()` first so
 * a row cannot be deleted before its insert has reached SQLite.
 */
export class PendingMessagePersistence implements PendingMessageStore {
    private readonly writes = new Map<number, Promise<void>>();

    enqueue(sessionId: number, message: PendingUserMessage): void {
        this.schedule(sessionId, async () => {
            const payloadJson = await serializePayload(message);
            await appendPendingMessage(buildCreateData(sessionId, message, payloadJson));
        });
    }

    update(sessionId: number, message: PendingUserMessage): void {
        this.schedule(sessionId, async () => {
            const payloadJson = await serializePayload(message);
            await updatePendingMessage(message.id, {
                prompt: message.prompt,
                model_id: message.modelId ?? null,
                provider_id: message.providerId ?? null,
                payload_version: PENDING_MESSAGE_PAYLOAD_VERSION,
                payload_json: payloadJson,
            });
        });
    }

    remove(sessionId: number, messageId: string): void {
        this.schedule(sessionId, () => deletePendingMessage(messageId));
    }

    clear(sessionId: number): void {
        this.schedule(sessionId, () => clearPendingMessagesForSession(sessionId));
    }

    reorder(sessionId: number, orderedMessageIds: readonly string[]): void {
        this.schedule(sessionId, () => reorderPendingMessages(sessionId, orderedMessageIds));
    }

    updateModel(sessionId: number, modelId: string | null, providerId: number | null): void {
        this.schedule(sessionId, () => updatePendingMessagesModel(sessionId, modelId, providerId));
    }

    async flush(sessionId: number): Promise<void> {
        await this.writes.get(sessionId);
    }

    async load(sessionId: number): Promise<PendingUserMessage[]> {
        await this.flush(sessionId);
        const rows = await findPendingMessagesBySessionId(sessionId);
        const decoded = await Promise.all(rows.map((row) => decodeRow(row)));
        return decoded.flatMap((entry) => (entry ? [entry.message] : []));
    }

    private schedule(sessionId: number, write: () => Promise<void>): void {
        const previous = this.writes.get(sessionId) ?? Promise.resolve();
        const next = previous
            .catch(() => {
                // Keep later writes independent from an earlier failed write.
            })
            .then(write)
            .catch((error) => {
                log.error(
                    '[PendingMessagePersistence] Failed to persist a pending message:',
                    error
                );
            });
        this.writes.set(sessionId, next);
        void next.finally(() => {
            if (this.writes.get(sessionId) === next) {
                this.writes.delete(sessionId);
            }
        });
    }
}
