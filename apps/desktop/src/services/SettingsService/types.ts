// Copyright (c) 2026. 千诚. Licensed under GPL v3

import type { GeneralSettingKey, GeneralSettingsData, GeneralSettingValue } from './domain';
import type { SettingsRejectionDescriptor } from './policy';

export type SettingsRole = 'owner' | 'client';

export const SettingsErrorCode = {
    NotReady: 'settings-not-ready',
    StaleEpoch: 'settings-stale-epoch',
    OwnerUnavailable: 'settings-owner-unavailable',
    OwnerDisposed: 'settings-owner-disposed',
    UnknownKey: 'settings-unknown-key',
    InvalidValue: 'settings-invalid-value',
    Rejected: 'settings-rejected',
    NativeFailed: 'settings-native-failed',
    PersistenceFailed: 'settings-persistence-failed',
    CompensationFailed: 'settings-compensation-failed',
    Timeout: 'settings-timeout',
    TransportFailed: 'settings-transport-failed',
    TooManyPending: 'settings-too-many-pending',
} as const;

export type SettingsErrorCodeValue = (typeof SettingsErrorCode)[keyof typeof SettingsErrorCode];

/**
 * Infrastructure-level failure: a request could not be carried out at all (not ready,
 * owner unavailable, transport error). Domain rejections are reported as results, not thrown.
 */
export class SettingsServiceError extends Error {
    readonly code: SettingsErrorCodeValue;
    readonly rejection?: SettingsRejectionDescriptor;
    readonly cause?: unknown;

    constructor(
        code: SettingsErrorCodeValue,
        options: { cause?: unknown; rejection?: SettingsRejectionDescriptor } = {}
    ) {
        // The message is deliberately the stable code, not localized user copy. Callers
        // branch on `code`; presentation decides whether to show a generic failure notice.
        super(code);
        this.name = 'SettingsServiceError';
        this.code = code;
        this.cause = options.cause;
        this.rejection = options.rejection;
    }
}

export type SettingsMutationStatus =
    | 'committed'
    | 'rejected'
    | 'restored'
    | 'recovery-required'
    | 'unknown';

export interface SettingsCommittedResult {
    status: 'committed';
    key: GeneralSettingKey;
    value: GeneralSettingValue;
    revision: number;
}

export interface SettingsRejectedResult {
    status: 'rejected';
    key: GeneralSettingKey;
    code: SettingsErrorCodeValue;
    rejection?: SettingsRejectionDescriptor;
}

export interface SettingsNonCommittedResult {
    status: 'restored' | 'recovery-required' | 'unknown';
    key: GeneralSettingKey;
    code: SettingsErrorCodeValue;
}

export type SettingsMutationResult =
    | SettingsCommittedResult
    | SettingsRejectedResult
    | SettingsNonCommittedResult;

export interface SettingsSnapshot {
    hostEpoch: string;
    revision: number;
    ready: boolean;
    data: GeneralSettingsData;
}

export interface SettingsChangeNotice {
    hostEpoch: string;
    revision: number;
    changedKeys: GeneralSettingKey[];
}
