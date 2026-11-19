import type { ComputerUseSettings } from './types';

export const DEFAULT_SETTINGS: ComputerUseSettings = {
    allowForeground: true,
    allowedApps: [],
    approval: 'each',
    cursorVisible: true,
    enabled: false,
    maxImageDimension: 1568,
    recordingEnabled: false,
    telemetryEnabled: false,
};

export function normalizeSettings(raw: unknown): ComputerUseSettings {
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_SETTINGS };
    const value = raw as Partial<ComputerUseSettings>;
    return {
        allowForeground: value.allowForeground ?? DEFAULT_SETTINGS.allowForeground,
        allowedApps: Array.isArray(value.allowedApps) ? value.allowedApps : [],
        approval:
            value.approval === 'session-window' || value.approval === 'full-access'
                ? value.approval
                : 'each',
        cursorVisible: value.cursorVisible ?? DEFAULT_SETTINGS.cursorVisible,
        enabled: value.enabled ?? DEFAULT_SETTINGS.enabled,
        maxImageDimension:
            typeof value.maxImageDimension === 'number' && value.maxImageDimension > 0
                ? Math.round(value.maxImageDimension)
                : DEFAULT_SETTINGS.maxImageDimension,
        recordingEnabled: value.recordingEnabled ?? DEFAULT_SETTINGS.recordingEnabled,
        telemetryEnabled: value.telemetryEnabled ?? DEFAULT_SETTINGS.telemetryEnabled,
    };
}
