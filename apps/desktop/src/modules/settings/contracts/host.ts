import type { SettingsRejection } from '../domain/policy';
import type { SettingsEffects } from './effects';
import type { SettingsRole } from './results';
import type { SettingsTransport } from './transport';

export interface SettingsPersistence {
    read(key: string): Promise<string | null>;
    readMany(keys: readonly string[]): Promise<Record<string, string | null>>;
    write(key: string, value: string): Promise<void>;
}

/** Other owners supply only their existing serializer, never a sibling service or row. */
export interface SettingsSection {
    key: string;
    stateKey: string;
    parse(raw: string | null): unknown;
    serialize(value: unknown): string;
}

export interface SettingsMessages {
    describeRejection(rejection: SettingsRejection): string;
    formatShortcutRegistrationError(shortcut: string, error: unknown): string;
    mutationFailedMessage(): string;
    notReadyMessage(): string;
    replyErrorMessage(code: string): string;
    syncWarningMessage(): string;
    unconfirmedMessage(): string;
}

export interface SettingsServiceOptions {
    transport: SettingsTransport;
    effects: SettingsEffects;
    persistence: SettingsPersistence;
    messages: SettingsMessages;
    diagnostics: { warn(...args: unknown[]): void };
    sections?: readonly SettingsSection[];
    role?: SettingsRole;
    ownerLabel?: string;
    requestTimeoutMs?: number;
    maxPendingRequests?: number;
    maxOwnerQueue?: number;
    maxDedupeEntries?: number;
}
