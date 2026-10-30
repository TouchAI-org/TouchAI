// Copyright (c) 2026. 千诚. Licensed under GPL v3

/**
 * Version of the public client/server analytics wire contract.
 *
 * The contract is mirrored by the private receiver (TouchAI-org/touchai-analytics,
 * `src/touchai_analytics/protocol.py`) and by the Rust validator in
 * `src-tauri/src/core/analytics/events.rs`. Changing a name, enum or bound is a
 * public contract change and all three copies plus the shared fixtures must move
 * together.
 */
export const ANALYTICS_PROTOCOL_VERSION = 1;
export const ANALYTICS_SCHEMA_VERSION = 1;

/**
 * Fixed transport constants required by vanilla Umami `/api/send`. The reverse
 * proxy maps `{baseUrl}/send` straight to Umami, so no intermediary can add
 * these fields. They are non-geographic placeholders: Umami derives no country,
 * region or city because the proxy also strips every client IP and geo header.
 */
export const ANALYTICS_WIRE_HOSTNAME = 'touchai-desktop.invalid';
export const ANALYTICS_WIRE_URL = '/';

/**
 * The fixed product-event registry. Adding an event is a public contract change:
 * the TypeScript schema, the Rust validator and the private receiver must all
 * accept it through the shared fixtures.
 */
export const ANALYTICS_EVENT_NAMES = [
    'analytics.session_started',
    'analytics.health_reported',
    'product.surface_opened',
    'product.feature_exposed',
    'provider.configuration_started',
    'provider.configuration_completed',
    'agent.request_submitted',
    'agent.first_output_received',
    'agent.request_completed',
    'agent.tool_completed',
    'agent.approval_resolved',
    'mcp.connection_completed',
    'attachment.preparation_completed',
    'search.completed',
    'search.result_selected',
    'result.action_completed',
    'app.update_transition',
    'app.started',
    'app.startup_completed',
] as const;

export type AnalyticsEventName = (typeof ANALYTICS_EVENT_NAMES)[number];

export type AnalyticsAttributeValue = string | number | boolean;
export type AnalyticsAttributes = Record<string, AnalyticsAttributeValue>;

/** IPC payload the WebView submits; identity and platform are filled by Rust. */
export interface AnalyticsTrackRequest {
    eventName: AnalyticsEventName;
    occurredAtMs: number;
    consentEpoch: number;
    attributes: AnalyticsAttributes;
}

export type AnalyticsSubmitStatus =
    | 'persisted'
    | 'disabled'
    | 'unavailable'
    | 'rejected'
    | 'stale_epoch'
    | 'error';

export interface AnalyticsSubmitResult {
    status: AnalyticsSubmitStatus;
    eventId?: string;
    reason?: string;
}

export type AnalyticsConsentStatus = 'uninitialized' | 'enabled' | 'disabled';

export interface AnalyticsState {
    status: AnalyticsConsentStatus;
    consentEpoch: number;
    queueDepth: number;
    pendingBytes: number;
    transportReady: boolean;
}

/**
 * A task-local handle captured when a request starts. Completion events carry
 * the epoch that was current at start, so an operation that begins while
 * disabled, or spans a disable/re-enable boundary, cannot be tagged with a newer
 * consent epoch.
 */
export interface AnalyticsOperationHandle {
    operationId: string;
    enabled: boolean;
    consentEpoch: number;
}

/**
 * The `data` object sent inside a wire event: the caller's whitelisted
 * attributes plus the runtime-filled envelope fields the receiver requires.
 */
export interface AnalyticsWireData {
    [key: string]: AnalyticsAttributeValue | undefined;
    event_id: string;
    occurred_at_ms: number;
    schema_version: number;
    analytics_session_id?: string;
    app_version: string;
    release_channel: string;
    os_family: string;
    architecture: string;
}

export interface AnalyticsWirePayload {
    website: string;
    id: string;
    name: AnalyticsEventName;
    timestamp: number;
    hostname: string;
    url: string;
    data: AnalyticsWireData;
}

export interface AnalyticsWireEvent {
    type: 'event';
    payload: AnalyticsWirePayload;
}
