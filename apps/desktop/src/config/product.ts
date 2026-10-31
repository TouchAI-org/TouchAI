// Copyright (c) 2026. 千诚. Licensed under GPL v3

import productConfig from '@product-config';

import packageJson from '../../package.json';

export type ProductConfig = typeof productConfig;
export type AppUpdateChannel = keyof ProductConfig['services']['updates']['channels'];

export const APP_PRODUCT_CONFIG = productConfig;
export const APP_VERSION = packageJson.version;
export const APP_UPDATE_CHANNELS = Object.freeze(
    Object.keys(APP_PRODUCT_CONFIG.services.updates.channels) as AppUpdateChannel[]
);

export const DEFAULT_APP_UPDATE_CHANNEL: AppUpdateChannel = APP_UPDATE_CHANNELS.includes('stable')
    ? 'stable'
    : (APP_UPDATE_CHANNELS[0] ?? 'stable');

export function appUpdateChannelLabel(channel: AppUpdateChannel): string {
    return APP_PRODUCT_CONFIG.services.updates.channels[channel].displayName ?? channel;
}

export function normalizeAppUpdateChannel(value: unknown): AppUpdateChannel {
    return APP_UPDATE_CHANNELS.includes(value as AppUpdateChannel)
        ? (value as AppUpdateChannel)
        : DEFAULT_APP_UPDATE_CHANNEL;
}
