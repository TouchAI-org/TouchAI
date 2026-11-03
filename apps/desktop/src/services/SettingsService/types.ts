// Copyright (c) 2026. 千诚. Licensed under GPL v3

import type { GeneralSettingKey, GeneralSettingsData, GeneralSettingValue } from './domain';

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

    constructor(code: SettingsErrorCodeValue, message: string) {
        super(message);
        this.name = 'SettingsServiceError';
        this.code = code;
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
    /** Set when the local commit succeeded but cross-window notification failed. */
    warning?: string;
}

export interface SettingsRejectedResult {
    status: 'rejected';
    key: GeneralSettingKey;
    code: SettingsErrorCodeValue;
    message: string;
}

export interface SettingsNonCommittedResult {
    status: 'restored' | 'recovery-required' | 'unknown';
    key: GeneralSettingKey;
    code: SettingsErrorCodeValue;
    message: string;
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
