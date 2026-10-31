// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type {
    AnalyticsAttributeValue,
    AnalyticsEventName,
    AnalyticsOperationHandle,
    AnalyticsSubmitResult,
} from '@services/AnalyticsService';
import { analytics as analyticsService } from '@services/AnalyticsService';
import { resolveCalls, sumCost } from '@services/UsageService';

import { AiErrorCode } from '../contracts/errors';
import type { AiCallRecord } from '../contracts/protocol';
import type { AttachmentIndex } from './attachments/types';

export type AgentRequestKind = 'chat' | 'tool' | 'agent' | 'other';
export type AgentRequestSurface = 'main' | 'quick_search' | 'history' | 'other';
export type AgentRequestResult = 'success' | 'failure' | 'cancelled' | 'unknown';
export type AgentToolCategory = 'file' | 'command' | 'network' | 'browser' | 'mcp' | 'other';
export type AgentToolResult = 'success' | 'failure' | 'cancelled';
export type AgentApprovalResolution = 'approved' | 'rejected' | 'cancelled' | 'timeout';
export type AgentUsageCoverage = 'observed' | 'partial' | 'unavailable';
export type AgentPricingCoverage = 'observed' | 'partial' | 'unavailable';
export type AgentErrorCategory =
    | 'none'
    | 'auth'
    | 'rate_limit'
    | 'network'
    | 'timeout'
    | 'invalid_request'
    | 'provider'
    | 'other';
export type AgentPersistenceResult = 'saved' | 'failed' | 'not_applicable';
export type AgentCancelStage =
    | 'submitted'
    | 'streaming'
    | 'tool'
    | 'approval'
    | 'persistence'
    | 'other';
export type AgentAttachmentErrorCategory = 'too_large' | 'unsupported' | 'io' | 'other';

/**
 * Narrow view of `AnalyticsService` the helper depends on. The production value
 * is the singleton; tests drive the real service through the mocked Tauri IPC.
 */
export interface AgentAnalyticsSink {
    beginOperation(): Promise<AnalyticsOperationHandle>;
    completeOperation(operation: AnalyticsOperationHandle): Promise<void>;
    track<T extends AnalyticsEventName>(
        eventName: T,
        attributes: Record<string, AnalyticsAttributeValue>,
        options: { operation?: AnalyticsOperationHandle; occurredAtMs?: number }
    ): Promise<AnalyticsSubmitResult>;
}

const MAX_DURATION_MS = 86_400_000;
const MAX_TOKENS = 10_000_000_000;
const MAX_COST_MICROS = 10_000_000_000_000;
const MAX_COUNT = 10_000;
const MAX_MODEL_SWITCHES = 1_000;

/** Programming-source extensions classified as `code` (not `document`). */
const CODE_EXTENSIONS = new Set([
    '.ts',
    '.tsx',
    '.mts',
    '.cts',
    '.js',
    '.jsx',
    '.mjs',
    '.cjs',
    '.py',
    '.rs',
    '.go',
    '.java',
    '.kt',
    '.swift',
    '.c',
    '.h',
    '.cc',
    '.cpp',
    '.hpp',
    '.cs',
    '.rb',
    '.php',
    '.sh',
    '.bash',
    '.ps1',
    '.sql',
    '.vue',
    '.svelte',
]);

function monotonicNowMs(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function clampInt(value: number, max: number): number {
    if (!Number.isFinite(value)) {
        return 0;
    }

    return Math.max(0, Math.min(max, Math.round(value)));
}

/** Bucket an attachment count for `attachment_count_bucket`. */
export function attachmentCountBucket(count: number): '0' | '1' | '2-5' | '6+' {
    if (count <= 0) {
        return '0';
    }
    if (count === 1) {
        return '1';
    }
    if (count <= 5) {
        return '2-5';
    }
    return '6+';
}

/** Bucket a preparation batch size for `count_bucket` (never `0`). */
export function preparationCountBucket(count: number): '1' | '2-5' | '6+' {
    if (count <= 1) {
        return '1';
    }
    if (count <= 5) {
        return '2-5';
    }
    return '6+';
}

/** Classify one attachment into the fixed, non-identifying type enum. */
export function attachmentTypeForIndex(
    attachment: AttachmentIndex
): 'image' | 'document' | 'code' | 'other' {
    if (attachment.type === 'image') {
        return 'image';
    }

    const name = (attachment.name ?? '').toLowerCase();
    const dot = name.lastIndexOf('.');
    if (dot > 0 && CODE_EXTENSIONS.has(name.slice(dot))) {
        return 'code';
    }

    return 'document';
}

/**
 * Collapse a whole preparation batch to one enum. Only built-in tools carry the
 * `builtin__` namespace; every other model tool is an MCP tool.
 */
export function mergeAttachmentType(
    attachments: readonly AttachmentIndex[]
): 'image' | 'document' | 'code' | 'other' {
    const types = new Set(attachments.map((attachment) => attachmentTypeForIndex(attachment)));
    if (types.size === 1) {
        return [...types][0]!;
    }
    return 'other';
}

/** Map a model tool name to a fixed category without leaking the name. */
export function toolCategoryForName(name: string): AgentToolCategory {
    if (!name.startsWith('builtin__')) {
        return 'mcp';
    }

    switch (name.slice('builtin__'.length)) {
        case 'read':
        case 'file_search':
            return 'file';
        case 'bash':
            return 'command';
        case 'web_search':
        case 'web_fetch':
            return 'network';
        case 'browser':
        case 'browser_session':
        case 'browser_observe':
        case 'browser_act':
            return 'browser';
        default:
            return 'other';
    }
}

function usageCoverage(totalCalls: number, reportedCalls: number): AgentUsageCoverage {
    if (totalCalls <= 0 || reportedCalls <= 0) {
        return 'unavailable';
    }
    return reportedCalls >= totalCalls ? 'observed' : 'partial';
}

/** Sum the normalized token fields of the reported calls; `null` when unknown. */
function summedTokens(calls: readonly AiCallRecord[], reportedCalls: number): number | null {
    if (calls.length === 0 || reportedCalls <= 0) {
        return null;
    }

    return calls.reduce(
        (total, call) =>
            total +
            call.usage.inputTokens +
            call.usage.outputTokens +
            call.usage.cacheReadTokens +
            call.usage.cacheWriteTokens,
        0
    );
}

interface PricingOutcome {
    llmCallCount: number;
    unpricedCallCount: number;
    pricingCoverage: AgentPricingCoverage;
    usdCostMicros: number | null;
    cacheReadTokens: number;
    cacheWriteTokens: number;
}

/**
 * Usage and cost projection for one logical request.
 *
 * Cost is the same snapshot projection persistence uses; `resolveCalls` reads
 * the stored price snapshot only and makes no remote call. Coverage is honest:
 * a USD estimate counts only when the provider reported usage *and* a USD price
 * row exists, so a call without usage evidence never yields a fabricated zero.
 * `observed` therefore needs every recorded call priced in USD; a mix of priced
 * and unpriced calls is `partial`; nothing defensible is `unavailable`.
 */
async function resolvePricing(
    calls: readonly AiCallRecord[],
    reportedCalls: number
): Promise<PricingOutcome> {
    const llmCallCount = calls.length;
    const cacheReadTokens =
        reportedCalls > 0
            ? calls.reduce((total, call) => total + call.usage.cacheReadTokens, 0)
            : 0;
    const cacheWriteTokens =
        reportedCalls > 0
            ? calls.reduce((total, call) => total + call.usage.cacheWriteTokens, 0)
            : 0;
    const unknown = (): PricingOutcome => ({
        llmCallCount,
        // Without usage evidence every recorded call lacks a USD estimate.
        unpricedCallCount: llmCallCount,
        pricingCoverage: 'unavailable',
        usdCostMicros: null,
        cacheReadTokens,
        cacheWriteTokens,
    });

    // Without a single provider-reported call there is no token evidence, so no
    // defensible cost exists even if a price row is present.
    if (llmCallCount === 0 || reportedCalls <= 0) {
        return unknown();
    }

    try {
        const resolved = await resolveCalls([...calls]);
        if (resolved.length === 0) {
            return unknown();
        }

        const pricedUsd = resolved.filter(
            (item) => item.cost.priced && item.cost.currency === 'USD'
        );
        // Calls that a pricing row did not price in USD, plus calls the provider
        // never reported usage for: both lack a defensible USD estimate.
        const missingUsage = Math.max(0, llmCallCount - reportedCalls);
        const unpricedCallCount = Math.max(resolved.length - pricedUsd.length, missingUsage);
        const usdCostMicros = pricedUsd.length > 0 ? sumCost(pricedUsd).totalCostMicros : null;
        const pricingCoverage: AgentPricingCoverage =
            unpricedCallCount === 0 ? 'observed' : pricedUsd.length > 0 ? 'partial' : 'unavailable';

        return {
            llmCallCount,
            unpricedCallCount,
            pricingCoverage,
            usdCostMicros,
            cacheReadTokens,
            cacheWriteTokens,
        };
    } catch {
        return unknown();
    }
}

/** Map a classified request failure to a bounded error category. */
function errorCategoryForCode(code: string | null | undefined): AgentErrorCategory {
    switch (code) {
        case AiErrorCode.INVALID_API_KEY:
        case AiErrorCode.UNAUTHORIZED:
            return 'auth';
        case AiErrorCode.RATE_LIMIT:
            return 'rate_limit';
        case AiErrorCode.NETWORK_ERROR:
        case AiErrorCode.SERVICE_UNAVAILABLE:
        case AiErrorCode.BAD_GATEWAY:
            return 'network';
        case AiErrorCode.TIMEOUT:
        case AiErrorCode.GATEWAY_TIMEOUT:
        case AiErrorCode.MCP_TOOL_TIMEOUT:
            return 'timeout';
        case AiErrorCode.INVALID_CONFIG:
        case AiErrorCode.MISSING_ENDPOINT:
        case AiErrorCode.UNSUPPORTED_INPUT:
            return 'invalid_request';
        case AiErrorCode.API_ERROR:
        case AiErrorCode.STREAM_ERROR:
        case AiErrorCode.EMPTY_RESPONSE:
        case AiErrorCode.MODEL_NOT_FOUND:
        case AiErrorCode.MODEL_DISABLED:
        case AiErrorCode.PROVIDER_DISABLED:
        case AiErrorCode.NO_ACTIVE_MODEL:
        case AiErrorCode.MCP_CONNECTION_FAILED:
        case AiErrorCode.MCP_TOOL_EXECUTION_FAILED:
            return 'provider';
        default:
            return 'other';
    }
}

export interface AgentRequestAnalyticsOptions {
    requestKind?: AgentRequestKind;
    surface?: AgentRequestSurface;
    sink?: AgentAnalyticsSink;
}

export interface AgentRequestCompletion {
    result: AgentRequestResult;
    retryCount: number;
    modelSwitchCount: number;
    providerTtftMs?: number | null;
    /** Classified failure code when the request failed; never free-text. */
    errorCode?: string | null;
    persistenceResult: AgentPersistenceResult;
    calls: readonly AiCallRecord[];
    /** Calls whose provider actually reported usage (including an explicit zero). */
    usageReportedCalls: number;
}

/**
 * Per-logical-request product analytics.
 *
 * One instance spans every internal attempt, retry and tool iteration of a
 * single user request. It asks native for the opaque operation handle once at
 * construction and reuses that handle for every later event, so a request that
 * begins while disabled, or crosses a disable/re-enable boundary, can never be
 * tagged with a newer consent epoch. Every emit is best-effort: a missing or
 * failing analytics channel changes no request result.
 */
export class AgentRequestAnalytics {
    readonly requestId: string = crypto.randomUUID();

    private readonly sink: AgentAnalyticsSink;
    private readonly requestKind: AgentRequestKind;
    private readonly surface: AgentRequestSurface;
    private readonly startedMono: number;
    private readonly ready: Promise<void>;
    private readonly pendingSends = new Set<Promise<void>>();
    private handle: AnalyticsOperationHandle | null = null;
    private operationReleased = false;
    private terminalRecorded = false;
    private firstOutputRecorded = false;
    private toolCompletedCount = 0;
    private approvalResolvedCount = 0;
    private stage: AgentCancelStage = 'submitted';

    constructor(options: AgentRequestAnalyticsOptions = {}) {
        this.sink = options.sink ?? analyticsService;
        this.requestKind = options.requestKind ?? 'chat';
        this.surface = options.surface ?? 'main';
        this.startedMono = monotonicNowMs();
        this.ready = this.sink
            .beginOperation()
            .then((handle) => {
                this.handle = handle;
            })
            .catch(() => {
                this.handle = null;
            });
    }

    get cancelStage(): AgentCancelStage {
        return this.stage;
    }

    /** Current tool-termination count for `agent.request_completed`. */
    get toolCount(): number {
        return this.toolCompletedCount;
    }

    /** Current approval-decision count for `agent.request_completed`. */
    get approvalCount(): number {
        return this.approvalResolvedCount;
    }

    submit(attributes: {
        attachmentCount: number;
        capability?: 'none' | 'tools' | 'mcp' | 'browser' | 'other';
    }): void {
        this.emit('agent.request_submitted', {
            request_id: this.requestId,
            request_kind: this.requestKind,
            surface: this.surface,
            attachment_count_bucket: attachmentCountBucket(attributes.attachmentCount),
            ...(attributes.capability ? { capability: attributes.capability } : {}),
        });
    }

    noteFirstOutput(): void {
        if (this.firstOutputRecorded) {
            return;
        }
        this.firstOutputRecorded = true;
        this.stage = 'streaming';
        this.emit('agent.first_output_received', {
            request_id: this.requestId,
            first_output_latency_ms: clampInt(monotonicNowMs() - this.startedMono, MAX_DURATION_MS),
        });
    }

    noteToolCompleted(input: {
        category: AgentToolCategory;
        result: AgentToolResult;
        durationMs: number;
    }): void {
        this.toolCompletedCount += 1;
        this.stage = 'tool';
        this.emit('agent.tool_completed', {
            request_id: this.requestId,
            tool_id: crypto.randomUUID(),
            tool_category: input.category,
            result: input.result,
            duration_ms: clampInt(input.durationMs, MAX_DURATION_MS),
        });
    }

    noteApprovalResolved(input: { resolution: AgentApprovalResolution; waitMs: number }): void {
        this.approvalResolvedCount += 1;
        this.stage = 'approval';
        this.emit('agent.approval_resolved', {
            request_id: this.requestId,
            approval_id: crypto.randomUUID(),
            resolution: input.resolution,
            wait_ms: clampInt(input.waitMs, MAX_DURATION_MS),
        });
    }

    noteAttachmentPreparation(input: {
        attachments: readonly AttachmentIndex[];
        result: 'success' | 'failure';
        durationMs: number;
        errorCategory?: AgentAttachmentErrorCategory;
    }): void {
        if (input.attachments.length === 0) {
            return;
        }

        this.emit('attachment.preparation_completed', {
            preparation_id: crypto.randomUUID(),
            attachment_type: mergeAttachmentType(input.attachments),
            count_bucket: preparationCountBucket(input.attachments.length),
            result: input.result,
            duration_ms: clampInt(input.durationMs, MAX_DURATION_MS),
            ...(input.result === 'failure' && input.errorCategory
                ? { error_category: input.errorCategory }
                : {}),
        });
    }

    /**
     * Emit the single terminal event and release the operation handle.
     *
     * Resolves once the terminal IPC attempt settles. A duplicate finalize is a
     * no-op: the terminal event is emitted and the handle released exactly once.
     */
    async complete(input: AgentRequestCompletion): Promise<void> {
        if (this.terminalRecorded) {
            return;
        }
        this.terminalRecorded = true;

        await this.ready;

        const attributes: Record<string, AnalyticsAttributeValue> = {
            request_id: this.requestId,
            result: input.result,
            duration_ms: clampInt(monotonicNowMs() - this.startedMono, MAX_DURATION_MS),
            retry_count: clampInt(input.retryCount, MAX_COUNT),
            usage_coverage: usageCoverage(input.calls.length, input.usageReportedCalls),
            persistence_result: input.persistenceResult,
            tool_count: clampInt(this.toolCompletedCount, MAX_COUNT),
            approval_count: clampInt(this.approvalResolvedCount, MAX_COUNT),
            model_switch_count: clampInt(input.modelSwitchCount, MAX_MODEL_SWITCHES),
        };

        if (input.providerTtftMs !== undefined && input.providerTtftMs !== null) {
            attributes.provider_ttft_ms = clampInt(input.providerTtftMs, MAX_DURATION_MS);
        }
        if (input.result === 'success') {
            attributes.error_category = 'none';
        } else if (input.result === 'failure') {
            attributes.error_category = errorCategoryForCode(input.errorCode);
        }
        if (input.result === 'cancelled') {
            attributes.cancel_stage = this.stage;
        }

        const tokens = summedTokens(input.calls, input.usageReportedCalls);
        if (tokens !== null) {
            attributes.total_tokens = clampInt(tokens, MAX_TOKENS);
        }

        try {
            const pricing = await resolvePricing(input.calls, input.usageReportedCalls);
            attributes.pricing_coverage = pricing.pricingCoverage;
            attributes.llm_call_count = clampInt(pricing.llmCallCount, MAX_COUNT);
            attributes.unpriced_call_count = clampInt(pricing.unpricedCallCount, MAX_COUNT);
            if (pricing.usdCostMicros !== null) {
                attributes.cost_usd_micros = clampInt(pricing.usdCostMicros, MAX_COST_MICROS);
            }
            // Cache counts are only defensible when upstream actually reported a
            // non-zero value; a normalized missing value is not an observed zero.
            if (pricing.cacheReadTokens > 0) {
                attributes.cache_read_tokens = clampInt(pricing.cacheReadTokens, MAX_TOKENS);
            }
            if (pricing.cacheWriteTokens > 0) {
                attributes.cache_write_tokens = clampInt(pricing.cacheWriteTokens, MAX_TOKENS);
            }

            await this.send('agent.request_completed', attributes);
        } finally {
            // Every terminal path releases the handle it began with, and only
            // once; a duplicate finalize is a no-op. The release is fire-and-forget
            // so a slow or hung native release never delays the request result.
            void this.releaseOperation();
        }
    }

    private emit(
        eventName: AnalyticsEventName,
        attributes: Record<string, AnalyticsAttributeValue>
    ): void {
        const send = this.ready
            .then(() => this.send(eventName, attributes))
            .catch(() => {
                // Best-effort: analytics never propagates into the request.
            });
        this.pendingSends.add(send);
        void send.finally(() => this.pendingSends.delete(send));
    }

    /**
     * Release the captured native handle exactly once, after the events bound to
     * it settled, so no event is retagged with a newer session or epoch.
     *
     * The release is best-effort: a failing or slow channel is swallowed and
     * never delays or changes the request outcome.
     */
    private async releaseOperation(): Promise<void> {
        if (this.operationReleased) {
            return;
        }
        this.operationReleased = true;

        const handle = this.handle;
        if (!handle) {
            return;
        }

        await Promise.allSettled([...this.pendingSends]);
        try {
            await this.sink.completeOperation(handle);
        } catch {
            // Best-effort: an unreleased handle only costs a bounded native slot.
        }
    }

    private async send(
        eventName: AnalyticsEventName,
        attributes: Record<string, AnalyticsAttributeValue>
    ): Promise<void> {
        const handle = this.handle;
        if (!handle) {
            return;
        }

        try {
            await this.sink.track(eventName, attributes, {
                operation: handle,
                occurredAtMs: Date.now(),
            });
        } catch {
            // Best-effort: the request result does not depend on the channel.
        }
    }
}

export function createAgentRequestAnalytics(
    options: AgentRequestAnalyticsOptions = {}
): AgentRequestAnalytics {
    return new AgentRequestAnalytics(options);
}
