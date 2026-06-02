// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { SettingsAiServicesFocusProviderEvent } from '@/services/EventService/types';

const MANAGED_SETTINGS_FOCUS_STORAGE_KEY = 'touchai.managed-auth.settings-focus-request';
const MANAGED_SETTINGS_FOCUS_MAX_AGE_MS = 5 * 60 * 1000;

function hasLocalStorage(): boolean {
    return typeof window !== 'undefined' && 'localStorage' in window && window.localStorage != null;
}

function isSettingsAiServicesFocusProviderEvent(
    value: unknown
): value is SettingsAiServicesFocusProviderEvent {
    if (value == null || typeof value !== 'object') {
        return false;
    }

    const record = value as Record<string, unknown>;
    return (
        record.section === 'ai-services' &&
        record.providerDriver === 'mimo' &&
        record.requireBuiltIn === true &&
        record.mode === 'managed' &&
        record.reason === 'managed-auth-callback' &&
        typeof record.requestedAt === 'number'
    );
}

function parseStoredManagedSettingsFocusRequest(
    rawValue: string | null
): SettingsAiServicesFocusProviderEvent | null {
    if (!rawValue) {
        return null;
    }

    try {
        const parsed = JSON.parse(rawValue) as unknown;
        if (!isSettingsAiServicesFocusProviderEvent(parsed)) {
            return null;
        }

        if (Date.now() - parsed.requestedAt > MANAGED_SETTINGS_FOCUS_MAX_AGE_MS) {
            return null;
        }

        return parsed;
    } catch {
        return null;
    }
}

export function createManagedSettingsFocusRequest(): SettingsAiServicesFocusProviderEvent {
    return {
        section: 'ai-services',
        providerDriver: 'mimo',
        requireBuiltIn: true,
        mode: 'managed',
        reason: 'managed-auth-callback',
        requestedAt: Date.now(),
    };
}

export function persistManagedSettingsFocusRequest(
    request: SettingsAiServicesFocusProviderEvent
): void {
    if (!hasLocalStorage()) {
        return;
    }

    try {
        window.localStorage.setItem(MANAGED_SETTINGS_FOCUS_STORAGE_KEY, JSON.stringify(request));
    } catch {
        // ignore storage failures
    }
}

export function clearManagedSettingsFocusRequest(): void {
    if (!hasLocalStorage()) {
        return;
    }

    try {
        window.localStorage.removeItem(MANAGED_SETTINGS_FOCUS_STORAGE_KEY);
    } catch {
        // ignore storage failures
    }
}

export function peekManagedSettingsFocusRequest(): SettingsAiServicesFocusProviderEvent | null {
    if (!hasLocalStorage()) {
        return null;
    }

    try {
        const parsed = parseStoredManagedSettingsFocusRequest(
            window.localStorage.getItem(MANAGED_SETTINGS_FOCUS_STORAGE_KEY)
        );
        if (!parsed) {
            clearManagedSettingsFocusRequest();
        }
        return parsed;
    } catch {
        clearManagedSettingsFocusRequest();
        return null;
    }
}

export function consumeManagedSettingsFocusRequest(): SettingsAiServicesFocusProviderEvent | null {
    const request = peekManagedSettingsFocusRequest();
    clearManagedSettingsFocusRequest();
    return request;
}
