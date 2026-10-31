import {
    beginProviderConfiguration,
    beginProviderConfigurationAttempt,
    beginResultAction,
    beginSearchInteraction,
    completeProviderConfiguration,
    completeResultAction,
    mapSearchSurfaceSource,
    resultCountBucket,
    runProviderConfiguration,
    runProviderConfigurationAttempt,
    runResultAction,
    selectSearchResult,
    settleSearchInteraction,
    trackFeatureExposed,
    trackSurfaceOpened,
} from '@services/AnalyticsService/productInteractions';
import type { AnalyticsState } from '@services/AnalyticsService/types';
import { native } from '@services/NativeService';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@services/NativeService', () => ({
    native: {
        analytics: {
            getState: vi.fn(),
            setEnabled: vi.fn(),
            clearPending: vi.fn(),
            track: vi.fn(),
            flush: vi.fn(),
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

    it('user gets no submission when statistics are off', async () => {
        nativeAnalytics.getState.mockResolvedValue(state({ status: 'disabled' }));

        await trackSurfaceOpened('tray');

        expect(nativeAnalytics.track).not.toHaveBeenCalled();
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

    it('user gets the completed event matched to the started operation with the captured epoch', async () => {
        const attempt = await beginProviderConfiguration({
            providerCategory: 'anthropic',
            entry: 'settings',
        });

        nativeAnalytics.getState.mockResolvedValue(state({ consentEpoch: 11 }));

        await completeProviderConfiguration(attempt, { stage: 'saved', result: 'success' });

        expect(nativeAnalytics.track).toHaveBeenLastCalledWith(
            expect.objectContaining({
                eventName: 'provider.configuration_completed',
                consentEpoch: 7,
                attributes: expect.objectContaining({
                    configuration_id: attempt.configurationId,
                    stage: 'saved',
                    result: 'success',
                    duration_ms: expect.any(Number),
                }),
            })
        );
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
        });
    });

    it('user gets an unfinished configuration when an edit attempt is abandoned', async () => {
        const attempt = beginProviderConfigurationAttempt({
            providerCategory: 'openai',
            entry: 'settings',
        });

        // The user opens the edit form and closes it without saving.
        await attempt.handle;

        const completed = nativeAnalytics.track.mock.calls.filter(
            ([request]) => request.eventName === 'provider.configuration_completed'
        );
        expect(completed).toHaveLength(0);
        expect(nativeAnalytics.track).toHaveBeenCalledWith(
            expect.objectContaining({ eventName: 'provider.configuration_started' })
        );
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
});

describe('user completes an existing result action', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        nativeAnalytics.getState.mockResolvedValue(state());
        nativeAnalytics.track.mockResolvedValue({ status: 'persisted', eventId: 'e-4' });
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
