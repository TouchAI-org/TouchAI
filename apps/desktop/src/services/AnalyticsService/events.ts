// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { z } from '@/utils/zod';

import { ANALYTICS_EVENT_NAMES, type AnalyticsAttributes, type AnalyticsEventName } from './types';

// Canonical hyphenated UUID, matched byte-for-byte by the Rust validator so the
// two registries accept and reject exactly the same strings.
const uuidSchema = z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

function isRealUtcDay(value: string): boolean {
    if (value.length !== 10) {
        return false;
    }
    const parts = value.split('-');
    if (parts.length !== 3) {
        return false;
    }
    const year = Number(parts[0]);
    const month = Number(parts[1]);
    const day = Number(parts[2]);
    if (year < 1 || year > 9999) {
        return false;
    }
    // `Date.UTC` maps years 0-99 onto 1900-1999, so build the date on a safe
    // base year before setting the real year. Year zero is not a receiver date.
    const date = new Date(Date.UTC(2000, month - 1, day));
    date.setUTCFullYear(year);
    return (
        date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day
    );
}

const daySchema = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine(isRealUtcDay, { message: 'invalid_day' });

/**
 * Version shape shared with the Rust registry and the private receiver:
 * `^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$`. `from_version`/`to_version` are the only
 * attributes carrying a value from outside this codebase, so the shape rejects
 * a path, URL, error string, whitespace, non-ASCII text and every vendor- or
 * tag-qualified model id. A bare alphanumeric-dash identifier such as `gpt-4o`
 * is indistinguishable from a release version and passes.
 */
// JavaScript `$` alone also matches before a final newline; require the real end.
const ANALYTICS_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$(?![\s\S])/;
const versionSchema = z.string().regex(ANALYTICS_VERSION_PATTERN);

/** Normalizes a release version with the same shape the event registry enforces. */
export function normalizeAnalyticsVersion(value: string | null | undefined): string | undefined {
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim();
    return ANALYTICS_VERSION_PATTERN.test(trimmed) ? trimmed : undefined;
}

const latencyMsSchema = z.number().int().min(0).max(86_400_000);
const waitMsSchema = z.number().int().min(0).max(86_400_000);
const durationMsSchema = z.number().int().min(0).max(86_400_000);
const retryCountSchema = z.number().int().min(0).max(10_000);
const toolCountSchema = z.number().int().min(0).max(10_000);
const approvalCountSchema = z.number().int().min(0).max(10_000);
const modelSwitchCountSchema = z.number().int().min(0).max(1_000);
const totalTokensSchema = z.number().int().min(0).max(10_000_000_000);
const costMicrosSchema = z.number().int().min(0).max(10_000_000_000_000);
const healthCountSchema = z.number().int().min(0).max(1_000_000);
const queueDepthSchema = z.number().int().min(0).max(1_000_000);
const llmCallCountSchema = z.number().int().min(0).max(10_000);
const cacheTokenSchema = z.number().int().min(0).max(10_000_000_000);

const resultSchema = z.enum(['success', 'failure', 'cancelled', 'unknown']);

function eventSchema<T extends z.ZodRawShape>(shape: T) {
    return z.object(shape).strict();
}

/**
 * The exact 19-event registry shared with the private receiver. Attribute names,
 * enums and numeric bounds mirror `protocol.py`; unknown events, unknown keys
 * and out-of-range scalars are rejected rather than stringified.
 */
export const ANALYTICS_EVENT_SCHEMAS = {
    'analytics.session_started': eventSchema({
        configured: z.boolean(),
        first_observed_day: daySchema.optional(),
        first_success_day: daySchema.optional(),
    }),
    'analytics.health_reported': eventSchema({
        accepted_count: healthCountSchema,
        duplicate_count: healthCountSchema.optional(),
        rejected_count: healthCountSchema.optional(),
        dropped_count: healthCountSchema.optional(),
        send_failure_count: healthCountSchema.optional(),
        queue_depth: queueDepthSchema.optional(),
        consent_state: z.enum(['enabled', 'disabled', 'pending']),
    }),
    'product.surface_opened': eventSchema({
        surface: z.enum(['shortcut', 'tray', 'main', 'history', 'other']),
    }),
    'product.feature_exposed': eventSchema({
        feature: z.enum(['quick_search', 'attachments', 'mcp', 'tools', 'history', 'other']),
    }),
    'provider.configuration_started': eventSchema({
        configuration_id: uuidSchema,
        provider_category: z.enum(['openai', 'anthropic', 'google', 'local', 'other']),
        entry: z.enum(['onboarding', 'settings', 'test', 'other']),
    }),
    'provider.configuration_completed': eventSchema({
        configuration_id: uuidSchema,
        stage: z.enum(['saved', 'validated']),
        result: z.enum(['success', 'failure']),
        error_category: z
            .enum(['auth', 'network', 'invalid_config', 'provider', 'other'])
            .optional(),
        duration_ms: durationMsSchema.optional(),
    }),
    'agent.request_submitted': eventSchema({
        request_id: uuidSchema,
        request_kind: z.enum(['chat', 'tool', 'agent', 'other']),
        surface: z.enum(['main', 'quick_search', 'history', 'other']),
        attachment_count_bucket: z.enum(['0', '1', '2-5', '6+']),
        capability: z.enum(['none', 'tools', 'mcp', 'browser', 'other']).optional(),
    }),
    'agent.first_output_received': eventSchema({
        request_id: uuidSchema,
        first_output_latency_ms: latencyMsSchema,
    }),
    'agent.request_completed': eventSchema({
        request_id: uuidSchema,
        result: resultSchema,
        duration_ms: durationMsSchema,
        provider_ttft_ms: latencyMsSchema.optional(),
        retry_count: retryCountSchema,
        tool_count: toolCountSchema.optional(),
        approval_count: approvalCountSchema.optional(),
        model_switch_count: modelSwitchCountSchema.optional(),
        total_tokens: totalTokensSchema.optional(),
        cost_usd_micros: costMicrosSchema.optional(),
        usage_coverage: z.enum(['observed', 'partial', 'unavailable']),
        persistence_result: z.enum(['saved', 'failed', 'not_applicable']),
        cancel_stage: z
            .enum(['submitted', 'streaming', 'tool', 'approval', 'persistence', 'other'])
            .optional(),
        error_category: z
            .enum([
                'none',
                'auth',
                'rate_limit',
                'network',
                'timeout',
                'invalid_request',
                'provider',
                'other',
            ])
            .optional(),
        pricing_coverage: z.enum(['observed', 'partial', 'unavailable']).optional(),
        llm_call_count: llmCallCountSchema.optional(),
        unpriced_call_count: llmCallCountSchema.optional(),
        cache_read_tokens: cacheTokenSchema.optional(),
        cache_write_tokens: cacheTokenSchema.optional(),
    }).superRefine((value, ctx) => {
        // unpriced calls are a subset of all llm calls; a value above the total is
        // incoherent and is rejected by the shared validator.
        if (
            typeof value.llm_call_count === 'number' &&
            typeof value.unpriced_call_count === 'number' &&
            value.unpriced_call_count > value.llm_call_count
        ) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['unpriced_call_count'],
                message: 'unpriced_call_count exceeds llm_call_count',
            });
        }
    }),
    'agent.tool_completed': eventSchema({
        request_id: uuidSchema,
        tool_id: uuidSchema,
        tool_category: z.enum(['file', 'command', 'network', 'browser', 'mcp', 'other']),
        result: z.enum(['success', 'failure', 'cancelled']),
        duration_ms: durationMsSchema,
    }),
    'agent.approval_resolved': eventSchema({
        request_id: uuidSchema,
        approval_id: uuidSchema,
        resolution: z.enum(['approved', 'rejected', 'cancelled', 'timeout']),
        wait_ms: waitMsSchema,
    }),
    'mcp.connection_completed': eventSchema({
        connection_id: uuidSchema,
        connection_kind: z.enum(['user', 'background_reconnect']),
        result: z.enum(['success', 'failure', 'cancelled']),
        duration_ms: durationMsSchema.optional(),
        error_category: z.enum(['network', 'auth', 'protocol', 'other']).optional(),
    }),
    'attachment.preparation_completed': eventSchema({
        preparation_id: uuidSchema,
        attachment_type: z.enum(['image', 'document', 'code', 'other']),
        count_bucket: z.enum(['1', '2-5', '6+']),
        result: z.enum(['success', 'failure']),
        duration_ms: durationMsSchema.optional(),
        error_category: z.enum(['too_large', 'unsupported', 'io', 'other']).optional(),
    }),
    'search.completed': eventSchema({
        interaction_id: uuidSchema,
        search_scope: z.enum(['quick', 'history', 'other']),
        has_results: z.boolean(),
        duration_ms: durationMsSchema,
        result_count_bucket: z.enum(['0', '1', '2-5', '6+']).optional(),
    }),
    'search.result_selected': eventSchema({
        interaction_id: uuidSchema,
        result_category: z.enum(['conversation', 'message', 'file', 'setting', 'other']),
        opened: z.boolean(),
    }),
    'result.action_completed': eventSchema({
        action_id: uuidSchema,
        action: z.enum(['copy_answer', 'copy_code', 'open_external', 'other']),
        result: z.enum(['success', 'failure']),
    }),
    'app.update_transition': eventSchema({
        update_operation_id: uuidSchema,
        phase: z.enum([
            'check_started',
            'check_finished',
            'download_started',
            'download_finished',
            'install_handoff',
            'restart_confirmed',
        ]),
        from_version: versionSchema.optional(),
        to_version: versionSchema.optional(),
        result: z.enum(['success', 'failure', 'unavailable']),
        source: z.enum(['background', 'user', 'other']),
    }),
    'app.started': eventSchema({
        run_id: uuidSchema,
        startup_source: z.enum(['foreground', 'background', 'autostart', 'other']),
    }),
    'app.startup_completed': eventSchema({
        startup_id: uuidSchema,
        startup_kind: z.enum(['cold', 'reactivation']),
        startup_source: z.enum(['foreground', 'background', 'autostart', 'other']),
        duration_ms: durationMsSchema,
    }),
} satisfies Record<AnalyticsEventName, z.ZodTypeAny>;

export type AnalyticsEventAttributes<T extends AnalyticsEventName> = z.infer<
    (typeof ANALYTICS_EVENT_SCHEMAS)[T]
>;

export function isAnalyticsEventName(value: unknown): value is AnalyticsEventName {
    return (
        typeof value === 'string' && (ANALYTICS_EVENT_NAMES as readonly string[]).includes(value)
    );
}

/**
 * Validates the caller's whitelist attributes. Unknown events, unknown keys and
 * out-of-range scalars are rejected rather than stringified.
 */
export function validateAnalyticsAttributes<T extends AnalyticsEventName>(
    eventName: T,
    attributes: AnalyticsAttributes
): AnalyticsEventAttributes<T> {
    // Explicitly reject unregistered names (including Object prototype keys such
    // as "constructor") instead of relying on an incidental missing-schema error.
    if (!isAnalyticsEventName(eventName)) {
        throw new Error(`unknown_analytics_event:${String(eventName)}`);
    }
    const schema = ANALYTICS_EVENT_SCHEMAS[eventName];
    return schema.parse(attributes) as AnalyticsEventAttributes<T>;
}
