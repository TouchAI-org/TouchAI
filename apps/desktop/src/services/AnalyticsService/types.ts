// Copyright (c) 2026. 千诚. Licensed under GPL v3

/**
 * The fixed product-event registry. The wire body itself is built by the native
 * runtime (`src-tauri/src/core/analytics/transport.rs`); this side owns only the
 * event names, their whitelist attributes and the IPC payload shapes. Adding an
 * event is a public contract change: the TypeScript schema, the Rust validator
 * and the private receiver must all accept it through the shared fixtures.
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

/**
 * IPC payload the WebView submits. Identity, platform, session and consent epoch
 * are filled by Rust; `operationId` is an opaque native handle, never a
 * caller-supplied session id.
 */
export interface AnalyticsTrackRequest {
    eventName: AnalyticsEventName;
    occurredAtMs: number;
    operationId?: string;
    attributes: AnalyticsAttributes;
}

export type AnalyticsSubmitStatus =
    | 'persisted'
    | 'disabled'
    | 'unavailable'
    | 'rejected'
    | 'stale_epoch'
    | 'deduplicated'
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
 * Native-owned process lifecycle facts. `runId` identifies this process run and
 * `startupId` identifies the current foreground activation (the cold start or a
 * later reactivation); `elapsedMs` is measured natively from that activation's
 * own monotonic instant, so the WebView never has to reconcile a foreign clock.
 */
export interface AnalyticsLifecycleContext {
    runId: string;
    startupId: string;
    startupKind: 'cold' | 'reactivation';
    startupSource: 'foreground' | 'background' | 'autostart' | 'other';
    elapsedMs: number;
}

/**
 * An opaque, native-issued handle captured when a request starts. The native
 * runtime binds the current session and consent epoch to the id, so a completion
 * that arrives after another window opened a later session is never re-tagged
 * and an operation that begins while disabled, or spans a disable/re-enable
 * boundary, cannot borrow a newer consent epoch.
 */
export interface AnalyticsOperationHandle {
    operationId: string;
    enabled: boolean;
    consentEpoch: number;
}
