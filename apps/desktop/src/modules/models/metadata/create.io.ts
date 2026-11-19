import { isLlmMetadataAliasEmpty, isLlmMetadataEmpty } from '@database/queries/llmMetadata';

import { cancelResponseBody } from '@/platform/http';
import { awaitAbortable, combineAbortSignals } from '@/utils/abort';

import type { ModelMetadataRefreshResult } from '../contracts';
import { buildMetadataList } from './catalog.io';
import {
    isModelMetadataMissing,
    markModelMetadataChecked,
    readModelMetadataLastCheckedAt,
    readModelMetadataLastUpdatedAt,
    readModelMetadataSourceEtag,
    replaceModelMetadata,
} from './store.io';
import { syncAllModelsMetadata } from './sync.io';

export const MODEL_METADATA_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;
const REFRESH_TIMEOUT_MS = 60_000;

/** Metadata is shared by main's callers, not by unrelated Models instances. */
export function createModelMetadata(input: { fetch: typeof fetch; report(error: unknown): void }) {
    const fetchMetadata = input.fetch;
    const report = input.report.bind(input);
    const lifetime = new AbortController();
    let refresh: Promise<ModelMetadataRefreshResult> | undefined;
    let initialization: Promise<void> | undefined;

    async function shouldCheck(intervalMs = MODEL_METADATA_CHECK_INTERVAL_MS): Promise<boolean> {
        lifetime.signal.throwIfAborted();
        const checked = await awaitAbortable(readModelMetadataLastCheckedAt, lifetime.signal);
        return (
            !checked ||
            !Number.isFinite(Date.parse(checked)) ||
            Date.now() - Date.parse(checked) >= intervalMs
        );
    }
    async function update(): Promise<ModelMetadataRefreshResult> {
        const deadline = new AbortController();
        const timer = setTimeout(
            () => deadline.abort(new DOMException('Metadata refresh timed out', 'TimeoutError')),
            REFRESH_TIMEOUT_MS
        );
        const combined = combineAbortSignals([lifetime.signal, deadline.signal]);
        const { signal } = combined;
        try {
            const etag = await awaitAbortable(readModelMetadataSourceEtag, signal);
            const response = await awaitAbortable(
                () =>
                    fetchMetadata('https://models.dev/api.json', {
                        method: 'GET',
                        signal,
                        headers: etag ? { 'If-None-Match': etag } : {},
                    }),
                signal
            );
            signal.throwIfAborted();
            if (response.status === 304) {
                await cancelResponseBody(response, 'ModelMetadata response discarded');
                signal.throwIfAborted();
                await markModelMetadataChecked({ checkedAt: new Date().toISOString(), etag });
                return { status: 'unchanged' };
            }
            if (!response.ok) {
                await cancelResponseBody(response, 'ModelMetadata response discarded');
                throw new Error(`Failed to fetch metadata: ${response.statusText}`);
            }
            const contents = buildMetadataList(await awaitAbortable(() => response.json(), signal));
            signal.throwIfAborted();
            // Once admitted, the existing native transaction must finish intact.
            await replaceModelMetadata(contents, {
                markUpdatedAt: true,
                sourceEtag: response.headers.get('etag'),
            });
            return { status: 'updated' };
        } catch (error) {
            if (!lifetime.signal.aborted) {
                try {
                    report(error);
                } catch {
                    /* Passive diagnostics. */
                }
            }
            throw error;
        } finally {
            combined.dispose();
            clearTimeout(timer);
        }
    }
    function refreshMetadata(
        options: { force?: boolean; intervalMs?: number; signal?: AbortSignal } = {}
    ): Promise<ModelMetadataRefreshResult> {
        if (lifetime.signal.aborted) return Promise.reject(lifetime.signal.reason);
        if (options.signal?.aborted) return Promise.reject(options.signal.reason);
        if (!refresh) {
            refresh = (async () => {
                if (initialization) await initialization;
                if (!options.force && !(await shouldCheck(options.intervalMs)))
                    return { status: 'skipped', reason: 'fresh' } as const;
                return update();
            })().finally(() => {
                refresh = undefined;
            });
        }
        // A client may detach; only this owner or its deadline cancels shared work.
        const pending = refresh;
        return awaitAbortable(() => pending, options.signal);
    }
    function initialize(): Promise<void> {
        if (lifetime.signal.aborted) return Promise.reject(lifetime.signal.reason);
        if (!initialization)
            initialization = (async () => {
                const empty = await awaitAbortable(isLlmMetadataEmpty, lifetime.signal);
                const aliasesEmpty =
                    empty || (await awaitAbortable(isLlmMetadataAliasEmpty, lifetime.signal));
                if (aliasesEmpty) {
                    const seed = await awaitAbortable(() => import('./seed.io'), lifetime.signal);
                    lifetime.signal.throwIfAborted();
                    await seed.seedModelMetadataFromSnapshot();
                } else {
                    lifetime.signal.throwIfAborted();
                    await syncAllModelsMetadata();
                }
            })().catch((error: unknown) => {
                initialization = undefined;
                throw error;
            });
        return initialization;
    }
    return Object.freeze({
        initialize,
        refresh: refreshMetadata,
        isMissing: (options?: { signal?: AbortSignal }) => {
            lifetime.signal.throwIfAborted();
            return awaitAbortable(
                () => awaitAbortable(isModelMetadataMissing, lifetime.signal),
                options?.signal
            );
        },
        readLastUpdatedAt: (options?: { signal?: AbortSignal }) => {
            lifetime.signal.throwIfAborted();
            return awaitAbortable(
                () => awaitAbortable(readModelMetadataLastUpdatedAt, lifetime.signal),
                options?.signal
            );
        },
        shouldCheck,
        async dispose() {
            lifetime.abort();
            await Promise.allSettled([
                ...(refresh ? [refresh] : []),
                ...(initialization ? [initialization] : []),
            ]);
        },
    });
}

export type ModelMetadata = ReturnType<typeof createModelMetadata>;
