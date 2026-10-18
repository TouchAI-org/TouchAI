import type {
    AppUpdateNotificationAction,
    AppUpdateNotificationPayload,
} from '@services/NativeService/types';

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
        console.warn('[AppUpdateService] Invalid update reminder history:', error);
        return {};
    }
}

export class AppUpdateReminderController {
    private history: ReminderHistory = {};
    private work = Promise.resolve();
    private unsubscribe: (() => void) | null = null;
    private unlisten: (() => void) | null = null;
    private initialized = false;
    private openingSettings = false;
    private disposed = false;

    constructor(private readonly deps: AppUpdateReminderDeps) {}

    async initialize(): Promise<void> {
        if (this.initialized || this.disposed) return;

        this.history = parseHistory(await this.deps.storage.load());
        const unlisten = await this.deps.notifications.listen((action) => {
            // Both native open/update actions now lead to user-confirmed update details.
            if (action.action !== 'ignore') {
                if (this.openingSettings) return;
                this.openingSettings = true;
                void this.deps
                    .openSettings()
                    .catch((error) => {
                        console.warn(
                            '[AppUpdateService] Update notification action failed:',
                            error
                        );
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
        if (this.disposed) {
            unlisten();
            return;
        }

        this.unlisten = unlisten;
        this.initialized = true;
        this.unsubscribe = this.deps.updates.subscribe(() => {
            this.enqueue(() => this.remindIfDue());
        });
    }

    dispose(): void {
        this.disposed = true;
        this.initialized = false;
        this.unsubscribe?.();
        this.unlisten?.();
    }

    private enqueue(operation: () => Promise<void>): void {
        this.work = this.work
            .then(async () => {
                if (!this.disposed) await operation();
            })
            .catch((error) => {
                console.warn('[AppUpdateService] Update reminder failed:', error);
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
