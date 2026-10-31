import {
    abandonProviderConfiguration,
    beginProviderConfiguration,
    beginProviderConfigurationAttempt,
    beginResultAction,
    beginSearchInteraction,
    completeProviderConfiguration,
    completeResultAction,
    finishSearchInteraction,
    mapSearchSurfaceSource,
    resultCountBucket,
    runProviderConfiguration,
    runProviderConfigurationAttempt,
    runResultAction,
    selectSearchResult,
    settleSearchInteraction,
    trackFeatureExposed,
    trackSearchFeatureExposed,
    trackSurfaceOpened,
} from '@services/AnalyticsService/productInteractions';
import type { AnalyticsState } from '@services/AnalyticsService/types';
import { native } from '@services/NativeService';
import { deferred } from '@tests/utils/productAnalytics';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@services/NativeService', () => ({
    native: {
        analytics: {
            getState: vi.fn(),
            setEnabled: vi.fn(),
            clearPending: vi.fn(),
            track: vi.fn(),
            flush: vi.fn(),
            beginOperation: vi.fn(),
            completeOperation: vi.fn(),
        },
    },
}));

const nativeAnalytics = vi.mocked(native.analytics);

function state(partial: Partial<AnalyticsState> = {}): AnalyticsState {
    return {
        status: 'enabled',
        consentEpoch: 5,
        queueDepth: 0,
        pendingBytes: 0,
        transportReady: true,
        ...partial,
    };
}

describe('user opens a product surface', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        nativeAnalytics.getState.mockResolvedValue(state());
        nativeAnalytics.track.mockResolvedValue({ status: 'persisted', eventId: 'e-1' });
        nativeAnalytics.beginOperation.mockResolvedValue({
            operationId: 'op-1',
            enabled: true,
            consentEpoch: 7,
        });
        nativeAnalytics.completeOperation.mockResolvedValue(undefined);
    });

    it('user gets the entry surfaced when a real window entry opens', async () => {
        await trackSurfaceOpened('shortcut');

        expect(nativeAnalytics.track).toHaveBeenCalledWith(
            expect.objectContaining({
                eventName: 'product.surface_opened',
                attributes: { surface: 'shortcut' },
            })
        );
    });

    it('user gets the surface forwarded and lets the native runtime enforce consent', async () => {
        nativeAnalytics.track.mockResolvedValue({ status: 'disabled' });

        await trackSurfaceOpened('tray');

        expect(nativeAnalytics.track).toHaveBeenCalledWith(
            expect.objectContaining({
                eventName: 'product.surface_opened',
                attributes: { surface: 'tray' },
            })
        );
    });

    it('user gets the exposure submitted and lets the native runtime bound it per session', async () => {
        await trackFeatureExposed('quick_search');

        expect(nativeAnalytics.track).toHaveBeenCalledWith(
            expect.objectContaining({
                eventName: 'product.feature_exposed',
                attributes: { feature: 'quick_search' },
            })
        );
    });

    it('user gets the native source projected onto a bounded surface', () => {
        expect(mapSearchSurfaceSource('shortcut')).toBe('shortcut');
        expect(mapSearchSurfaceSource('tray')).toBe('tray');
        expect(mapSearchSurfaceSource('main')).toBe('main');
    });

    it('user gets an unknown native source reported as other, never guessed', () => {
        expect(mapSearchSurfaceSource('notification')).toBe('other');
        expect(mapSearchSurfaceSource('something-custom')).toBe('other');
        expect(mapSearchSurfaceSource(null)).toBe('other');
    });
});

describe('user configures a provider', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        nativeAnalytics.getState.mockResolvedValue(state({ consentEpoch: 7 }));
        nativeAnalytics.track.mockResolvedValue({ status: 'persisted', eventId: 'e-2' });
        nativeAnalytics.beginOperation.mockResolvedValue({
            operationId: 'op-1',
            enabled: true,
            consentEpoch: 7,
        });
        nativeAnalytics.completeOperation.mockResolvedValue(undefined);
    });

    it('user gets a started event with a random configuration id when editing begins', async () => {
        const attempt = await beginProviderConfiguration({
            providerCategory: 'openai',
            entry: 'settings',
        });

        expect(attempt.configurationId).toMatch(/^[0-9a-f-]{36}$/);
        expect(nativeAnalytics.track).toHaveBeenCalledWith(
            expect.objectContaining({
                eventName: 'provider.configuration_started',
                attributes: {
                    configuration_id: attempt.configurationId,
                    provider_category: 'openai',
                    entry: 'settings',
                },
            })
        );
    });

    it('user gets the completed event matched to the started operation', async () => {
        const attempt = await beginProviderConfiguration({
            providerCategory: 'anthropic',
            entry: 'settings',
        });

        await completeProviderConfiguration(attempt, { stage: 'saved', result: 'success' });

        expect(nativeAnalytics.track).toHaveBeenLastCalledWith(
            expect.objectContaining({
                eventName: 'provider.configuration_completed',
                operationId: 'op-1',
                attributes: expect.objectContaining({
                    configuration_id: attempt.configurationId,
                    stage: 'saved',
                    result: 'success',
                    duration_ms: expect.any(Number),
                }),
            })
        );
        expect(nativeAnalytics.completeOperation).toHaveBeenCalledTimes(1);
    });

    it('user gets a fixed error category when a validation fails', async () => {
        const attempt = await beginProviderConfiguration({
            providerCategory: 'openai',
            entry: 'test',
        });

        await completeProviderConfiguration(attempt, {
            stage: 'validated',
            result: 'failure',
            errorCategory: 'auth',
        });

        expect(nativeAnalytics.track).toHaveBeenLastCalledWith(
            expect.objectContaining({
                attributes: expect.objectContaining({
                    stage: 'validated',
                    result: 'failure',
                    error_category: 'auth',
                }),
            })
        );
    });

    it('user gets no completed event when a configuration attempt is abandoned', async () => {
        nativeAnalytics.track.mockClear();

        await beginProviderConfiguration({ providerCategory: 'google', entry: 'onboarding' });

        const completedCalls = nativeAnalytics.track.mock.calls.filter(
            ([request]) => request.eventName === 'provider.configuration_completed'
        );
        expect(completedCalls).toHaveLength(0);
    });

    it('user gets the saved outcome reported without delaying the save result', async () => {
        const created = await runProviderConfiguration(
            { providerCategory: 'openai', entry: 'settings' },
            async () => 'created'
        );

        expect(created).toBe('created');
        await vi.waitFor(() => {
            expect(nativeAnalytics.track).toHaveBeenCalledWith(
                expect.objectContaining({
                    eventName: 'provider.configuration_completed',
                    attributes: expect.objectContaining({ stage: 'saved', result: 'success' }),
                })
            );
            expect(nativeAnalytics.completeOperation).toHaveBeenCalledTimes(1);
        });
    });

    it('user still sees the save error when the configuration fails, with the failure reported', async () => {
        await expect(
            runProviderConfiguration(
                { providerCategory: 'anthropic', entry: 'settings' },
                async () => {
                    throw new Error('save failed');
                }
            )
        ).rejects.toThrow('save failed');

        await vi.waitFor(() => {
            expect(nativeAnalytics.track).toHaveBeenCalledWith(
                expect.objectContaining({
                    eventName: 'provider.configuration_completed',
                    attributes: expect.objectContaining({ stage: 'saved', result: 'failure' }),
                })
            );
            expect(nativeAnalytics.completeOperation).toHaveBeenCalledTimes(1);
        });
    });

    it('user gets an unfinished configuration and one released handle when an edit attempt is abandoned', async () => {
        const attempt = beginProviderConfigurationAttempt({
            providerCategory: 'openai',
            entry: 'settings',
        });

        // The user opens the edit form and closes it without saving.
        await attempt.handle;
        await attempt.abandon();

        const completed = nativeAnalytics.track.mock.calls.filter(
            ([request]) => request.eventName === 'provider.configuration_completed'
        );
        expect(completed).toHaveLength(0);
        expect(nativeAnalytics.track).toHaveBeenCalledWith(
            expect.objectContaining({ eventName: 'provider.configuration_started' })
        );
        expect(nativeAnalytics.completeOperation).toHaveBeenCalledTimes(1);
    });

    it('user gets the abandoned handle released exactly once when close runs twice', async () => {
        const attempt = await beginProviderConfiguration({
            providerCategory: 'openai',
            entry: 'settings',
        });

        await abandonProviderConfiguration(attempt);
        await abandonProviderConfiguration(attempt);

        expect(nativeAnalytics.completeOperation).toHaveBeenCalledTimes(1);
    });

    it('user gets the save handle released once when a successful completion repeats', async () => {
        const attempt = await beginProviderConfiguration({
            providerCategory: 'openai',
            entry: 'settings',
        });

        await completeProviderConfiguration(attempt, { stage: 'saved', result: 'success' });
        await completeProviderConfiguration(attempt, { stage: 'saved', result: 'success' });

        expect(nativeAnalytics.completeOperation).toHaveBeenCalledTimes(1);
    });

    it('user gets the save handle released even when telemetry fails', async () => {
        nativeAnalytics.track.mockRejectedValue(new Error('ipc down'));
        const attempt = await beginProviderConfiguration({
            providerCategory: 'openai',
            entry: 'settings',
        });

        await completeProviderConfiguration(attempt, { stage: 'saved', result: 'failure' });

        expect(nativeAnalytics.completeOperation).toHaveBeenCalledTimes(1);
    });

    it('user gets the saved outcome reported for the attempt opened at the edit start', async () => {
        const attempt = beginProviderConfigurationAttempt({
            providerCategory: 'openai',
            entry: 'settings',
        });

        const saved = await runProviderConfigurationAttempt(attempt, async () => 'saved');

        expect(saved).toBe('saved');
        await vi.waitFor(() => {
            expect(nativeAnalytics.track).toHaveBeenCalledWith(
                expect.objectContaining({
                    eventName: 'provider.configuration_completed',
                    attributes: expect.objectContaining({ stage: 'saved', result: 'success' }),
                })
            );
        });
    });

    it('user still sees the save error when an edit-start save fails, with the failure reported', async () => {
        const attempt = beginProviderConfigurationAttempt({
            providerCategory: 'anthropic',
            entry: 'settings',
        });

        await expect(
            runProviderConfigurationAttempt(attempt, async () => {
                throw new Error('save failed');
            })
        ).rejects.toThrow('save failed');

        await vi.waitFor(() => {
            expect(nativeAnalytics.track).toHaveBeenCalledWith(
                expect.objectContaining({
                    eventName: 'provider.configuration_completed',
                    attributes: expect.objectContaining({ stage: 'saved', result: 'failure' }),
                })
            );
            expect(nativeAnalytics.completeOperation).toHaveBeenCalledTimes(1);
        });
    });

    it('user gets a single completed event even when the attempt settles twice', async () => {
        const attempt = beginProviderConfigurationAttempt({
            providerCategory: 'google',
            entry: 'settings',
        });

        await runProviderConfigurationAttempt(attempt, async () => 'saved');
        await attempt.complete({ stage: 'saved', result: 'success' });

        await vi.waitFor(() => {
            const completed = nativeAnalytics.track.mock.calls.filter(
                ([request]) => request.eventName === 'provider.configuration_completed'
            );
            expect(completed).toHaveLength(1);
        });
    });
});

describe('user searches in a settled interaction', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        nativeAnalytics.getState.mockResolvedValue(state());
        nativeAnalytics.track.mockResolvedValue({ status: 'persisted', eventId: 'e-3' });
        nativeAnalytics.beginOperation.mockResolvedValue({
            operationId: 'op-1',
            enabled: true,
            consentEpoch: 7,
        });
        nativeAnalytics.completeOperation.mockResolvedValue(undefined);
    });

    it('user gets exactly one settled search even when settle runs again after a selection', async () => {
        const interaction = await beginSearchInteraction('quick');

        await settleSearchInteraction(interaction, { hasResults: true, resultCount: 3 });
        await settleSearchInteraction(interaction, { hasResults: true, resultCount: 3 });

        const settled = nativeAnalytics.track.mock.calls.filter(
            ([request]) => request.eventName === 'search.completed'
        );
        expect(settled).toHaveLength(1);
        expect(settled[0]?.[0].attributes).toMatchObject({
            interaction_id: interaction.interactionId,
            search_scope: 'quick',
            has_results: true,
            result_count_bucket: '2-5',
            duration_ms: expect.any(Number),
        });
    });

    it('user gets no result count bucket when the interaction has no results', async () => {
        const interaction = await beginSearchInteraction('history');

        await settleSearchInteraction(interaction, { hasResults: false, resultCount: 0 });

        const settled = nativeAnalytics.track.mock.calls.find(
            ([request]) => request.eventName === 'search.completed'
        );
        expect(settled?.[0].attributes).not.toHaveProperty('result_count_bucket');
    });

    it('user gets the selected result tied to the same interaction id and the real open outcome', async () => {
        const interaction = await beginSearchInteraction('quick');

        await selectSearchResult(interaction, { category: 'file', opened: false });

        expect(nativeAnalytics.track).toHaveBeenCalledWith(
            expect.objectContaining({
                eventName: 'search.result_selected',
                attributes: {
                    interaction_id: interaction.interactionId,
                    result_category: 'file',
                    opened: false,
                },
            })
        );
    });

    it('user gets the final selection recorded before the search handle is released', async () => {
        const interaction = await beginSearchInteraction('quick');
        const order: string[] = [];
        nativeAnalytics.track.mockImplementation(async (request) => {
            order.push(`track:${request.eventName}`);
            return { status: 'persisted' };
        });
        nativeAnalytics.completeOperation.mockImplementation(async () => {
            order.push('complete');
        });

        await settleSearchInteraction(interaction, { hasResults: true, resultCount: 1 });
        await selectSearchResult(interaction, { category: 'file', opened: true });
        await finishSearchInteraction(interaction);

        expect(order).toEqual([
            'track:search.completed',
            'track:search.result_selected',
            'complete',
        ]);
        expect(nativeAnalytics.completeOperation).toHaveBeenCalledTimes(1);
        expect(nativeAnalytics.completeOperation).toHaveBeenCalledWith('op-1');
    });

    it('user gets the search handle released once on a close without a selection', async () => {
        const interaction = await beginSearchInteraction('quick');

        await settleSearchInteraction(interaction, { hasResults: false, resultCount: 0 });
        await finishSearchInteraction(interaction);
        await finishSearchInteraction(interaction);

        expect(nativeAnalytics.completeOperation).toHaveBeenCalledTimes(1);
        expect(
            nativeAnalytics.track.mock.calls.some(
                ([request]) => request.eventName === 'search.result_selected'
            )
        ).toBe(false);
    });

    it('user gets a feature exposure queued before the search handle is released', async () => {
        const interaction = await beginSearchInteraction('quick');
        const order: string[] = [];
        nativeAnalytics.track.mockImplementation(async (request) => {
            order.push(request.eventName);
            return { status: 'persisted' };
        });
        nativeAnalytics.completeOperation.mockImplementation(async () => {
            order.push('release');
        });

        const exposure = trackSearchFeatureExposed(interaction, 'quick_search');
        await settleSearchInteraction(interaction, { hasResults: true, resultCount: 2 });
        await finishSearchInteraction(interaction);
        await exposure;

        expect(order).toEqual(['product.feature_exposed', 'search.completed', 'release']);
    });
});

describe('user completes an existing result action', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        nativeAnalytics.getState.mockResolvedValue(state());
        nativeAnalytics.track.mockResolvedValue({ status: 'persisted', eventId: 'e-4' });
        nativeAnalytics.beginOperation.mockResolvedValue({
            operationId: 'op-1',
            enabled: true,
            consentEpoch: 7,
        });
        nativeAnalytics.completeOperation.mockResolvedValue(undefined);
    });

    it('user gets a copy action recorded after the copy resolves', async () => {
        const action = await beginResultAction('copy_answer');

        await completeResultAction(action, 'success');

        expect(nativeAnalytics.track).toHaveBeenCalledWith(
            expect.objectContaining({
                eventName: 'result.action_completed',
                attributes: {
                    action_id: action.actionId,
                    action: 'copy_answer',
                    result: 'success',
                },
            })
        );
    });

    it('user gets a failure recorded when the action fails', async () => {
        const action = await beginResultAction('open_external');

        await completeResultAction(action, 'failure');

        expect(nativeAnalytics.track).toHaveBeenCalledWith(
            expect.objectContaining({
                attributes: expect.objectContaining({ action: 'open_external', result: 'failure' }),
            })
        );
        expect(nativeAnalytics.completeOperation).toHaveBeenCalledTimes(1);
    });

    it('user gets the action handle released exactly once when completion repeats', async () => {
        const action = await beginResultAction('copy_answer');

        await completeResultAction(action, 'success');
        await completeResultAction(action, 'success');

        expect(nativeAnalytics.completeOperation).toHaveBeenCalledTimes(1);
    });

    it('user starts the copy only after its consent handle is captured', async () => {
        let resolveBegin!: (handle: {
            operationId: string;
            enabled: boolean;
            consentEpoch: number;
        }) => void;
        nativeAnalytics.beginOperation.mockReturnValue(
            new Promise((resolve) => {
                resolveBegin = resolve;
            })
        );
        const run = vi.fn(async () => 'copied');

        const actionPromise = runResultAction('copy_answer', run);
        await Promise.resolve();
        expect(run).not.toHaveBeenCalled();

        resolveBegin({ operationId: 'op-1', enabled: true, consentEpoch: 7 });
        await expect(actionPromise).resolves.toBe('copied');
        expect(run).toHaveBeenCalledTimes(1);
    });

    it('user gets the copy result before background telemetry settles', async () => {
        const track = deferred<{ status: 'persisted'; eventId: string }>();
        nativeAnalytics.track.mockReturnValue(track.promise);

        await expect(runResultAction('copy_answer', async () => 'copied')).resolves.toBe('copied');
        expect(nativeAnalytics.completeOperation).not.toHaveBeenCalled();

        track.resolve({ status: 'persisted', eventId: 'e-1' });
        await vi.waitFor(() => {
            expect(nativeAnalytics.completeOperation).toHaveBeenCalledTimes(1);
        });
    });

    it('user gets the original action rejection unchanged when telemetry also fails', async () => {
        nativeAnalytics.track.mockRejectedValue(new Error('telemetry down'));

        await expect(
            runResultAction('copy_code', () => Promise.reject(new Error('clipboard busy')))
        ).rejects.toThrow('clipboard busy');

        await vi.waitFor(() => {
            expect(nativeAnalytics.completeOperation).toHaveBeenCalledTimes(1);
        });
    });

    it('user gets the copy outcome recorded without changing the copy result', async () => {
        const copied = await runResultAction('copy_answer', async () => 'copied');

        expect(copied).toBe('copied');
        await vi.waitFor(() => {
            expect(nativeAnalytics.track).toHaveBeenCalledWith(
                expect.objectContaining({
                    eventName: 'result.action_completed',
                    attributes: expect.objectContaining({
                        action: 'copy_answer',
                        result: 'success',
                    }),
                })
            );
        });
    });

    it('user still sees the copy error when the action fails, with the failure recorded', async () => {
        await expect(
            runResultAction('copy_code', async () => {
                throw new Error('clipboard busy');
            })
        ).rejects.toThrow('clipboard busy');

        await vi.waitFor(() => {
            expect(nativeAnalytics.track).toHaveBeenCalledWith(
                expect.objectContaining({
                    eventName: 'result.action_completed',
                    attributes: expect.objectContaining({ action: 'copy_code', result: 'failure' }),
                })
            );
        });
    });
});

describe('user counts search results', () => {
    it('user gets the result count grouped into a bounded bucket', () => {
        expect(resultCountBucket(0)).toBe('0');
        expect(resultCountBucket(1)).toBe('1');
        expect(resultCountBucket(5)).toBe('2-5');
        expect(resultCountBucket(6)).toBe('6+');
        expect(resultCountBucket(10_000)).toBe('6+');
    });
});
