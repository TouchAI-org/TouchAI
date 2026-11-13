// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { getSettingValue, getSettingValues, setSetting } from '@database/queries';
import { log } from '@services/ObservabilityService';
import type { UnlistenFn } from '@tauri-apps/api/event';

import type { SearchKeybindings } from '@/config/searchKeybindings';
import { resolveSearchWindowDefaultSize, type SearchWindowSizePreset } from '@/config/searchWindow';
import type { AppLocale } from '@/i18n/locales';

import {
    applyGeneralSettingValue,
    applyParsedGeneralSettingValue,
    applyPersistedGeneralSettingValue,
    cloneGeneralSettingsSnapshot,
    createDefaultGeneralSettings,
    GENERAL_SETTING_DEFINITIONS,
    type GeneralSettingKey,
    type GeneralSettingsData,
    type GeneralSettingValue,
    getGeneralSettingDefinition,
    getGeneralSettingEventValue,
    parseGeneralSettingUpdateValue,
    serializeGeneralSetting,
    serializeParsedGeneralSettingValue,
} from './domain';
import { createDefaultSettingsEffects, type SettingsEffects } from './effects';
import {
    describeRejection,
    formatShortcutRegistrationError,
    mutationFailedMessage,
    notReadyMessage,
    replyErrorMessage,
    syncWarningMessage,
    unconfirmedMessage,
} from './messages';
import { SettingsRejection, validateGlobalShortcut, validateSearchKeybindings } from './policy';
import { SETTINGS_BROADCAST_TARGET, type SettingsTransport } from './transport';
import {
    type SettingsChangeNotice,
    SettingsErrorCode,
    type SettingsErrorCodeValue,
    type SettingsMutationResult,
    type SettingsRole,
    SettingsServiceError,
    type SettingsSnapshot,
} from './types';
import type {
    SettingsReplyBody,
    SettingsWireMessage,
    SettingsWireMutateRequest,
    SettingsWireReply,
} from './wire';

const DEFAULT_OWNER_LABEL = 'main';
const DEFAULT_REQUEST_TIMEOUT_MS = 5000;
const DEFAULT_MAX_PENDING_REQUESTS = 32;
const DEFAULT_MAX_OWNER_QUEUE = 64;
const DEFAULT_MAX_DEDUPE_ENTRIES = 64;
const DEFAULT_HANDSHAKE_ATTEMPTS = 5;
const MAX_HANDSHAKE_DELAY_MS = 250;
const MAX_PREVIOUS_EPOCHS = 8;

interface AuthorityContext {
    lifecycle: number;
    hostEpoch: string | null;
}

interface PendingRequest {
    kind: 'snapshot' | 'mutate';
    key: GeneralSettingKey | null;
    hostEpoch: string | null;
    resolve: (reply: SettingsWireReply) => void;
    reject: (error: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
}

interface DedupedMutation {
    from: string;
    key: GeneralSettingKey;
    value: GeneralSettingValue;
    promise: Promise<SettingsMutationResult>;
    settled: boolean;
}

export interface SettingsServiceOptions {
    transport: SettingsTransport;
    effects?: SettingsEffects;
    role?: SettingsRole;
    ownerLabel?: string;
    requestTimeoutMs?: number;
    maxPendingRequests?: number;
    maxOwnerQueue?: number;
    maxDedupeEntries?: number;
}

function newRequestId(): string {
    return globalThis.crypto?.randomUUID?.() ?? `req-${Math.random().toString(36).slice(2)}`;
}

function newHostEpoch(): string {
    return globalThis.crypto?.randomUUID?.() ?? `epoch-${Math.random().toString(36).slice(2)}`;
}

/** Structural comparison for a mutation value (settings values can be nested DTOs). */
function sameMutationValue(a: GeneralSettingValue, b: GeneralSettingValue): boolean {
    if (a === b) {
        return true;
    }
    if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
        try {
            return JSON.stringify(a) === JSON.stringify(b);
        } catch {
            return false;
        }
    }
    return false;
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Single settings owner. The owning main WebView serializes mutations, applies reversible
 * native effects and persists to SQLite; client windows speak the same command path over a
 * small, settings-dedicated transport and never write settings themselves.
 */
export class SettingsService {
    private readonly transport: SettingsTransport;
    private readonly effects: SettingsEffects;
    private readonly ownerLabel: string;
    private readonly requestTimeoutMs: number;
    private readonly maxPendingRequests: number;
    private readonly maxOwnerQueue: number;
    private readonly maxDedupeEntries: number;
    private readonly role: SettingsRole;

    private hostEpoch: string | null = null;
    private revision = 0;
    private committed: GeneralSettingsData = createDefaultGeneralSettings();
    private ready = false;
    private disposed = false;
    private osDirty = false;
    private lifecycle = 0;

    private initializing: Promise<void> | null = null;
    private unlisten: UnlistenFn | null = null;
    private unfocus: UnlistenFn | null = null;

    private readonly subscribers = new Set<(notice: SettingsChangeNotice) => void>();
    private readonly pending = new Map<string, PendingRequest>();
    private authorityQueue: Promise<unknown> = Promise.resolve();
    private authorityDepth = 0;
    private readonly recentMutations = new Map<string, DedupedMutation>();
    private refreshInFlight: Promise<void> | null = null;
    private refreshPending = false;
    private ownerAvailable = true;
    private readonly previousEpochs = new Set<string>();
    private readonly previousEpochOrder: string[] = [];

    constructor(options: SettingsServiceOptions) {
        this.transport = options.transport;
        this.effects = options.effects ?? createDefaultSettingsEffects();
        this.ownerLabel = options.ownerLabel ?? DEFAULT_OWNER_LABEL;
        this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
        this.maxPendingRequests = options.maxPendingRequests ?? DEFAULT_MAX_PENDING_REQUESTS;
        this.maxOwnerQueue = options.maxOwnerQueue ?? DEFAULT_MAX_OWNER_QUEUE;
        this.maxDedupeEntries = options.maxDedupeEntries ?? DEFAULT_MAX_DEDUPE_ENTRIES;
        this.role = options.role ?? (this.transport.label === this.ownerLabel ? 'owner' : 'client');
    }

    getRole(): SettingsRole {
        return this.role;
    }

    isReady(): boolean {
        return this.ready;
    }

    getHostEpoch(): string | null {
        return this.hostEpoch;
    }

    getRevision(): number {
        return this.revision;
    }

    getSnapshot(): GeneralSettingsData {
        return cloneGeneralSettingsSnapshot(this.committed);
    }

    subscribe(listener: (notice: SettingsChangeNotice) => void): () => void {
        this.subscribers.add(listener);
        return () => {
            this.subscribers.delete(listener);
        };
    }

    async initialize(): Promise<void> {
        if (this.ready) {
            return;
        }
        if (this.initializing) {
            return this.initializing;
        }

        const run = this.role === 'owner' ? this.initializeOwner() : this.initializeClient();
        this.initializing = run;
        try {
            await run;
        } finally {
            if (this.initializing === run) {
                this.initializing = null;
            }
        }
    }

    async refresh(): Promise<void> {
        this.assertNotDisposed();
        if (this.role === 'owner') {
            await this.enqueueAuthority(async (context) => {
                if (!this.isAlive(context)) {
                    return;
                }
                await this.reloadCommittedFromDatabase();
                if (!this.isAlive(context)) {
                    return;
                }
                this.revision += 1;
                try {
                    await this.broadcastNotice('change', []);
                } catch (error) {
                    log.warn('[SettingsService] Failed to broadcast refresh:', error);
                }
                this.notifySubscribers([]);
            }, this.captureContext());
            return;
        }
        await this.syncFromOwner();
    }

    async readEffectiveValue(key: GeneralSettingKey): Promise<GeneralSettingValue> {
        if (key === 'start_on_boot') {
            try {
                return await this.effects.isAutostartEnabled();
            } catch {
                return getGeneralSettingEventValue(this.committed, key);
            }
        }
        return getGeneralSettingEventValue(this.committed, key);
    }

    async mutate(
        key: GeneralSettingKey,
        value: GeneralSettingValue
    ): Promise<SettingsMutationResult> {
        this.assertNotDisposed();
        if (this.role === 'owner') {
            if (!this.ready) {
                throw new SettingsServiceError(SettingsErrorCode.NotReady, notReadyMessage());
            }
            return this.enqueueAuthority(
                (context) => this.runMutation(key, value, context),
                this.captureContext()
            );
        }

        if (!this.ready) {
            throw new SettingsServiceError(SettingsErrorCode.NotReady, notReadyMessage());
        }
        if (this.hostEpoch === null) {
            // A client may only mutate once it holds the owner's authority epoch; without
            // one, a late/duplicate write could target a previous owner's state.
            throw new SettingsServiceError(SettingsErrorCode.NotReady, notReadyMessage());
        }

        let reply: SettingsWireReply;
        try {
            reply = await this.sendRequest(
                {
                    kind: 'mutate-request',
                    requestId: newRequestId(),
                    from: this.transport.label,
                    hostEpoch: this.hostEpoch,
                    key,
                    value,
                },
                'mutate',
                key,
                false
            );
        } catch (error) {
            if (error instanceof SettingsServiceError) {
                if (error.code === SettingsErrorCode.Timeout) {
                    return {
                        status: 'unknown',
                        key,
                        code: SettingsErrorCode.Timeout,
                        message: unconfirmedMessage(),
                    };
                }
                if (error.code === SettingsErrorCode.StaleEpoch) {
                    this.scheduleRefresh();
                    return {
                        status: 'unknown',
                        key,
                        code: SettingsErrorCode.StaleEpoch,
                        message: unconfirmedMessage(),
                    };
                }
            }
            throw error;
        }

        if (reply.ok && reply.result) {
            if (reply.result.status === 'committed') {
                this.applyCommittedLocally(
                    key,
                    reply.result.value,
                    reply.result.revision,
                    reply.hostEpoch
                );
                // Reconcile authoritatively through the single-flight loop; the local apply
                // above already reflected the value, so this must not race another refresh.
                this.scheduleRefresh();
            }
            return reply.result;
        }

        if (reply.ok) {
            return {
                status: 'unknown',
                key,
                code: SettingsErrorCode.TransportFailed,
                message: unconfirmedMessage(),
            };
        }

        if (
            reply.code === SettingsErrorCode.StaleEpoch ||
            reply.code === SettingsErrorCode.OwnerDisposed ||
            reply.code === SettingsErrorCode.OwnerUnavailable
        ) {
            // The request was refused before it ran; the outcome is not a committed value.
            this.scheduleRefresh();
            return {
                status: 'unknown',
                key,
                code: reply.code as SettingsErrorCodeValue,
                message: unconfirmedMessage(),
            };
        }

        throw new SettingsServiceError(reply.code as never, mutationFailedMessage());
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        this.ready = false;
        this.lifecycle += 1;
        this.osDirty = false;

        if (this.role === 'owner' && this.hostEpoch) {
            // Best-effort: tell clients the owner is gone so their requests fail fast.
            void this.transport
                .send(SETTINGS_BROADCAST_TARGET, {
                    kind: 'notice',
                    hostEpoch: this.hostEpoch,
                    revision: this.revision,
                    type: 'gone',
                    changedKeys: [],
                })
                .catch(() => undefined);
        }

        this.releaseListeners();
        this.subscribers.clear();
        this.recentMutations.clear();
        this.rejectAllPending(
            new SettingsServiceError(SettingsErrorCode.OwnerDisposed, mutationFailedMessage())
        );
    }

    // ---- owner lifecycle ----

    private async initializeOwner(): Promise<void> {
        this.assertNotDisposed();
        // Install the request listener before any read so no client request is missed. A
        // retry after a failed initialization must reuse the existing listener, not add one.
        if (!this.unlisten) {
            this.unlisten = await this.transport.listen((message) => this.onOwnerMessage(message));
        }
        this.assertAliveDuringInit();
        if (!this.unfocus) {
            // Focus is a reconcile trigger: re-read the authoritative DB and republish.
            this.unfocus = await this.transport.onFocus(() => this.onOwnerFocus());
        }
        this.assertAliveDuringInit();

        const persisted = await this.reloadCommittedFromDatabase();
        this.assertAliveDuringInit();
        await this.persistOwnerDefaults(persisted);
        this.assertAliveDuringInit();
        await this.reconcileNativeFromPersistedSafe();
        this.assertAliveDuringInit();

        this.hostEpoch = newHostEpoch();
        this.revision = 1;
        this.recentMutations.clear();
        this.ready = true;

        try {
            await this.broadcastNotice('ready', []);
        } catch (error) {
            // A lost ready broadcast is survivable: clients re-request by handshake.
            log.warn('[SettingsService] Failed to broadcast settings readiness:', error);
        }
        this.notifySubscribers([]);
    }

    private onOwnerFocus(): void {
        if (this.disposed || this.role !== 'owner' || !this.ready) {
            return;
        }
        void this.refresh().catch((error) => {
            log.warn('[SettingsService] Failed to reconcile settings on focus:', error);
        });
    }

    private async reloadCommittedFromDatabase(): Promise<Record<string, string | null>> {
        const rows = await getSettingValues({
            keys: GENERAL_SETTING_DEFINITIONS.map((definition) => definition.key),
        });
        GENERAL_SETTING_DEFINITIONS.forEach((definition) => {
            applyPersistedGeneralSettingValue(
                this.committed,
                definition.key,
                rows[definition.key] ?? null
            );
        });
        return rows;
    }

    /** Owner-only: materialize missing defaults and rewrite superseded persisted shapes. */
    private async persistOwnerDefaults(rows: Record<string, string | null>): Promise<void> {
        const results = await Promise.allSettled(
            GENERAL_SETTING_DEFINITIONS.map((definition) => {
                const persisted = rows[definition.key] ?? null;
                if (definition.shouldRewritePersisted?.(persisted) || persisted === null) {
                    return setSetting({
                        key: definition.key,
                        value: serializeGeneralSetting(this.committed, definition.key),
                    });
                }
                return Promise.resolve(null);
            })
        );
        const failedKeys = results.flatMap((result, index) =>
            result.status === 'rejected'
                ? [GENERAL_SETTING_DEFINITIONS[index]?.key ?? `unknown:${index}`]
                : []
        );
        if (failedKeys.length > 0) {
            log.warn(
                `[SettingsService] Failed to persist setting rewrite/default value(s): ${failedKeys.join(
                    ', '
                )}`
            );
        }
    }

    /** Reconcile native/OS state from persisted settings; throws on any failure. */
    private async reconcileNativeFromPersisted(): Promise<void> {
        const enabled = await this.effects.isAutostartEnabled();
        if (enabled !== this.committed.startOnBoot) {
            await this.effects.setAutostart(this.committed.startOnBoot);
        }
        await this.effects.registerGlobalShortcut(this.committed.globalShortcut);
        await this.effects.setSearchWindowDefaults(this.committed.searchWindowDefaultSize);
        this.effects.applyLanguage(this.committed.language);
    }

    private async reconcileNativeFromPersistedSafe(): Promise<void> {
        try {
            await this.reconcileNativeFromPersisted();
        } catch (error) {
            log.warn('[SettingsService] Failed to reconcile native settings:', error);
            // The OS may still be out of sync. Leave a dirty marker so the next command
            // re-reads the DB and reapplies native settings before any new side effect.
            this.osDirty = true;
        }
    }

    /**
     * Recover from a native/DB ambiguity: reload the authoritative database state first,
     * then reapply native settings. The OS-dirty flag clears only when both succeed.
     */
    private async ensureReconciled(): Promise<boolean> {
        if (!this.osDirty) {
            return true;
        }
        try {
            await this.reloadCommittedFromDatabase();
            await this.reconcileNativeFromPersisted();
            this.osDirty = false;
            return true;
        } catch (error) {
            log.warn('[SettingsService] Failed to reconcile after an uncertain failure:', error);
            return false;
        }
    }

    private onOwnerMessage(message: SettingsWireMessage): void {
        if (message.kind === 'snapshot-request') {
            void this.replySnapshot(message.requestId, message.from);
            return;
        }
        if (message.kind === 'mutate-request') {
            void this.replyMutation(message);
        }
    }

    private async replySnapshot(requestId: string, requester: string): Promise<void> {
        if (this.disposed) {
            await this.replyError(requestId, requester, SettingsErrorCode.OwnerDisposed);
            return;
        }
        if (!this.ready) {
            await this.replyError(requestId, requester, SettingsErrorCode.NotReady);
            return;
        }
        await this.reply(requestId, requester, { ok: true, snapshot: this.snapshot() });
    }

    private async replyMutation(message: SettingsWireMutateRequest): Promise<void> {
        if (this.disposed) {
            await this.replyError(message.requestId, message.from, SettingsErrorCode.OwnerDisposed);
            return;
        }
        if (!this.ready) {
            await this.replyError(message.requestId, message.from, SettingsErrorCode.NotReady);
            return;
        }
        // A mutation must come from the current owner epoch. `null` is only meaningful for
        // the initial snapshot handshake; accepting it here would let a stale client write.
        if (message.hostEpoch !== this.hostEpoch) {
            await this.replyError(message.requestId, message.from, SettingsErrorCode.StaleEpoch);
            return;
        }
        try {
            const result = await this.runDedupedMutation(
                message.requestId,
                message.from,
                message.key,
                message.value
            );
            await this.reply(message.requestId, message.from, { ok: true, result });
        } catch (error) {
            log.warn('[SettingsService] Settings mutation failed:', error);
            const code =
                error instanceof SettingsServiceError
                    ? error.code
                    : SettingsErrorCode.TransportFailed;
            await this.reply(message.requestId, message.from, {
                ok: false,
                code,
                message: mutationFailedMessage(),
            });
        }
    }

    private async reply(requestId: string, target: string, body: SettingsReplyBody): Promise<void> {
        try {
            await this.transport.send(target, {
                kind: 'reply',
                requestId,
                hostEpoch: this.hostEpoch,
                ...body,
            });
        } catch (error) {
            log.warn('[SettingsService] Failed to send settings reply:', error);
        }
    }

    private async replyError(requestId: string, target: string, code: string): Promise<void> {
        await this.reply(requestId, target, {
            ok: false,
            code,
            message: replyErrorMessage(code),
        });
    }

    // ---- mutation pipeline ----

    private captureContext(): AuthorityContext {
        return { lifecycle: this.lifecycle, hostEpoch: this.hostEpoch };
    }

    private isAlive(context: AuthorityContext): boolean {
        return (
            !this.disposed &&
            context.lifecycle === this.lifecycle &&
            context.hostEpoch === this.hostEpoch
        );
    }

    private enqueueAuthority<T>(
        task: (context: AuthorityContext) => Promise<T>,
        context: AuthorityContext
    ): Promise<T> {
        if (this.authorityDepth >= this.maxOwnerQueue) {
            return Promise.reject(
                new SettingsServiceError(SettingsErrorCode.TooManyPending, mutationFailedMessage())
            );
        }
        this.authorityDepth += 1;
        const run = this.authorityQueue.then(
            () => task(context),
            () => task(context)
        );
        this.authorityQueue = run.then(
            () => undefined,
            () => undefined
        );
        return run.finally(() => {
            this.authorityDepth -= 1;
        });
    }

    private runDedupedMutation(
        requestId: string,
        from: string,
        key: GeneralSettingKey,
        value: GeneralSettingValue
    ): Promise<SettingsMutationResult> {
        const existing = this.recentMutations.get(requestId);
        if (existing) {
            if (
                existing.from !== from ||
                existing.key !== key ||
                !sameMutationValue(existing.value, value)
            ) {
                // A re-used request id for a different command must not receive another
                // command's result, nor replay a different side effect.
                return Promise.reject(
                    new SettingsServiceError(SettingsErrorCode.Rejected, mutationFailedMessage())
                );
            }
            return existing.promise;
        }
        const promise = this.enqueueAuthority(
            (context) => this.runMutation(key, value, context),
            this.captureContext()
        );
        const entry: DedupedMutation = { from, key, value, promise, settled: false };
        const markSettled = () => {
            entry.settled = true;
        };
        void promise.then(markSettled, markSettled);
        this.recentMutations.set(requestId, entry);
        this.trimDedupe();
        // A failed run must not resurrect as an unhandled rejection when replayed by id.
        void promise.catch(() => undefined);
        return promise;
    }

    private trimDedupe(): void {
        if (this.recentMutations.size <= this.maxDedupeEntries) {
            return;
        }
        // Evict only settled entries, oldest first. Never drop an in-flight mutation that
        // a duplicate request id would then replay as a second side effect.
        for (const [id, entry] of this.recentMutations) {
            if (this.recentMutations.size <= this.maxDedupeEntries) {
                break;
            }
            if (entry.settled) {
                this.recentMutations.delete(id);
            }
        }
    }

    private async runMutation(
        key: GeneralSettingKey,
        value: GeneralSettingValue,
        context: AuthorityContext
    ): Promise<SettingsMutationResult> {
        if (!this.isAlive(context)) {
            return {
                status: 'unknown',
                key,
                code: SettingsErrorCode.OwnerDisposed,
                message: unconfirmedMessage(),
            };
        }

        if (!(await this.ensureReconciled())) {
            return {
                status: 'recovery-required',
                key,
                code: SettingsErrorCode.CompensationFailed,
                message: unconfirmedMessage(),
            };
        }

        const definition = getGeneralSettingDefinition(key);
        if (!definition) {
            return {
                status: 'rejected',
                key,
                code: SettingsErrorCode.UnknownKey,
                message: mutationFailedMessage(),
            };
        }

        let parsed: unknown;
        try {
            parsed = parseGeneralSettingUpdateValue(key, value);
        } catch {
            return {
                status: 'rejected',
                key,
                code: SettingsErrorCode.InvalidValue,
                message: mutationFailedMessage(),
            };
        }

        try {
            this.validate(key, parsed);
        } catch (error) {
            if (error instanceof SettingsRejection) {
                return {
                    status: 'rejected',
                    key,
                    code: SettingsErrorCode.Rejected,
                    message: describeRejection(error),
                };
            }
            return {
                status: 'rejected',
                key,
                code: SettingsErrorCode.Rejected,
                message: mutationFailedMessage(),
            };
        }

        const previous = cloneGeneralSettingsSnapshot(this.committed);

        try {
            await this.applyNativeEffect(key, parsed);
        } catch (error) {
            // The native action may have partially applied; reconcile instead of assuming
            // it did not. Only report "rejected" when the OS is confirmed back on the
            // committed value; otherwise the outcome is unresolved.
            this.osDirty = true;
            const reconciled = await this.ensureReconciled();
            const message =
                error instanceof SettingsServiceError ? error.message : mutationFailedMessage();
            if (!reconciled) {
                return {
                    status: 'recovery-required',
                    key,
                    code: SettingsErrorCode.NativeFailed,
                    message: unconfirmedMessage(),
                };
            }
            return { status: 'rejected', key, code: SettingsErrorCode.NativeFailed, message };
        }

        // The owner may have been disposed while the native effect was in flight. Do not
        // persist a change that now belongs to no live owner, and never mutate committed
        // state that a newer owner epoch owns.
        if (!this.isAlive(context)) {
            return {
                status: 'unknown',
                key,
                code: SettingsErrorCode.OwnerDisposed,
                message: unconfirmedMessage(),
            };
        }

        const serialized = serializeParsedGeneralSettingValue(key, parsed as never);
        let committedToDatabase = false;
        let ambiguous = false;
        try {
            await setSetting({ key, value: serialized });
            committedToDatabase = true;
        } catch (error) {
            log.warn('[SettingsService] Failed to persist setting, reconciling:', error);
            try {
                const readBack = await getSettingValue({ key });
                committedToDatabase = readBack === serialized;
            } catch (readError) {
                log.warn('[SettingsService] Failed to read back the persisted setting:', readError);
                ambiguous = true;
            }
        }

        if (ambiguous) {
            // Neither the ack nor a read confirms the outcome: never assume either way.
            this.osDirty = true;
            return {
                status: 'unknown',
                key,
                code: SettingsErrorCode.PersistenceFailed,
                message: unconfirmedMessage(),
            };
        }

        if (!committedToDatabase) {
            let restored = false;
            try {
                await this.revertNativeEffect(key, previous);
                restored = true;
            } catch (revertError) {
                log.warn('[SettingsService] Failed to revert native effect:', revertError);
                this.osDirty = true;
            }
            return restored
                ? {
                      status: 'restored',
                      key,
                      code: SettingsErrorCode.PersistenceFailed,
                      message: mutationFailedMessage(),
                  }
                : {
                      status: 'recovery-required',
                      key,
                      code: SettingsErrorCode.CompensationFailed,
                      message: unconfirmedMessage(),
                  };
        }

        if (!this.isAlive(context)) {
            // The owner went away mid-write; the value is persisted but this epoch must not
            // touch state that now belongs to a new owner.
            return {
                status: 'unknown',
                key,
                code: SettingsErrorCode.OwnerDisposed,
                message: unconfirmedMessage(),
            };
        }

        applyParsedGeneralSettingValue(this.committed, key, parsed as never);
        try {
            this.applyPostCommitSideEffect(key, parsed);
        } catch (error) {
            log.warn('[SettingsService] Failed to apply committed setting locally:', error);
        }
        this.revision += 1;

        let warning: string | undefined;
        try {
            await this.broadcastNotice('change', [key]);
        } catch (error) {
            log.warn('[SettingsService] Failed to broadcast setting change:', error);
            warning = syncWarningMessage();
        }
        this.notifySubscribers([key]);

        return {
            status: 'committed',
            key,
            value: getGeneralSettingEventValue(this.committed, key),
            revision: this.revision,
            warning,
        };
    }

    private validate(key: GeneralSettingKey, parsed: unknown): void {
        if (key === 'global_shortcut') {
            validateGlobalShortcut(String(parsed), this.committed);
            return;
        }
        if (key === 'search_keybindings') {
            validateSearchKeybindings(parsed as SearchKeybindings, this.committed);
        }
    }

    private async applyNativeEffect(key: GeneralSettingKey, parsed: unknown): Promise<void> {
        switch (key) {
            case 'global_shortcut':
                try {
                    await this.effects.registerGlobalShortcut(String(parsed));
                } catch (error) {
                    throw new SettingsServiceError(
                        SettingsErrorCode.NativeFailed,
                        formatShortcutRegistrationError(String(parsed), error)
                    );
                }
                return;
            case 'start_on_boot':
                await this.effects.setAutostart(Boolean(parsed));
                return;
            case 'search_window_size_preset':
                await this.effects.setSearchWindowDefaults(
                    resolveSearchWindowDefaultSize(parsed as SearchWindowSizePreset)
                );
                return;
            default:
                return;
        }
    }

    private async revertNativeEffect(
        key: GeneralSettingKey,
        previous: GeneralSettingsData
    ): Promise<void> {
        switch (key) {
            case 'global_shortcut':
                await this.effects.registerGlobalShortcut(previous.globalShortcut);
                return;
            case 'start_on_boot':
                await this.effects.setAutostart(previous.startOnBoot);
                return;
            case 'search_window_size_preset':
                await this.effects.setSearchWindowDefaults(previous.searchWindowDefaultSize);
                return;
            default:
                return;
        }
    }

    private applyPostCommitSideEffect(key: GeneralSettingKey, parsed: unknown): void {
        if (key === 'language') {
            this.effects.applyLanguage(parsed as AppLocale);
        }
    }

    // ---- client lifecycle ----

    private async initializeClient(): Promise<void> {
        this.assertNotDisposed();
        // Register the reply/notice listener before requesting, so ready/change is not missed.
        // A retry must reuse the existing listener rather than add a duplicate.
        if (!this.unlisten) {
            this.unlisten = await this.transport.listen((message) => this.onClientMessage(message));
        }
        this.assertAliveDuringInit();
        if (!this.unfocus) {
            this.unfocus = await this.transport.onFocus(() => this.scheduleRefresh());
        }
        this.assertAliveDuringInit();
        // Do not release listeners on a failed handshake: the owner may become ready later
        // or the window may be focused again, and focus/ready must still be able to recover.
        await this.syncFromOwner();
        if (this.disposed) {
            this.releaseListeners();
            throw new SettingsServiceError(
                SettingsErrorCode.OwnerDisposed,
                mutationFailedMessage()
            );
        }
        this.ready = true;
    }

    /**
     * Request/reply handshake with bounded retries. It re-requests rather than waiting only
     * for a broadcast, so a missed or already-fired ready event cannot wedge the client.
     */
    private async syncFromOwner(): Promise<void> {
        let lastError: unknown;
        for (let attempt = 0; attempt < DEFAULT_HANDSHAKE_ATTEMPTS; attempt += 1) {
            try {
                this.applySnapshot(await this.requestSnapshot());
                return;
            } catch (error) {
                lastError = error;
                if (
                    error instanceof SettingsServiceError &&
                    (error.code === SettingsErrorCode.NotReady ||
                        error.code === SettingsErrorCode.OwnerUnavailable ||
                        error.code === SettingsErrorCode.Timeout ||
                        error.code === SettingsErrorCode.StaleEpoch)
                ) {
                    await delay(Math.min(MAX_HANDSHAKE_DELAY_MS, this.requestTimeoutMs));
                    continue;
                }
                throw error;
            }
        }
        throw (
            lastError ??
            new SettingsServiceError(SettingsErrorCode.Timeout, mutationFailedMessage())
        );
    }

    private onClientMessage(message: SettingsWireMessage): void {
        if (message.kind === 'reply') {
            const entry = this.pending.get(message.requestId);
            if (!entry) {
                return;
            }
            const mismatch = this.describeReplyMismatch(entry, message);
            clearTimeout(entry.timer);
            this.pending.delete(message.requestId);
            if (mismatch) {
                // A reply that does not answer the request we actually sent must never
                // settle it as success, even when it reuses the request id.
                entry.reject(mismatch);
                return;
            }
            this.ownerAvailable = true;
            entry.resolve(message);
            return;
        }
        if (message.kind === 'notice') {
            this.handleNotice(message);
        }
    }

    /**
     * Bind a reply to the request that produced it: success replies must carry the same
     * epoch the request was sent under and the payload kind/key the request asked for.
     */
    private describeReplyMismatch(
        entry: PendingRequest,
        reply: SettingsWireReply
    ): SettingsServiceError | null {
        if (!reply.ok) {
            // Failure replies may legitimately carry a null epoch (owner not ready).
            return null;
        }
        if (reply.hostEpoch === null) {
            return new SettingsServiceError(
                SettingsErrorCode.TransportFailed,
                mutationFailedMessage()
            );
        }
        if (this.isStaleEpoch(reply.hostEpoch)) {
            // An answer from a superseded owner epoch must never settle this request.
            return new SettingsServiceError(SettingsErrorCode.StaleEpoch, unconfirmedMessage());
        }
        if (
            entry.kind === 'mutate' &&
            entry.hostEpoch !== null &&
            reply.hostEpoch !== entry.hostEpoch
        ) {
            // A mutation must be answered by the same owner epoch that ran it; only a
            // snapshot may adopt a new epoch (owner restart).
            return new SettingsServiceError(SettingsErrorCode.StaleEpoch, unconfirmedMessage());
        }
        if (entry.kind === 'snapshot' && !reply.snapshot) {
            return new SettingsServiceError(
                SettingsErrorCode.TransportFailed,
                mutationFailedMessage()
            );
        }
        if (entry.kind === 'mutate' && !reply.result) {
            return new SettingsServiceError(
                SettingsErrorCode.TransportFailed,
                mutationFailedMessage()
            );
        }
        if (
            entry.kind === 'mutate' &&
            reply.result &&
            entry.key !== null &&
            reply.result.key !== entry.key
        ) {
            return new SettingsServiceError(
                SettingsErrorCode.TransportFailed,
                mutationFailedMessage()
            );
        }
        return null;
    }

    private handleNotice(message: Extract<SettingsWireMessage, { kind: 'notice' }>): void {
        if (message.type === 'gone') {
            if (this.isStaleEpoch(message.hostEpoch)) {
                // A previous owner's shutdown must not fail the current owner's requests.
                return;
            }
            this.ownerAvailable = false;
            this.rejectAllPending(
                new SettingsServiceError(
                    SettingsErrorCode.OwnerUnavailable,
                    mutationFailedMessage()
                )
            );
            return;
        }

        if (message.type === 'ready') {
            if (this.isStaleEpoch(message.hostEpoch)) {
                return;
            }
            this.ownerAvailable = true;
            this.scheduleRefresh();
            return;
        }

        if (this.isStaleEpoch(message.hostEpoch)) {
            return;
        }
        if (message.hostEpoch !== this.hostEpoch || message.revision > this.revision) {
            this.scheduleRefresh();
        }
    }

    private scheduleRefresh(): void {
        if (this.disposed) {
            return;
        }
        if (this.refreshInFlight) {
            // Coalesce overlapping invalidations into a single latest re-run.
            this.refreshPending = true;
            return;
        }
        this.refreshInFlight = this.runRefreshLoop();
    }

    private async runRefreshLoop(): Promise<void> {
        try {
            do {
                this.refreshPending = false;
                try {
                    await this.syncFromOwner();
                } catch (error) {
                    log.warn('[SettingsService] Failed to reconcile settings from owner:', error);
                }
            } while (this.refreshPending && !this.disposed);
        } finally {
            this.refreshInFlight = null;
        }
    }

    private async requestSnapshot(): Promise<SettingsSnapshot> {
        const reply = await this.sendRequest(
            {
                kind: 'snapshot-request',
                requestId: newRequestId(),
                from: this.transport.label,
                hostEpoch: this.hostEpoch,
            },
            'snapshot',
            null,
            true
        );
        if (reply.ok && reply.snapshot) {
            return reply.snapshot;
        }
        if (!reply.ok) {
            throw new SettingsServiceError(reply.code as never, mutationFailedMessage());
        }
        throw new SettingsServiceError(SettingsErrorCode.TransportFailed, mutationFailedMessage());
    }

    private sendRequest(
        message: Extract<SettingsWireMessage, { kind: 'snapshot-request' | 'mutate-request' }>,
        kind: 'snapshot' | 'mutate',
        key: GeneralSettingKey | null,
        allowUnavailable: boolean
    ): Promise<SettingsWireReply> {
        if (this.disposed) {
            return Promise.reject(
                new SettingsServiceError(SettingsErrorCode.OwnerDisposed, mutationFailedMessage())
            );
        }
        if (!allowUnavailable && !this.ownerAvailable) {
            return Promise.reject(
                new SettingsServiceError(
                    SettingsErrorCode.OwnerUnavailable,
                    mutationFailedMessage()
                )
            );
        }
        if (this.pending.size >= this.maxPendingRequests) {
            return Promise.reject(
                new SettingsServiceError(SettingsErrorCode.TooManyPending, mutationFailedMessage())
            );
        }

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(message.requestId);
                reject(new SettingsServiceError(SettingsErrorCode.Timeout, unconfirmedMessage()));
            }, this.requestTimeoutMs);
            this.pending.set(message.requestId, {
                kind,
                key,
                hostEpoch: this.hostEpoch,
                resolve: resolve as (reply: SettingsWireReply) => void,
                reject,
                timer,
            });
            void this.transport.send(this.ownerLabel, message).catch((error) => {
                const entry = this.pending.get(message.requestId);
                if (!entry) {
                    return;
                }
                clearTimeout(entry.timer);
                this.pending.delete(message.requestId);
                log.warn('[SettingsService] Failed to send settings request:', error);
                reject(
                    new SettingsServiceError(
                        SettingsErrorCode.TransportFailed,
                        mutationFailedMessage()
                    )
                );
            });
        });
    }

    private applySnapshot(snapshot: SettingsSnapshot): void {
        if (this.isStaleEpoch(snapshot.hostEpoch)) {
            // Late reply from a superseded owner epoch: ignore.
            return;
        }
        if (snapshot.hostEpoch !== this.hostEpoch) {
            if (this.hostEpoch) {
                this.rememberSupersededEpoch(this.hostEpoch);
            }
            this.hostEpoch = snapshot.hostEpoch;
            this.revision = snapshot.revision;
            this.committed = snapshot.data;
        } else {
            if (snapshot.revision < this.revision) {
                return;
            }
            this.revision = snapshot.revision;
            this.committed = snapshot.data;
        }
        // A client window must follow the owner's language so every window renders alike.
        this.effects.applyLanguage(this.committed.language);
        this.ready = true;
        this.notifySubscribers([]);
    }

    private applyCommittedLocally(
        key: GeneralSettingKey,
        value: GeneralSettingValue,
        revision: number,
        hostEpoch: string | null
    ): void {
        if (hostEpoch !== null && this.isStaleEpoch(hostEpoch)) {
            return;
        }
        if (hostEpoch !== null && hostEpoch !== this.hostEpoch) {
            if (this.hostEpoch) {
                this.rememberSupersededEpoch(this.hostEpoch);
            }
            this.hostEpoch = hostEpoch;
            this.revision = revision;
        } else {
            if (revision < this.revision) {
                // A newer snapshot already advanced the cache; a late reply must not regress it.
                return;
            }
            this.revision = revision;
        }
        applyGeneralSettingValue(this.committed, key, value);
        if (key === 'language') {
            this.effects.applyLanguage(value as AppLocale);
        }
        this.notifySubscribers([key]);
    }

    private isStaleEpoch(epoch: string): boolean {
        return this.previousEpochs.has(epoch);
    }

    private rememberSupersededEpoch(epoch: string): void {
        if (this.previousEpochs.has(epoch)) {
            return;
        }
        this.previousEpochs.add(epoch);
        this.previousEpochOrder.push(epoch);
        while (this.previousEpochOrder.length > MAX_PREVIOUS_EPOCHS) {
            const oldest = this.previousEpochOrder.shift();
            if (oldest !== undefined) {
                this.previousEpochs.delete(oldest);
            }
        }
    }

    // ---- helpers ----

    private snapshot(): SettingsSnapshot {
        return {
            hostEpoch: this.hostEpoch ?? '',
            revision: this.revision,
            ready: this.ready,
            data: cloneGeneralSettingsSnapshot(this.committed),
        };
    }

    private async broadcastNotice(
        type: 'ready' | 'change',
        changedKeys: GeneralSettingKey[]
    ): Promise<void> {
        if (!this.hostEpoch) {
            return;
        }
        await this.transport.send(SETTINGS_BROADCAST_TARGET, {
            kind: 'notice',
            hostEpoch: this.hostEpoch,
            revision: this.revision,
            type,
            changedKeys,
        });
    }

    private notifySubscribers(changedKeys: GeneralSettingKey[]): void {
        const notice: SettingsChangeNotice = {
            hostEpoch: this.hostEpoch ?? '',
            revision: this.revision,
            changedKeys,
        };
        for (const subscriber of [...this.subscribers]) {
            try {
                subscriber(notice);
            } catch (error) {
                log.warn('[SettingsService] Settings subscriber failed:', error);
            }
        }
    }

    private rejectAllPending(error: SettingsServiceError): void {
        for (const [requestId, entry] of this.pending) {
            clearTimeout(entry.timer);
            this.pending.delete(requestId);
            entry.reject(error);
        }
    }

    private assertNotDisposed(): void {
        if (this.disposed) {
            throw new SettingsServiceError(
                SettingsErrorCode.OwnerDisposed,
                mutationFailedMessage()
            );
        }
    }

    private assertAliveDuringInit(): void {
        if (this.disposed) {
            this.releaseListeners();
            throw new SettingsServiceError(
                SettingsErrorCode.OwnerDisposed,
                mutationFailedMessage()
            );
        }
    }

    /** Detach transport listeners, tolerating a host whose unlisten rejects. */
    private releaseListeners(): void {
        const unlisten = this.unlisten;
        const unfocus = this.unfocus;
        this.unlisten = null;
        this.unfocus = null;
        for (const detach of [unlisten, unfocus]) {
            if (!detach) {
                continue;
            }
            try {
                void Promise.resolve(detach()).catch(() => undefined);
            } catch {
                // Ignore a synchronous unlisten failure.
            }
        }
    }
}
