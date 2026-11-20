import {
    closeTestDatabases,
    openMigratedDatabase,
    routeQueriesTo,
} from '@tests/database/sqliteHarness';
import { createTestAnalyticsWindow } from '@tests/utils/analyticsWindow';
import { getTauriInvokeCalls, mockTauriCommand } from '@tests/utils/tauri';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAgentAnalytics } from '@/app/workflows/agent/analytics';
let agentAnalytics: ReturnType<typeof createAgentAnalytics>;

import type { UsageCall } from '@/modules/usage/contracts';

interface Operation {
    operationId: string;
    enabled: boolean;
    consentEpoch: number;
}
interface TrackedEvent {
    eventName: string;
    operationId: string;
    attributes: Record<string, unknown>;
}

let database: ReturnType<typeof openMigratedDatabase>;
let sequence = 0;
const completion = {
    result: 'success' as const,
    retryCount: 0,
    modelSwitchCount: 0,
    persistenceResult: 'saved' as const,
    calls: [],
    usageReportedCalls: 0,
};

function events(name: string): TrackedEvent[] {
    return getTauriInvokeCalls('analytics_track')
        .map((call) => (call.payload as { request: TrackedEvent }).request)
        .filter((event) => event.eventName === name);
}
function releases(): string[] {
    return getTauriInvokeCalls('analytics_complete_operation').map(
        (call) => (call.payload as { operationId: string }).operationId
    );
}
function enable(): Operation {
    const handle = { operationId: `operation-${++sequence}`, enabled: true, consentEpoch: 3 };
    mockTauriCommand('analytics_begin_operation', handle);
    return handle;
}
function call(overrides: Partial<UsageCall> = {}): UsageCall {
    return {
        iteration: 0,
        modelId: 1,
        modelName: 'priced-model',
        providerId: 1,
        providerName: 'private provider',
        usage: {
            inputTokens: 1000,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
        },
        usageReported: true,
        timing: { durationMs: 5 },
        toolCallsInStep: 0,
        toolArgumentErrors: 0,
        ...overrides,
    };
}
function price(modelId = 'priced-model', currency = 'USD'): void {
    database
        .prepare(
            `INSERT INTO llm_metadata (model_id, name, modalities, input_cost_per_million,
        output_cost_per_million, cost_currency) VALUES (?, 'Price fixture', '[]', '1', '1', ?)`
        )
        .run(modelId, currency);
}
function pausePricing(resolvers: Array<() => void>): void {
    routeQueriesTo(database, {
        beforeQuery: ({ sql }) => {
            if (sql.startsWith('select') && sql.includes('"input_cost_per_million"')) {
                return new Promise<void>((resolve) => {
                    resolvers.push(resolve);
                });
            }
        },
    });
}
async function terminal(): Promise<TrackedEvent> {
    await vi.waitFor(() => expect(events('agent.request_completed')).toHaveLength(1));
    return events('agent.request_completed')[0]!;
}

beforeEach(() => {
    agentAnalytics = createAgentAnalytics(createTestAnalyticsWindow().sink);
    database = openMigratedDatabase();
    routeQueriesTo(database);
    sequence = 0;
    enable();
    mockTauriCommand('analytics_complete_operation', undefined);
    mockTauriCommand('analytics_track', { status: 'persisted', eventId: 'event-fixture' });
});
afterEach(() => {
    closeTestDatabases();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('given a caller submits a typed logical-request observation', () => {
    it('user keeps one captured operation through later consent changes and releases it after the terminal event', async () => {
        const captured = enable();
        const request = agentAnalytics.createRequest();
        request.submit({ attachmentCount: 3 });
        enable();
        request.noteFirstOutput();
        request.noteFirstOutput();
        request.complete(completion);
        request.complete(completion);
        await terminal();
        await vi.waitFor(() => expect(releases()).toEqual([captured.operationId]));
        expect(events('agent.request_submitted')).toHaveLength(1);
        expect(events('agent.first_output_received')).toHaveLength(1);
        const submitted = events('agent.request_submitted')[0]!;
        expect(submitted.attributes).toMatchObject({
            attachment_count_bucket: '2-5',
            request_kind: 'chat',
            surface: 'main',
        });
        expect(events('agent.request_completed')[0]?.attributes.request_id).toBe(
            submitted.attributes.request_id
        );
        expect(
            getTauriInvokeCalls('analytics_track').every(
                (entry) =>
                    (entry.payload as { request: TrackedEvent }).request.operationId ===
                    captured.operationId
            )
        ).toBe(true);
        const nativeCalls = getTauriInvokeCalls();
        expect(
            nativeCalls.findIndex((entry) => entry.cmd === 'analytics_complete_operation')
        ).toBeGreaterThan(
            nativeCalls.reduce(
                (last, entry, index) => (entry.cmd === 'analytics_track' ? index : last),
                -1
            )
        );
    });

    it('user keeps a disabled capture suppressed even when a newer operation is enabled', async () => {
        mockTauriCommand('analytics_begin_operation', {
            operationId: 'disabled-capture',
            enabled: false,
            consentEpoch: 2,
        });
        const request = agentAnalytics.createRequest();
        enable();
        request.submit({ attachmentCount: 0 });
        request.complete(completion);
        await vi.waitFor(() => expect(releases()).toEqual(['disabled-capture']));
        expect(getTauriInvokeCalls('analytics_track')).toEqual([]);
    });

    it('user gets no events or replacement operation when sharing changes while an older capture is queued', async () => {
        let release!: (value: Operation) => void;
        vi.spyOn(Date, 'now').mockReturnValue(1_760_000_000_000);
        mockTauriCommand(
            'analytics_begin_operation',
            () =>
                new Promise<Operation>((resolve) => {
                    release = resolve;
                })
        );
        const request = agentAnalytics.createRequest();
        request.submit({ attachmentCount: 0 });
        expect(getTauriInvokeCalls('analytics_begin_operation')[0]?.payload).toEqual({
            startedAtMs: 1_760_000_000_000,
        });
        release({ operationId: '', enabled: false, consentEpoch: 0 });
        request.complete(completion);
        await Promise.resolve();
        await Promise.resolve();
        expect(getTauriInvokeCalls('analytics_begin_operation')).toHaveLength(1);
        expect(getTauriInvokeCalls('analytics_track')).toEqual([]);
        expect(releases()).toEqual([]);
    });

    it('user gets independent request identifiers for concurrent observations', async () => {
        const first = agentAnalytics.createRequest();
        const second = agentAnalytics.createRequest();
        first.submit({ attachmentCount: 0 });
        second.submit({ attachmentCount: 0 });
        first.complete(completion);
        second.complete(completion);
        await vi.waitFor(() => expect(events('agent.request_completed')).toHaveLength(2));
        expect(
            new Set(events('agent.request_submitted').map((entry) => entry.attributes.request_id))
                .size
        ).toBe(2);
    });

    it('user gets no late tool, approval or attachment events after the captured terminal outcome', async () => {
        const request = agentAnalytics.createRequest();
        request.complete(completion);
        request.noteToolCompleted({ category: 'command', result: 'success', durationMs: 1 });
        request.noteApprovalResolved({ resolution: 'approved', waitMs: 1 });
        request.noteAttachmentPreparation({
            attachments: [
                {
                    id: 'image',
                    type: 'image',
                    name: 'private.png',
                    path: 'private-path',
                    originPath: 'private-path',
                },
            ],
            result: 'success',
            durationMs: 1,
        });
        await terminal();
        expect(events('agent.tool_completed')).toEqual([]);
        expect(events('agent.approval_resolved')).toEqual([]);
        expect(events('attachment.preparation_completed')).toEqual([]);
    });

    it.each([
        ['auth', 'UNAUTHORIZED'],
        ['rate_limit', 'RATE_LIMIT'],
        ['network', 'NETWORK_ERROR'],
        ['timeout', 'TIMEOUT'],
        ['invalid_request', 'UNSUPPORTED_INPUT'],
        ['provider', 'EMPTY_RESPONSE'],
        ['other', 'UNKNOWN'],
    ] as const)(
        'user receives the bounded %s category for a %s failure without free-text diagnostics',
        async (category, code) => {
            agentAnalytics.createRequest().complete({
                ...completion,
                result: 'failure',
                errorCode: code,
            });
            expect((await terminal()).attributes.error_category).toBe(category);
        }
    );

    it('user receives a cancellation stage captured before its approval and tool phases unwind', async () => {
        const request = agentAnalytics.createRequest();
        const leaveTool = request.enterPhase('tool');
        const leaveApproval = request.enterPhase('approval');
        request.noteAbort();
        leaveApproval();
        leaveTool();
        request.complete({ ...completion, result: 'cancelled' });
        const attributes = (await terminal()).attributes;
        expect(attributes.cancel_stage).toBe('approval');
        expect(attributes.error_category).toBeUndefined();
    });

    it.each(['success', 'failure'] as const)(
        'user gets one bounded %s attachment preparation result without resource names or paths',
        async (result) => {
            const request = agentAnalytics.createRequest();
            request.noteAttachmentPreparation({
                attachments: [
                    {
                        id: 'private-image',
                        type: 'image',
                        name: 'PRIVATE_IMAGE',
                        path: 'PRIVATE_PATH',
                        originPath: 'PRIVATE_ORIGIN',
                    },
                    {
                        id: 'private-file',
                        type: 'file',
                        name: 'PRIVATE_FILE',
                        path: 'PRIVATE_PATH',
                        originPath: 'PRIVATE_ORIGIN',
                    },
                ],
                result,
                durationMs: 7,
                ...(result === 'failure' ? { errorCategory: 'io' as const } : {}),
            });
            request.complete(completion);
            await terminal();
            expect(events('attachment.preparation_completed')).toEqual([
                expect.objectContaining({
                    attributes: {
                        preparation_id: expect.any(String),
                        attachment_type: 'other',
                        count_bucket: '2-5',
                        result,
                        duration_ms: 7,
                        ...(result === 'failure' ? { error_category: 'io' } : {}),
                    },
                }),
            ]);
            expect(JSON.stringify(getTauriInvokeCalls('analytics_track'))).not.toMatch(
                /PRIVATE_|private-image|private-file/
            );
        }
    );

    it('user keeps identifying call data and raw provider metadata out of typed telemetry', async () => {
        agentAnalytics.createRequest().complete({
            ...completion,
            calls: [
                call({
                    modelName: 'SENTINEL_MODEL',
                    providerName: 'SENTINEL_PROVIDER',
                    errorMessage: 'SENTINEL_ERROR',
                    usage: {
                        inputTokens: 1,
                        outputTokens: 0,
                        cacheReadTokens: 0,
                        cacheWriteTokens: 0,
                        reasoningTokens: 0,
                        servedModel: 'SENTINEL_SERVED',
                        raw: { diagnostic: 'SENTINEL_RAW' },
                    },
                }),
            ],
        });
        await terminal();
        expect(JSON.stringify(getTauriInvokeCalls('analytics_track'))).not.toContain('SENTINEL_');
    });
});

describe('given observed provider usage and real saved pricing rows', () => {
    it.each([
        ['observed', [call()], 0, 1000],
        ['partial', [call(), call({ modelName: 'unpriced-model' })], 1, 1000],
        ['unavailable', [call({ modelName: 'unpriced-model' })], 1, undefined],
    ] as const)(
        'user gets %s pricing coverage and only the defensible USD cost',
        async (coverage, calls, unpriced, cost) => {
            price();
            agentAnalytics.createRequest().complete({ ...completion, calls });
            const attributes = (await terminal()).attributes;
            expect(attributes).toMatchObject({
                pricing_coverage: coverage,
                llm_call_count: calls.length,
                unpriced_call_count: unpriced,
            });
            expect(attributes.cost_usd_micros).toBe(cost);
        }
    );

    it.each([false, true])(
        'user gets no cost when usage and pricing belong to different calls, reversed=%s',
        async (reversed) => {
            price();
            const withoutUsage = call({ usageReported: false });
            const withoutPrice = call({ modelName: 'unpriced-model' });
            agentAnalytics.createRequest().complete({
                ...completion,
                calls: reversed ? [withoutPrice, withoutUsage] : [withoutUsage, withoutPrice],
            });
            const attributes = (await terminal()).attributes;
            expect(attributes).toMatchObject({
                usage_coverage: 'partial',
                pricing_coverage: 'unavailable',
                llm_call_count: 2,
                unpriced_call_count: 2,
                total_tokens: 1000,
            });
            expect(attributes.cost_usd_micros).toBeUndefined();
        }
    );

    it('user gets only the defensible USD subtotal when other calls lack usage or use another currency', async () => {
        price();
        price('eur-model', 'EUR');
        agentAnalytics.createRequest().complete({
            ...completion,
            calls: [call(), call({ usageReported: false }), call({ modelName: 'eur-model' })],
        });
        expect((await terminal()).attributes).toMatchObject({
            usage_coverage: 'partial',
            pricing_coverage: 'partial',
            llm_call_count: 3,
            unpriced_call_count: 2,
            cost_usd_micros: 1000,
        });
    });

    it.each([10_000, 10_001])(
        'user gets honest bounded pricing counts when %i provider calls are observed',
        async (count) => {
            price();
            const calls = Array.from({ length: count }, () =>
                call({
                    usage: {
                        inputTokens: 1,
                        outputTokens: 0,
                        cacheReadTokens: 0,
                        cacheWriteTokens: 0,
                        reasoningTokens: 0,
                    },
                })
            );
            agentAnalytics.createRequest().complete({ ...completion, calls });
            const attributes = (await terminal()).attributes;
            expect(attributes).toMatchObject({
                usage_coverage: 'observed',
                llm_call_count: 10_000,
                total_tokens: count,
                unpriced_call_count: count === 10_000 ? 0 : 10_000,
                pricing_coverage: count === 10_000 ? 'observed' : 'unavailable',
            });
            expect(attributes.cost_usd_micros).toBe(count === 10_000 ? 10_000 : undefined);
        }
    );

    it.each([0, 400])(
        'user gets cache token counts only for reported nonzero evidence, cache=%i',
        async (cache) => {
            agentAnalytics.createRequest().complete({
                ...completion,
                calls: [
                    call({
                        usage: {
                            inputTokens: 10,
                            outputTokens: 5,
                            cacheReadTokens: cache,
                            cacheWriteTokens: cache / 2,
                            reasoningTokens: 3,
                        },
                    }),
                ],
            });
            const attributes = (await terminal()).attributes;
            expect(attributes.cache_read_tokens).toBe(cache || undefined);
            expect(attributes.cache_write_tokens).toBe(cache ? cache / 2 : undefined);
            expect(attributes.total_tokens).toBe(15 + cache + cache / 2);
        }
    );
});

describe('given analytics transport or real database pricing stops responding', () => {
    beforeEach(() => vi.useFakeTimers());

    it('user gets no late events and one release when an abandoned operation capture eventually settles', async () => {
        let release!: (value: Operation) => void;
        mockTauriCommand(
            'analytics_begin_operation',
            () =>
                new Promise<Operation>((resolve) => {
                    release = resolve;
                })
        );
        const request = agentAnalytics.createRequest();
        request.submit({ attachmentCount: 0 });
        request.complete(completion);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(getTauriInvokeCalls('analytics_track')).toEqual([]);
        release({ operationId: 'late-operation', enabled: true, consentEpoch: 3 });
        await vi.advanceTimersByTimeAsync(0);
        expect(getTauriInvokeCalls('analytics_track')).toEqual([]);
        expect(releases()).toEqual(['late-operation']);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('user gets unavailable pricing and one release when a real pricing query hangs and later settles', async () => {
        const handle = enable();
        const lookups: Array<() => void> = [];
        pausePricing(lookups);
        try {
            agentAnalytics.createRequest().complete({ ...completion, calls: [call()] });
            await vi.advanceTimersByTimeAsync(60_000);
            expect(events('agent.request_completed')[0]?.attributes).toMatchObject({
                pricing_coverage: 'unavailable',
                llm_call_count: 1,
                unpriced_call_count: 1,
            });
            expect(
                events('agent.request_completed')[0]?.attributes.cost_usd_micros
            ).toBeUndefined();
            expect(releases()).toEqual([handle.operationId]);
            lookups.forEach((resolve) => resolve());
            await vi.advanceTimersByTimeAsync(0);
            expect(events('agent.request_completed')).toHaveLength(1);
            expect(releases()).toEqual([handle.operationId]);
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            lookups.forEach((resolve) => resolve());
        }
    });

    it('user gets bounded event work and one release when every event submission hangs and later settles', async () => {
        const handle = enable();
        const sends: Array<(value: unknown) => void> = [];
        mockTauriCommand(
            'analytics_track',
            () =>
                new Promise((resolve) => {
                    sends.push(resolve);
                })
        );
        try {
            const request = agentAnalytics.createRequest();
            for (let index = 0; index < 1000; index++)
                request.noteToolCompleted({
                    category: 'command',
                    result: 'success',
                    durationMs: 1,
                });
            request.complete(completion);
            await vi.advanceTimersByTimeAsync(60_000);
            expect(getTauriInvokeCalls('analytics_track').length).toBeGreaterThan(0);
            expect(getTauriInvokeCalls('analytics_track').length).toBeLessThanOrEqual(33);
            expect(releases()).toEqual([handle.operationId]);
            sends.forEach((resolve) => resolve({ status: 'persisted' }));
            await vi.advanceTimersByTimeAsync(0);
            expect(releases()).toEqual([handle.operationId]);
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            sends.forEach((resolve) => resolve({ status: 'persisted' }));
        }
    });

    it('user keeps a fixed bound on outstanding event callbacks across requests and recovers after transport resumes', async () => {
        const sends: Array<(value: unknown) => void> = [];
        mockTauriCommand(
            'analytics_track',
            () =>
                new Promise((resolve) => {
                    sends.push(resolve);
                })
        );
        try {
            for (let index = 0; index < 100; index++) {
                const request = agentAnalytics.createRequest();
                for (let tool = 0; tool < 100; tool++)
                    request.noteToolCompleted({
                        category: 'command',
                        result: 'success',
                        durationMs: 1,
                    });
                request.complete(completion);
                await vi.advanceTimersByTimeAsync(10_000);
            }
            expect(sends.length).toBeGreaterThan(0);
            expect(sends.length).toBeLessThanOrEqual(64);
            expect(releases()).toHaveLength(100);
            sends.forEach((resolve) => resolve({ status: 'persisted' }));
            await vi.advanceTimersByTimeAsync(0);
            const beforeRecovery = sends.length;
            mockTauriCommand('analytics_track', {
                status: 'persisted',
                eventId: 'recovered-event',
            });
            agentAnalytics.createRequest().complete(completion);
            await vi.advanceTimersByTimeAsync(0);
            expect(getTauriInvokeCalls('analytics_track')).toHaveLength(beforeRecovery + 1);
            expect(releases()).toHaveLength(101);
        } finally {
            sends.forEach((resolve) => resolve({ status: 'persisted' }));
        }
    });

    it('user gets bounded real pricing queries across requests while hung lookups are abandoned', async () => {
        const lookups: Array<() => void> = [];
        pausePricing(lookups);
        try {
            for (let index = 0; index < 32; index++) {
                agentAnalytics.createRequest().complete({ ...completion, calls: [call()] });
                await vi.advanceTimersByTimeAsync(10_000);
            }
            expect(lookups.length).toBeGreaterThan(0);
            expect(lookups.length).toBeLessThanOrEqual(8);
            expect(events('agent.request_completed')).toHaveLength(32);
            expect(releases()).toHaveLength(32);
            lookups.forEach((resolve) => resolve());
            await vi.advanceTimersByTimeAsync(0);
            expect(releases()).toHaveLength(32);
        } finally {
            lookups.forEach((resolve) => resolve());
        }
    });

    it('user gets a fixed limit on outstanding captures and recovers after abandoned starts settle', async () => {
        const starts: Array<(handle: Operation) => void> = [];
        mockTauriCommand(
            'analytics_begin_operation',
            () =>
                new Promise<Operation>((resolve) => {
                    starts.push(resolve);
                })
        );
        for (let index = 0; index < 1000; index++)
            agentAnalytics.createRequest().complete(completion);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(starts.length).toBeGreaterThan(0);
        expect(starts.length).toBeLessThanOrEqual(16);
        expect(getTauriInvokeCalls('analytics_track')).toEqual([]);
        starts.forEach((resolve, index) =>
            resolve({ operationId: `abandoned-${index}`, enabled: true, consentEpoch: 3 })
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(releases()).toHaveLength(starts.length);
        const handle = enable();
        agentAnalytics.createRequest().complete(completion);
        await vi.advanceTimersByTimeAsync(0);
        expect(events('agent.request_completed')).toHaveLength(1);
        expect(releases().filter((id) => id === handle.operationId)).toEqual([handle.operationId]);
    });
});
