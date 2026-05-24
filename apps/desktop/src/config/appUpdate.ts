// Copyright (c) 2026. 千诚. Licensed under GPL v3

export const APP_UPDATE_CHANNELS = ['stable', 'beta', 'nightly'] as const;

export type AppUpdateChannel = (typeof APP_UPDATE_CHANNELS)[number];

export const DEFAULT_APP_UPDATE_CHANNEL: AppUpdateChannel = 'stable';

export function normalizeAppUpdateChannel(value: unknown): AppUpdateChannel {
    return APP_UPDATE_CHANNELS.includes(value as AppUpdateChannel)
        ? (value as AppUpdateChannel)
        : DEFAULT_APP_UPDATE_CHANNEL;
}
