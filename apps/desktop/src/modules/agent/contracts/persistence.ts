import type { AiTiming, AiUsage, JsonObject } from '@touchai/models/contracts';

import type { PromptBreakdownJson } from '@/utils/promptBreakdown';

import type { ContextMessageSource, ContextSummary } from './context';
import type { AttachmentReference } from './history';

/** Only provenance is needed by the history writer, not provider media or live input. */
export interface CheckpointMessage {
    role: 'user' | 'assistant' | 'system' | 'tool';
    contextSource?: ContextMessageSource;
    contextSummary?: ContextSummary;
    contextSummaryPartId?: number;
}

export interface PersistenceCall {
    iteration: number;
    modelId: number;
    modelName: string;
    providerId: number | null;
    providerName: string;
    usage: AiUsage;
    usageReported?: boolean;
    timing: AiTiming;
    finishReason?: string;
    errorMessage?: string;
    toolCallsInStep: number;
    toolArgumentErrors: number;
}

export type PersistedOutputPart =
    | { type: 'text'; content: string }
    | {
          type: 'reasoning';
          content: string;
          startedAt?: number;
          endedAt?: number;
          providerOptions?: Record<string, JsonObject>;
      };

export interface AttachmentRecord {
    id: number;
    hash: string;
    type: 'image' | 'file';
    original_name: string;
    origin_path: string;
    mime_type: string | null;
    size: number | null;
    created_at: string;
}

/** A transaction-scoped record writer, not a database executor or connection. */
export interface AttachmentRecordWriter {
    findByHash(hash: string): Promise<AttachmentRecord | null>;
    create(input: Omit<AttachmentRecord, 'id' | 'created_at'>): Promise<AttachmentRecord>;
}

export interface PersistenceUsage {
    usage: AiUsage;
    costMicros: number;
    unpricedCalls: number;
    parts: { data: string; durationMs: number; ttftMs?: number }[];
}

export interface PersistenceProjectorHost {
    prepareAttachments(attachments: AttachmentReference[]): Promise<void>;
    persistAttachment(
        attachment: AttachmentReference,
        writer: AttachmentRecordWriter
    ): Promise<AttachmentRecord>;
    emptyManifest(): string;
    appendManifest(currentJson: string, requestJson: string): string;
    promptBreakdown(): Promise<PromptBreakdownJson | null>;
    resolveUsage(
        calls: readonly PersistenceCall[],
        turnId: number | null
    ): Promise<PersistenceUsage>;
    diagnostics: {
        error(message: string, error: unknown): void;
        warn(message: string, error: unknown): void;
    };
}

/** Preserve the shipped ordered output serializer and reasoning timing validation. */
export function normalizeOutputParts(raw: unknown): PersistedOutputPart[] {
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((value): PersistedOutputPart[] => {
        if (!value || typeof value !== 'object') return [];
        const part = value as {
            type?: unknown;
            content?: unknown;
            startedAt?: unknown;
            endedAt?: unknown;
            providerOptions?: unknown;
        };
        if (typeof part.content !== 'string') return [];
        if (part.type === 'text')
            return part.content ? [{ type: 'text', content: part.content }] : [];
        if (part.type !== 'reasoning') return [];
        const startedAt = validTime(part.startedAt) ? part.startedAt : undefined;
        if (!part.content && startedAt === undefined) return [];
        const endedAt =
            startedAt !== undefined && validTime(part.endedAt) && part.endedAt >= startedAt
                ? part.endedAt
                : undefined;
        const providerOptions = validProviderOptions(part.providerOptions);
        return [
            {
                type: 'reasoning',
                content: part.content,
                ...(startedAt !== undefined ? { startedAt } : {}),
                ...(endedAt !== undefined ? { endedAt } : {}),
                ...(providerOptions ? { providerOptions } : {}),
            },
        ];
    });
}

function validTime(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validProviderOptions(value: unknown): Record<string, JsonObject> | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const result: Record<string, JsonObject> = {};
    for (const [key, entry] of Object.entries(value)) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
        result[key] = entry as JsonObject;
    }
    return Object.keys(result).length ? result : undefined;
}
