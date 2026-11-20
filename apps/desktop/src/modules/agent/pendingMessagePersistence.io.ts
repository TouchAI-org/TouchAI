import { db } from '@database';
import { databaseErrorCause } from '@database/errors';
import {
    clearPendingMessagesForSession,
    deletePendingMessage,
    findPendingMessagesBySessionId,
    reorderPendingMessages,
    savePendingMessage,
    updatePendingMessagesModel,
} from '@database/queries';
import type { SessionPendingMessageEntity } from '@database/types';

import { parseDbDateTimestamp, toDbTimestamp } from '@/utils/date';

import type {
    AttachmentReference as AttachmentIndex,
    InputHistorySnapshot,
} from './contracts/history';
import { createInputHistorySnapshot } from './contracts/history';
import type { PendingMessageStore } from './contracts/host';
import type { PendingUserMessage } from './contracts/task';

export interface PendingMessagePersistenceHost {
    prepare(attachment: AttachmentIndex): Promise<unknown>;
    hydrate(
        hash: string,
        options: { originPath: string; name: string }
    ): Promise<AttachmentIndex | null>;
    diagnostics: {
        error(message: string, error: unknown): void;
        warn(message: string, error: unknown): void;
    };
}

const PENDING_MESSAGE_PAYLOAD_VERSION = 1;

interface PendingAttachmentPayload {
    hash: string;
    originPath: string;
    name: string;
    type: AttachmentIndex['type'];
    draftInsertionOffset?: number;
}

interface PendingMessagePayloadV1 {
    attachments: PendingAttachmentPayload[];
    skills?: Array<{ name: string; path: string }>;
    editorDoc?: InputHistorySnapshot['editorDoc'];
    excludeFromHistory?: boolean;
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
            ? parsed.skills.filter((skill): skill is { name: string; path: string } => {
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
    attachments: readonly AttachmentIndex[],
    host: PendingMessagePersistenceHost
): Promise<PendingAttachmentPayload[]> {
    const results = await Promise.allSettled(
        attachments.map((attachment) => host.prepare(attachment))
    );
    const persisted: PendingAttachmentPayload[] = [];

    for (const [index, result] of results.entries()) {
        const attachment = attachments[index];
        if (!attachment) {
            continue;
        }
        if (result.status === 'rejected') {
            throw result.reason;
        }
        if (!attachment.hash) {
            throw new Error('A queued attachment has no persisted content hash');
        }
        persisted.push({
            hash: attachment.hash,
            originPath: attachment.originPath,
            name: attachment.name,
            type: attachment.type,
            draftInsertionOffset: attachment.draftInsertionOffset,
        });
    }

    return persisted;
}

async function serializePayload(
    message: PendingUserMessage,
    host: PendingMessagePersistenceHost
): Promise<string> {
    const payload: PendingMessagePayloadV1 = {
        attachments: await snapshotAttachments(message.attachments, host),
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

async function decodeRow(
    row: SessionPendingMessageEntity,
    host: PendingMessagePersistenceHost
): Promise<PendingUserMessage | null> {
    const payload = parsePayload(row.payload_json);
    if (!payload) {
        host.diagnostics.error(
            '[PendingMessagePersistence] Dropping an invalid pending message payload:',
            {
                id: row.id,
                sessionId: row.session_id,
            }
        );
        await deletePendingMessage(row.id);
        return null;
    }

    const hydrated = await Promise.all(
        payload.attachments.map(async (attachment) => {
            const restored = await host.hydrate(attachment.hash, {
                originPath: attachment.originPath,
                name: attachment.name,
            });
            const offset = attachment.draftInsertionOffset;
            if (restored && typeof offset === 'number' && Number.isFinite(offset)) {
                restored.draftInsertionOffset = offset;
            }
            return restored;
        })
    );
    const attachments = hydrated.filter(
        (attachment): attachment is AttachmentIndex => attachment !== null
    );
    if (attachments.length !== payload.attachments.length) {
        host.diagnostics.warn(
            '[PendingMessagePersistence] Dropped attachments missing from the cache:',
            {
                id: row.id,
                expected: payload.attachments.length,
                restored: attachments.length,
            }
        );
    }

    const inputSnapshot = createInputHistorySnapshot({
        text: row.prompt,
        attachments,
        skills: payload.skills,
        editorDoc: payload.editorDoc ?? null,
        excludeFromHistory: payload.excludeFromHistory,
    });

    return {
        id: row.id,
        prompt: row.prompt,
        attachments,
        inputSnapshot,
        modelId: row.model_id ?? undefined,
        providerId: row.provider_id ?? undefined,
        delivery: 'queue',
        createdAt: parseDbDateTimestamp(row.created_at),
    };
}

type PendingMutation =
    | { type: 'save'; message: PendingUserMessage; isNew: boolean }
    | { type: 'remove' };

interface PendingWriteBatch {
    messages: Map<string, PendingMutation>;
    clear: boolean;
    model?: { modelId: string | null; providerId: number | null };
    order?: readonly string[];
}

interface SessionWrites {
    pending: PendingWriteBatch;
    active?: PendingWriteBatch;
    running?: Promise<void>;
    failure?: { error: unknown };
}

function createWriteBatch(): PendingWriteBatch {
    return { messages: new Map(), clear: false };
}

function hasPendingWrites(batch: PendingWriteBatch): boolean {
    return batch.clear || batch.messages.size > 0 || !!batch.model || !!batch.order;
}

function applyModelToBatch(batch: PendingWriteBatch): void {
    if (!batch.model) {
        return;
    }
    for (const mutation of batch.messages.values()) {
        if (mutation.type === 'save') {
            mutation.message = {
                ...mutation.message,
                modelId: batch.model.modelId ?? undefined,
                providerId: batch.model.providerId ?? undefined,
            };
        }
    }
}

function mergeWriteBatches(
    previous: PendingWriteBatch,
    latest: PendingWriteBatch
): PendingWriteBatch {
    if (latest.clear) {
        return latest;
    }
    if (latest.model) {
        previous.model = latest.model;
        applyModelToBatch(previous);
    }
    for (const [messageId, mutation] of latest.messages) {
        const older = previous.messages.get(messageId);
        if (older?.type === 'save' && older.isNew) {
            if (mutation.type === 'remove') {
                previous.messages.delete(messageId);
                continue;
            }
            mutation.isNew = true;
        }
        previous.messages.set(messageId, mutation);
    }
    previous.order = latest.order ?? previous.order;
    return previous;
}

/**
 * Serializes pending-message writes per session and restores them from SQLite.
 *
 * Queue mutations stay synchronous for the UI. The returned promises are
 * allowed to settle in the background, but delivery awaits `flush()` first so
 * a row cannot be deleted before its insert has reached SQLite.
 */
export class PendingMessagePersistence implements PendingMessageStore {
    private readonly writes = new Map<number, SessionWrites>();

    constructor(private readonly host: PendingMessagePersistenceHost) {}

    enqueue(sessionId: number, message: PendingUserMessage): void {
        this.schedule(sessionId, (batch) => {
            batch.messages.set(message.id, { type: 'save', message, isNew: true });
        });
    }

    update(sessionId: number, message: PendingUserMessage): void {
        this.schedule(sessionId, (batch, active) => {
            const previous = batch.messages.get(message.id) ?? active?.messages.get(message.id);
            batch.messages.set(message.id, {
                type: 'save',
                message,
                isNew: previous?.type === 'save' && previous.isNew,
            });
        });
    }

    remove(sessionId: number, messageId: string): void {
        this.schedule(sessionId, (batch, active) => {
            const previous = batch.messages.get(messageId);
            if (previous?.type === 'save' && previous.isNew && !active?.messages.has(messageId)) {
                batch.messages.delete(messageId);
            } else {
                batch.messages.set(messageId, { type: 'remove' });
            }
        });
    }

    clear(sessionId: number): void {
        this.schedule(sessionId, (batch) => {
            batch.clear = true;
            batch.messages.clear();
            batch.model = undefined;
            batch.order = undefined;
        });
    }

    reorder(sessionId: number, orderedMessageIds: readonly string[]): void {
        this.schedule(sessionId, (batch) => {
            batch.order = [...orderedMessageIds];
        });
    }

    updateModel(sessionId: number, modelId: string | null, providerId: number | null): void {
        this.schedule(sessionId, (batch) => {
            batch.model = { modelId, providerId };
            applyModelToBatch(batch);
        });
    }

    async flush(sessionId: number): Promise<void> {
        const state = this.writes.get(sessionId);
        if (!state) {
            return;
        }
        if (!state.running) {
            this.startWrites(sessionId, state);
        }
        while (state.running) {
            await state.running;
        }
        if (state.failure) {
            throw state.failure.error;
        }
    }

    async load(sessionId: number): Promise<PendingUserMessage[]> {
        await this.flush(sessionId);
        const rows = await findPendingMessagesBySessionId(sessionId);
        const decoded = await Promise.all(
            rows.map(async (row) => {
                try {
                    return await decodeRow(row, this.host);
                } catch (error) {
                    this.host.diagnostics.error(
                        '[PendingMessagePersistence] Failed to restore a pending message:',
                        {
                            id: row.id,
                            sessionId: row.session_id,
                            errorType: error instanceof Error ? error.name : typeof error,
                        }
                    );
                    return null;
                }
            })
        );
        return decoded.filter((message): message is PendingUserMessage => message !== null);
    }

    private schedule(
        sessionId: number,
        change: (batch: PendingWriteBatch, active?: PendingWriteBatch) => void
    ): void {
        const state: SessionWrites = this.writes.get(sessionId) ?? { pending: createWriteBatch() };
        this.writes.set(sessionId, state);
        change(state.pending, state.active);
        if (!state.running) {
            this.startWrites(sessionId, state);
        }
    }

    private startWrites(sessionId: number, state: SessionWrites): void {
        state.failure = undefined;
        if (!hasPendingWrites(state.pending)) {
            this.writes.delete(sessionId);
            return;
        }
        state.running = this.persistBatches(sessionId, state).finally(() => {
            state.running = undefined;
            if (state.failure) {
                return;
            }
            if (hasPendingWrites(state.pending)) {
                this.startWrites(sessionId, state);
            } else if (this.writes.get(sessionId) === state) {
                this.writes.delete(sessionId);
            }
        });
    }

    private async persistBatches(sessionId: number, state: SessionWrites): Promise<void> {
        while (hasPendingWrites(state.pending)) {
            const batch = state.pending;
            state.pending = createWriteBatch();
            state.active = batch;
            try {
                const saved = new Map<string, ReturnType<typeof buildCreateData>>();
                for (const [messageId, mutation] of batch.messages) {
                    if (mutation.type === 'save') {
                        saved.set(
                            messageId,
                            buildCreateData(
                                sessionId,
                                mutation.message,
                                await serializePayload(mutation.message, this.host)
                            )
                        );
                    }
                }
                await db.transaction(async (database) => {
                    if (batch.clear) {
                        await clearPendingMessagesForSession(sessionId, database);
                    }
                    if (batch.model) {
                        await updatePendingMessagesModel(
                            sessionId,
                            batch.model.modelId,
                            batch.model.providerId,
                            database
                        );
                    }
                    for (const [messageId, mutation] of batch.messages) {
                        if (mutation.type === 'save') {
                            await savePendingMessage(saved.get(messageId)!, database);
                        } else {
                            await deletePendingMessage(messageId, database);
                        }
                    }
                    if (batch.order) {
                        await reorderPendingMessages(sessionId, batch.order, database);
                    }
                });
                if (!state.pending.clear) {
                    for (const messageId of saved.keys()) {
                        const pending = state.pending.messages.get(messageId);
                        if (pending?.type === 'save') {
                            pending.isNew = false;
                        }
                    }
                }
            } catch (error) {
                state.pending = mergeWriteBatches(batch, state.pending);
                if (hasPendingWrites(state.pending)) {
                    state.failure = {
                        error: databaseErrorCause(error),
                    };
                    this.host.diagnostics.error(
                        '[PendingMessagePersistence] Failed to persist pending messages:',
                        {
                            sessionId,
                            errorType: error instanceof Error ? error.name : typeof error,
                        }
                    );
                }
                return;
            } finally {
                state.active = undefined;
            }
        }
    }
}
