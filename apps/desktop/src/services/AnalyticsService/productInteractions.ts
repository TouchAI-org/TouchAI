// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { analytics } from './index';
import type { AnalyticsOperationHandle } from './types';

/**
 * Product-surface instrumentation helpers.
 *
 * Business call sites report a real, settled user action and nothing else. Each
 * helper captures the consent epoch at the real action start, keeps a random
 * analysis UUID instead of any local database id, and never throws into the
 * caller: telemetry must not change product behavior. Per-session exposure and
 * search bounds are enforced by the native runtime, not by window-local state.
 */

export type ProductSurface = 'shortcut' | 'tray' | 'main' | 'history' | 'other';
export type ProductFeature = 'quick_search' | 'attachments' | 'mcp' | 'tools' | 'history' | 'other';
export type SearchScope = 'quick' | 'history' | 'other';
export type SearchResultCategory = 'conversation' | 'message' | 'file' | 'setting' | 'other';
export type ResultAction = 'copy_answer' | 'copy_code' | 'open_external' | 'other';
export type ProviderCategory = 'openai' | 'anthropic' | 'google' | 'local' | 'other';
export type ProviderConfigurationEntry = 'onboarding' | 'settings' | 'test' | 'other';
export type ProviderConfigurationStage = 'saved' | 'validated';
export type ProviderConfigurationResult = 'success' | 'failure';
export type ProviderErrorCategory = 'auth' | 'network' | 'invalid_config' | 'provider' | 'other';
export type ResultActionOutcome = 'success' | 'failure';

const MAX_DURATION_MS = 86_400_000;

function monotonicNow(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function elapsedMs(startedAtMs: number): number {
    return Math.min(MAX_DURATION_MS, Math.max(0, Math.round(monotonicNow() - startedAtMs)));
}

export function resultCountBucket(count: number): '0' | '1' | '2-5' | '6+' {
    if (count <= 0) {
        return '0';
    }
    if (count === 1) {
        return '1';
    }
    return count <= 5 ? '2-5' : '6+';
}

/**
 * Projects a provider driver onto the fixed public category. Custom or vendor
 * driver names never leave the client: anything unrecognised becomes `other`.
 */
export function mapProviderCategory(driver: string): ProviderCategory {
    switch (driver) {
        case 'openai':
        case 'openai-compatible':
            return 'openai';
        case 'anthropic':
        case 'anthropic-compatible':
            return 'anthropic';
        case 'google':
            return 'google';
        case 'ollama':
        case 'local':
            return 'local';
        default:
            return 'other';
    }
}

/** Records a real user entry into a primary surface; never a background hydration. */
export async function trackSurfaceOpened(surface: ProductSurface): Promise<void> {
    await analytics.track('product.surface_opened', { surface });
}

/**
 * Projects a native search-surface source onto a bounded product surface.
 * Native currently reports `shortcut`/`notification`; tray and main activation
 * sources are pending a native source widening, so any source we do not yet
 * recognise (including those not-yet-emitted values) is reported as `other`
 * rather than guessed. Never throws.
 */
export function mapSearchSurfaceSource(source: string | null | undefined): ProductSurface {
    switch (source) {
        case 'shortcut':
            return 'shortcut';
        case 'tray':
            return 'tray';
        case 'main':
            return 'main';
        case 'history':
            return 'history';
        default:
            return 'other';
    }
}

/**
 * Records a visible-and-usable entry point. The native runtime bounds it to one
 * per analysis session per feature, so callers may report each exposure without
 * each keystroke triggering a state read when they pass the captured operation.
 */
export async function trackFeatureExposed(
    feature: ProductFeature,
    operation?: AnalyticsOperationHandle
): Promise<void> {
    await analytics.track('product.feature_exposed', { feature }, operation ? { operation } : {});
}

export interface ProviderConfigurationOperation {
    operation: AnalyticsOperationHandle;
    configurationId: string;
    startedAtMs: number;
}

/**
 * A configuration attempt opened at the real edit start and finished once, on
 * the real save or validation. Keeping the attempt open for the whole edit
 * session means an abandoned edit (dialog closed without saving) stays as an
 * unfinished `started` event instead of a fabricated save.
 */
export interface ProviderConfigurationAttempt {
    /** Resolves to the opened handle, or null when telemetry is unavailable. */
    readonly handle: Promise<ProviderConfigurationOperation | null>;
    /** Completes the attempt once with a real outcome; later calls are ignored. */
    complete(outcome: {
        stage: ProviderConfigurationStage;
        result: ProviderConfigurationResult;
        errorCategory?: ProviderErrorCategory;
    }): Promise<void>;
}

/**
 * Opens a configuration attempt when the user actually starts editing or
 * explicitly tests. The random configuration id correlates the start with a
 * later save or validation; an abandoned attempt simply never completes.
 */
export async function beginProviderConfiguration(input: {
    providerCategory: ProviderCategory;
    entry: ProviderConfigurationEntry;
}): Promise<ProviderConfigurationOperation> {
    const operation = await analytics.beginOperation();
    const configurationId = crypto.randomUUID();
    await analytics.track(
        'provider.configuration_started',
        {
            configuration_id: configurationId,
            provider_category: input.providerCategory,
            entry: input.entry,
        },
        { operation }
    );
    return { operation, configurationId, startedAtMs: monotonicNow() };
}

/**
 * Opens a configuration attempt at the real edit start without blocking the
 * caller. The `started` event is emitted asynchronously; the returned
 * `complete` finishes the same attempt once, so an abandoned edit never
 * completes and a save never completes twice.
 */
export function beginProviderConfigurationAttempt(input: {
    providerCategory: ProviderCategory;
    entry: ProviderConfigurationEntry;
}): ProviderConfigurationAttempt {
    const handle = beginProviderConfiguration(input).catch(
        () => null as ProviderConfigurationOperation | null
    );
    let completed = false;
    return {
        handle,
        async complete(outcome) {
            if (completed) {
                return;
            }
            completed = true;
            const attempt = await handle;
            if (!attempt) {
                return;
            }
            await completeProviderConfiguration(attempt, outcome);
        },
    };
}

/** Completes a configuration attempt with the real save/validation result. */
export async function completeProviderConfiguration(
    attempt: ProviderConfigurationOperation,
    outcome: {
        stage: ProviderConfigurationStage;
        result: ProviderConfigurationResult;
        errorCategory?: ProviderErrorCategory;
    }
): Promise<void> {
    await analytics.track(
        'provider.configuration_completed',
        {
            configuration_id: attempt.configurationId,
            stage: outcome.stage,
            result: outcome.result,
            ...(outcome.errorCategory ? { error_category: outcome.errorCategory } : {}),
            duration_ms: elapsedMs(attempt.startedAtMs),
        },
        { operation: attempt.operation }
    );
}

/**
 * Runs an existing save/validation action against an attempt that was opened at
 * the real edit start and reports the real outcome. Telemetry never blocks the
 * product path, and rejections propagate unchanged.
 */
export async function runProviderConfigurationAttempt<T>(
    attempt: ProviderConfigurationAttempt,
    run: () => Promise<T>
): Promise<T> {
    try {
        const result = await run();
        void attempt.complete({ stage: 'saved', result: 'success' }).catch(() => {});
        return result;
    } catch (error) {
        void attempt.complete({ stage: 'saved', result: 'failure' }).catch(() => {});
        throw error;
    }
}

/**
 * Runs an existing provider save/validation action and reports its real
 * outcome. Telemetry starts alongside the action and records it afterwards, so
 * the product path never awaits an analytics read. Rejections propagate
 * unchanged.
 */
export async function runProviderConfiguration<T>(
    input: { providerCategory: ProviderCategory; entry: ProviderConfigurationEntry },
    run: () => Promise<T>
): Promise<T> {
    return runProviderConfigurationAttempt(beginProviderConfigurationAttempt(input), run);
}

export interface SearchInteraction {
    operation: AnalyticsOperationHandle;
    interactionId: string;
    scope: SearchScope;
    startedAtMs: number;
    settled: boolean;
}

/**
 * Opens one search interaction. It settles once, on selection, explicit submit,
 * close or blur, using the final stable result set rather than any intermediate
 * debounce or keystroke query.
 */
export async function beginSearchInteraction(scope: SearchScope): Promise<SearchInteraction> {
    return {
        operation: await analytics.beginOperation(),
        interactionId: crypto.randomUUID(),
        scope,
        startedAtMs: monotonicNow(),
        settled: false,
    };
}

/**
 * Records the settled outcome of a search interaction. Repeated calls for the
 * same interaction are ignored, so a selection after a close cannot emit twice.
 */
export async function settleSearchInteraction(
    interaction: SearchInteraction,
    outcome: { hasResults: boolean; resultCount: number }
): Promise<void> {
    if (interaction.settled) {
        return;
    }
    interaction.settled = true;
    await analytics.track(
        'search.completed',
        {
            interaction_id: interaction.interactionId,
            search_scope: interaction.scope,
            has_results: outcome.hasResults,
            duration_ms: elapsedMs(interaction.startedAtMs),
            ...(outcome.hasResults
                ? { result_count_bucket: resultCountBucket(outcome.resultCount) }
                : {}),
        },
        { operation: interaction.operation }
    );
}

/**
 * Records a result selection on the same interaction. `opened` reflects the
 * real open outcome, so a failed open is not reported as a successful open.
 */
export async function selectSearchResult(
    interaction: SearchInteraction,
    outcome: { category: SearchResultCategory; opened: boolean }
): Promise<void> {
    await analytics.track(
        'search.result_selected',
        {
            interaction_id: interaction.interactionId,
            result_category: outcome.category,
            opened: outcome.opened,
        },
        { operation: interaction.operation }
    );
}

export interface ResultActionOperation {
    operation: AnalyticsOperationHandle;
    actionId: string;
    action: ResultAction;
}

/** Opens a result action when an existing copy/open action actually starts. */
export async function beginResultAction(action: ResultAction): Promise<ResultActionOperation> {
    return {
        operation: await analytics.beginOperation(),
        actionId: crypto.randomUUID(),
        action,
    };
}

/** Completes a result action with its real success or failure outcome. */
export async function completeResultAction(
    action: ResultActionOperation,
    result: ResultActionOutcome
): Promise<void> {
    await analytics.track(
        'result.action_completed',
        {
            action_id: action.actionId,
            action: action.action,
            result,
        },
        { operation: action.operation }
    );
}

/**
 * Runs an existing copy/open action and reports its real outcome. The action
 * itself is never delayed or altered: telemetry starts alongside it and records
 * success or failure afterwards. Rejections propagate unchanged.
 */
export async function runResultAction<T>(action: ResultAction, run: () => Promise<T>): Promise<T> {
    const operation = beginResultAction(action);
    try {
        const result = await run();
        void operation.then((attempt) => completeResultAction(attempt, 'success')).catch(() => {});
        return result;
    } catch (error) {
        void operation.then((attempt) => completeResultAction(attempt, 'failure')).catch(() => {});
        throw error;
    }
}
