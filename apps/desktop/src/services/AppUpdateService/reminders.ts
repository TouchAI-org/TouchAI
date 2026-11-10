import type {
    AppUpdateNotificationAction,
    AppUpdateNotificationPayload,
} from '@services/NativeService/types';
import { log } from '@services/ObservabilityService';
import { useStateMachine } from 'reka-ui';

import { getAvailableAppUpdateVersion } from './availability';
import { isWithinAppUpdateHours } from './timing';
import type { AppUpdateState } from './types';

const REMINDER_INTERVAL_MS = 5 * 60 * 60 * 1000;
interface VersionReminder {
    lastNotifiedAt: number | null;
    ignored: boolean;
}

type ReminderHistory = Record<string, VersionReminder>;

function normalizedVersion(version: string): string {
    return version.replace(/^v/, '');
}

function reminderKey(channel: AppUpdateState['channel'], version: string): string {
    return `${channel}:${normalizedVersion(version)}`;
}

/**
 * Returns the real elapsed time between two notification checks.
 * Quiet hours prevent delivery, but do not pause the five-hour deadline.
 */
export function activeNotificationElapsedMs(startAt: number, endAt: number): number {
    if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt) {
        return 0;
    }

    return endAt - startAt;
}

interface AppUpdateReminderDeps {
    updates: {
        getState(): AppUpdateState;
        subscribe(listener: (state: AppUpdateState) => void): () => void;
    };
    storage: {
        load(): Promise<string | null>;
        save(value: string): Promise<void>;
    };
    notifications: {
        listen(listener: (action: AppUpdateNotificationAction) => void): Promise<() => void>;
        show(payload: AppUpdateNotificationPayload): Promise<void>;
    };
    createPayload(state: AppUpdateState, version: string): AppUpdateNotificationPayload;
    openSettings(): Promise<void>;
    now?: () => number;
}

function parseHistory(raw: string | null): ReminderHistory {
    if (!raw) return {};

    try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

        return Object.fromEntries(
            Object.entries(parsed).flatMap(([key, value]) => {
                if (!/^(stable|beta|nightly):/.test(key)) return [];
                if (!value || typeof value !== 'object') return [];
                const record = value as Partial<VersionReminder>;
                return [
                    [
                        key,
                        {
                            ignored: record.ignored === true,
                            lastNotifiedAt:
                                typeof record.lastNotifiedAt === 'number' &&
                                Number.isFinite(record.lastNotifiedAt)
                                    ? record.lastNotifiedAt
                                    : null,
                        },
                    ],
                ];
            })
        );
    } catch (error) {
        log.warn('[AppUpdateService] Invalid update reminder history:', error);
        return {};
    }
}

export class AppUpdateReminderController {
    private history: ReminderHistory = {};
    private work = Promise.resolve();
    private unsubscribe: (() => void) | null = null;
    private unlisten: (() => void) | null = null;
    private readonly lifecycle = useStateMachine('idle', {
        idle: { initialize: 'initializing', dispose: 'disposed' },
        initializing: { ready: 'ready', failed: 'idle', dispose: 'disposed' },
        ready: { dispose: 'disposed' },
        disposed: {},
    });
    private initializePromise: Promise<void> | null = null;
    private openingSettings = false;

    constructor(private readonly deps: AppUpdateReminderDeps) {}

    async initialize(): Promise<void> {
        if (this.lifecycle.state.value === 'ready' || this.isDisposed()) return;
        if (this.initializePromise) return this.initializePromise;

        this.lifecycle.dispatch('initialize');
        this.initializePromise = this.initializeReminder();
        try {
            await this.initializePromise;
        } catch (error) {
            this.releaseSubscriptions();
            this.lifecycle.dispatch('failed');
            throw error;
        } finally {
            this.initializePromise = null;
        }
    }

    private async initializeReminder(): Promise<void> {
        this.history = parseHistory(await this.deps.storage.load());
        if (this.isDisposed()) return;
        const unlisten = await this.deps.notifications.listen((action) => {
            if (this.isDisposed()) return;
            // Both native open/update actions now lead to user-confirmed update details.
            if (action.action !== 'ignore') {
                if (this.openingSettings) return;
                this.openingSettings = true;
                void this.deps
                    .openSettings()
                    .catch((error) => {
                        log.warn('[AppUpdateService] Update notification action failed:', error);
                    })
                    .finally(() => {
                        this.openingSettings = false;
                    });
                return;
            }

            const state = this.deps.updates.getState();
            if (
                !['available', 'unsupported', 'downloaded'].includes(state.status) ||
                state.channel !== action.channel ||
                normalizedVersion(getAvailableAppUpdateVersion(state) ?? '') !==
                    normalizedVersion(action.version)
            ) {
                return;
            }

            this.enqueue(async () => {
                const key = reminderKey(action.channel, action.version);
                this.history[key] = {
                    lastNotifiedAt: this.history[key]?.lastNotifiedAt ?? null,
                    ignored: true,
                };
                await this.persistHistory();
            });
        });
        if (this.isDisposed()) {
            unlisten();
            return;
        }

        this.unlisten = unlisten;
        this.lifecycle.dispatch('ready');
        this.unsubscribe = this.deps.updates.subscribe(() => {
            this.enqueue(() => this.remindIfDue());
        });
    }

    dispose(): void {
        this.lifecycle.dispatch('dispose');
        this.releaseSubscriptions();
    }

    private isDisposed(): boolean {
        return this.lifecycle.state.value === 'disposed';
    }

    private releaseSubscriptions(): void {
        const { unsubscribe, unlisten } = this;
        this.unsubscribe = null;
        this.unlisten = null;
        unsubscribe?.();
        unlisten?.();
    }

    private enqueue(operation: () => Promise<void>): void {
        this.work = this.work
            .then(async () => {
                if (!this.isDisposed()) await operation();
            })
            .catch((error) => {
                log.warn('[AppUpdateService] Update reminder failed:', error);
            });
    }

    private async remindIfDue(): Promise<void> {
        const state = this.deps.updates.getState();
        if (
            this.openingSettings ||
            !state.autoCheckEnabled ||
            !['available', 'unsupported'].includes(state.status)
        )
            return;

        const version = normalizedVersion(getAvailableAppUpdateVersion(state) ?? '');
        if (!version) return;

        const key = reminderKey(state.channel, version);
        const record = this.history[key];
        const now = this.deps.now?.() ?? Date.now();
        if (!isWithinAppUpdateHours(now)) return;

        if (
            record?.ignored ||
            (record?.lastNotifiedAt !== null &&
                record?.lastNotifiedAt !== undefined &&
                activeNotificationElapsedMs(record.lastNotifiedAt, now) < REMINDER_INTERVAL_MS)
        )
            return;

        await this.deps.notifications.show(this.deps.createPayload(state, version));
        this.history[key] = { lastNotifiedAt: now, ignored: false };
        await this.persistHistory();
    }

    private persistHistory(): Promise<void> {
        return this.deps.storage.save(JSON.stringify(this.history));
    }
}
