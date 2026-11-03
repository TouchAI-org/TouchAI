// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { z } from 'zod';

import type { GeneralSettingKey, GeneralSettingValue } from './domain';
import type { SettingsMutationResult, SettingsSnapshot } from './types';

/**
 * Event name for the small, settings-dedicated transport. It carries only settings
 * command traffic between the owning main WebView and client windows; it is not a
 * general RPC channel. Directed messages use a window-targeted emit and broadcast
 * notices never carry setting values.
 */
export const SETTINGS_TRANSPORT_EVENT = 'settings:command';

/**
 * Broadcast target for value-free notices. No request, reply or snapshot may ever be
 * sent here: a reply carries the full settings snapshot (which can include provider
 * credentials), so broadcasting it would leak one window's secrets to every window.
 */
export const SETTINGS_BROADCAST_TARGET = '*';

/**
 * A message target must be a concrete single window. The broadcast target and the empty
 * string are rejected so a client cannot ask the owner to reply into a broadcast.
 */
export function isDeliverableSettingsTarget(target: unknown): target is string {
    return typeof target === 'string' && target.length > 0 && target !== SETTINGS_BROADCAST_TARGET;
}

export interface SettingsWireSnapshotRequest {
    kind: 'snapshot-request';
    requestId: string;
    from: string;
    hostEpoch: string | null;
}

export interface SettingsWireMutateRequest {
    kind: 'mutate-request';
    requestId: string;
    from: string;
    hostEpoch: string | null;
    key: GeneralSettingKey;
    value: GeneralSettingValue;
}

export interface SettingsWireReply {
    kind: 'reply';
    requestId: string;
    hostEpoch: string | null;
    ok: boolean;
    snapshot?: SettingsSnapshot;
    result?: SettingsMutationResult;
    code?: string;
    message?: string;
}

export interface SettingsWireNotice {
    kind: 'notice';
    hostEpoch: string;
    revision: number;
    type: 'ready' | 'change' | 'gone';
    changedKeys: GeneralSettingKey[];
}

export type SettingsWireMessage =
    | SettingsWireSnapshotRequest
    | SettingsWireMutateRequest
    | SettingsWireReply
    | SettingsWireNotice;

export type SettingsReplyBody = Omit<SettingsWireReply, 'kind' | 'requestId' | 'hostEpoch'>;

const nonNegativeRevision = z.number().int().nonnegative().finite();
const requestIdSchema = z.string().min(1);
const hostEpochSchema = z.string().nullable();
const settingKeySchema = z.string().min(1);
const requesterSchema = z.string().refine(isDeliverableSettingsTarget, {
    message: 'settings sender must be a concrete single window',
});

const snapshotRequestSchema = z
    .object({
        kind: z.literal('snapshot-request'),
        requestId: requestIdSchema,
        from: requesterSchema,
        hostEpoch: hostEpochSchema,
    })
    .strict();

const mutateRequestSchema = z
    .object({
        kind: z.literal('mutate-request'),
        requestId: requestIdSchema,
        from: requesterSchema,
        hostEpoch: hostEpochSchema,
        key: settingKeySchema,
        value: z.unknown(),
    })
    .strict()
    // `value` must be present even when it is legitimately null/false/0.
    .refine((message) => Object.prototype.hasOwnProperty.call(message, 'value'), {
        message: 'mutate-request requires a value',
    });

const snapshotSchema = z
    .object({
        hostEpoch: z.string().min(1),
        revision: nonNegativeRevision,
        ready: z.boolean(),
        data: z.record(z.string(), z.unknown()),
    })
    .strict();

const committedResultSchema = z
    .object({
        status: z.literal('committed'),
        key: settingKeySchema,
        value: z.unknown(),
        revision: nonNegativeRevision,
        warning: z.string().optional(),
    })
    .strict();

const rejectedResultSchema = z
    .object({
        status: z.literal('rejected'),
        key: settingKeySchema,
        code: z.string().min(1),
        message: z.string(),
    })
    .strict();

const nonCommittedResultSchema = z
    .object({
        status: z.enum(['restored', 'recovery-required', 'unknown']),
        key: settingKeySchema,
        code: z.string().min(1),
        message: z.string(),
    })
    .strict();

const mutationResultSchema = z.discriminatedUnion('status', [
    committedResultSchema,
    rejectedResultSchema,
    nonCommittedResultSchema,
]);

const replySchema = z
    .object({
        kind: z.literal('reply'),
        requestId: requestIdSchema,
        hostEpoch: hostEpochSchema,
        ok: z.boolean(),
        snapshot: snapshotSchema.optional(),
        result: mutationResultSchema.optional(),
        code: z.string().min(1).optional(),
        message: z.string().optional(),
    })
    .strict()
    .superRefine((reply, context) => {
        // A successful reply must carry exactly one payload so a caller can tell a
        // snapshot answer from a mutation answer; a failure must name a code.
        const payloads = Number(reply.snapshot !== undefined) + Number(reply.result !== undefined);
        if (reply.ok && payloads !== 1) {
            context.addIssue({
                code: 'custom',
                message: 'a successful reply must carry exactly one of snapshot/result',
            });
        }
        if (!reply.ok && reply.code === undefined) {
            context.addIssue({ code: 'custom', message: 'a failed reply must carry a code' });
        }
    });

const noticeSchema = z
    .object({
        kind: z.literal('notice'),
        hostEpoch: z.string().min(1),
        revision: nonNegativeRevision,
        type: z.enum(['ready', 'change', 'gone']),
        changedKeys: z.array(settingKeySchema),
    })
    .strict();

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

/**
 * Runtime parse of a message that crossed the window boundary. External or malformed
 * payloads are data only and are dropped before they can reach the owner or a client.
 * It verifies epochs, revisions, reply payload consistency and mutation keys/values,
 * not just the TypeScript shape.
 */
export function parseSettingsWireMessage(value: unknown): SettingsWireMessage | null {
    if (!isRecord(value) || typeof value.kind !== 'string') {
        return null;
    }

    const schema =
        value.kind === 'snapshot-request'
            ? snapshotRequestSchema
            : value.kind === 'mutate-request'
              ? mutateRequestSchema
              : value.kind === 'reply'
                ? replySchema
                : value.kind === 'notice'
                  ? noticeSchema
                  : null;
    if (!schema) {
        return null;
    }

    const parsed = schema.safeParse(value);
    return parsed.success ? (parsed.data as SettingsWireMessage) : null;
}

export function isSettingsWireMessage(value: unknown): value is SettingsWireMessage {
    return parseSettingsWireMessage(value) !== null;
}
