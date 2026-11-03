// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { SettingsService, type SettingsServiceOptions } from './service';
import { createTauriSettingsTransport } from './transport';

export * from './domain';
export type { SettingsServiceOptions } from './service';
export { SettingsService } from './service';
export type { SettingsTransport } from './transport';
export { createTauriSettingsTransport } from './transport';
export * from './types';

let activeSettingsService: SettingsService | null = null;

export function createSettingsService(
    options: SettingsServiceOptions = { transport: createTauriSettingsTransport() }
): SettingsService {
    return new SettingsService(options);
}

/**
 * The per-WebView settings owner/client. Lazily created with the Tauri transport; the main
 * window becomes the owner by label, every other window is a client.
 */
export function getSettingsService(): SettingsService {
    if (!activeSettingsService) {
        activeSettingsService = new SettingsService({ transport: createTauriSettingsTransport() });
    }
    return activeSettingsService;
}

/** Test/DI seam: replace the module-level settings service. */
export function setActiveSettingsService(service: SettingsService | null): void {
    activeSettingsService = service;
}
