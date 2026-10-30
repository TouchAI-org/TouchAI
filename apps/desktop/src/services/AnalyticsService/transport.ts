// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { ANALYTICS_PROTOCOL_VERSION, ANALYTICS_WIRE_HOSTNAME, ANALYTICS_WIRE_URL } from './types';
import type { AnalyticsEventName, AnalyticsWireData, AnalyticsWireEvent } from './types';

export const ANALYTICS_SEND_PATH = '/send';

export interface AnalyticsWireInput {
    websiteId: string;
    installationId: string;
    eventName: AnalyticsEventName;
    occurredAtMs: number;
    data: AnalyticsWireData;
}

/**
 * Maps an immutable persisted event to the public single-event wire body.
 *
 * `website` is the deployment-generated project id from product.json. It is a
 * public routing id, not a secret, and vanilla Umami requires it together with
 * `hostname` and `url`. `id` is the installation identity; `event_id` inside
 * `data` is a separate stable report-dedup key, not server-ingestion dedup.
 */
export function buildAnalyticsWireEvent(input: AnalyticsWireInput): AnalyticsWireEvent {
    return {
        type: 'event',
        payload: {
            website: input.websiteId,
            id: input.installationId,
            name: input.eventName,
            timestamp: Math.floor(input.occurredAtMs / 1000),
            hostname: ANALYTICS_WIRE_HOSTNAME,
            url: ANALYTICS_WIRE_URL,
            data: input.data,
        },
    };
}

export function analyticsSendUrl(baseUrl: string): string {
    return `${baseUrl.replace(/\/+$/, '')}${ANALYTICS_SEND_PATH}`;
}

export function isSupportedAnalyticsProtocolVersion(value: number): boolean {
    return value === ANALYTICS_PROTOCOL_VERSION;
}
