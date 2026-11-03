// Compatibility re-export. The pure general-settings policy now lives in the
// SettingsService-owned domain; this path stays so existing call sites keep working.
export * from '@services/SettingsService/domain/general';
