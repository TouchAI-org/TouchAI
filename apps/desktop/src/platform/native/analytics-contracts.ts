/** Native command DTOs; the analytics module owns the typed product registry. */
export type AnalyticsEventName =
    | 'analytics.session_started'
    | 'analytics.health_reported'
    | 'product.surface_opened'
    | 'product.feature_exposed'
    | 'provider.configuration_started'
    | 'provider.configuration_completed'
    | 'agent.request_submitted'
    | 'agent.first_output_received'
    | 'agent.request_completed'
    | 'agent.tool_completed'
    | 'agent.approval_resolved'
    | 'mcp.connection_completed'
    | 'attachment.preparation_completed'
    | 'search.completed'
    | 'search.result_selected'
    | 'result.action_completed'
    | 'app.update_transition'
    | 'app.started'
    | 'app.startup_completed';

export interface AnalyticsTrackRequest {
    eventName: AnalyticsEventName;
    occurredAtMs: number;
    operationId?: string;
    attributes: Record<string, string | number | boolean>;
}

export type AnalyticsSubmitStatus =
    | 'queued'
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
    buildEligible: boolean;
    transportReady: boolean;
}
export interface AnalyticsLifecycleContext {
    runId: string;
    startupId: string;
    startupKind: 'cold' | 'reactivation';
    startupSource: 'foreground' | 'background' | 'autostart' | 'other';
    elapsedMs: number;
}
export interface AnalyticsOperationHandle {
    operationId: string;
    enabled: boolean;
    consentEpoch: number;
}
