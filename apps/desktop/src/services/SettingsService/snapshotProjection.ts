// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { createDefaultGeneralSettings, type GeneralSettingsData } from './domain';

/**
 * Project a settings snapshot for a read-only requester. A full snapshot can carry search
 * provider API keys and browser profile paths, so the tray gets defaults for every field
 * it does not use instead of the owner's real values. The tray renders only language and
 * the motion preferences used by `MotionConfig`.
 */
export function projectSettingsSnapshotFor(
    requester: string,
    data: GeneralSettingsData
): GeneralSettingsData {
    if (requester !== 'tray-menu') {
        return data;
    }

    const projected = createDefaultGeneralSettings();
    projected.language = data.language;
    projected.animationSpeed = data.animationSpeed;
    projected.automaticallyReduceMotion = data.automaticallyReduceMotion;
    return projected;
}
