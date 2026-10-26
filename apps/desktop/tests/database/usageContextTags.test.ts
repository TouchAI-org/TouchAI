// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { getContextProfiles, getContextTurnPoints } from '@database/queries/usageContext';
import type { InvokeArgs } from '@tauri-apps/api/core';
import { interceptTauriInvoke } from '@tests/utils/tauri';
import { describe, expect, it } from 'vitest';

/**
 * The context page ends in a set of advisory tags ("leans light", "fills fast", "flaky") and a
 * 0-100 score. Each tag is a claim about the user's sessions, so each has to fire on the data
 * that actually justifies it and stay quiet otherwise.
 *
 * The system boundary replaced here is the Tauri SQL IPC: rows are handed to the query layer and
 * the scoring, aggregation and tagging above it run for real.
 */

const FILTER = { from: '2026-01-01 00:00:00', to: '2026-12-31 23:59:59' };

function request(payload: InvokeArgs | undefined) {
    return (payload as { request: { sql: string } }).request;
}

interface SampleInput {
    turnId: number;
    createdAt?: string;
    modelId?: number;
    modelName?: string;
    window?: number;
    inputTokens?: number;
    cacheReadTokens?: number;
    /** Total characters of the system prompt. */
    systemPromptTotal?: number;
    /** Characters covered by the fragments, i.e. the fixed prompt blocks. */
    fragmentChars?: number;
    userPrompt?: number;
    builtinToolDefinitions?: number;
    mcpToolDefinitions?: number;
    attachments?: number;
    failed?: boolean;
}

function sampleRow(input: SampleInput) {
    const {
        builtinToolDefinitions = 0,
        mcpToolDefinitions = 0,
        attachments = 0,
        window = 200_000,
        inputTokens = 1_000,
        cacheReadTokens = 0,
        systemPromptTotal = 0,
        fragmentChars = 0,
        userPrompt = 0,
    } = input;

    return {
        turnId: input.turnId,
        createdAt:
            input.createdAt ??
            `2026-05-${String((input.turnId % 28) + 1).padStart(2, '0')} 10:00:00`,
        modelId: input.modelId ?? 1,
        modelName: input.modelName ?? 'Model A',
        window,
        promptTokens: inputTokens + cacheReadTokens,
        cacheReadTokens,
        inputTokens,
        breakdown: JSON.stringify({
            fragments: fragmentChars > 0 ? { platform: fragmentChars } : {},
            userPrompt,
            attachments,
            builtinToolDefinitions,
            mcpToolDefinitions,
            systemPromptTotal,
        }),
        failed: input.failed ? 1 : 0,
    };
}

function respondWith(rows: Array<Record<string, unknown>>) {
    interceptTauriInvoke((call) => {
        if (call.cmd !== 'database_query') return undefined;
        if (!request(call.payload).sql.includes('session_turns')) return { rows: [] };
        return { rows, rowsAffected: 0, lastInsertId: null };
    });
}

function tagKeysOf(profile: { tags: Array<{ key: string }> } | null): string[] {
    return (profile?.tags ?? []).map((tag) => tag.key);
}

describe('user is told their context setup leans light', () => {
    it('user gets the light tag when the fixed prompt is a sliver of the window', async () => {
        respondWith([sampleRow({ turnId: 1, systemPromptTotal: 0, window: 200_000 })]);

        const { overall } = await getContextProfiles(FILTER);

        // Almost nothing is spent before the conversation starts.
        expect(overall?.baselineMedian).toBe(0);
        expect(tagKeysOf(overall)).toContain('lean');
        expect(tagKeysOf(overall)).not.toContain('heavyStart');
    });

    it('user gets the heavy-start tag when the fixed prompt eats a fifth of the window', async () => {
        respondWith([
            sampleRow({
                turnId: 1,
                systemPromptTotal: 100_000,
                fragmentChars: 100_000,
                window: 100_000,
            }),
        ]);

        const { overall } = await getContextProfiles(FILTER);

        // 100k characters of system prompt is ~37.5k tokens against a 100k window.
        expect(overall?.baselineMedian).toBe(37_500);
        expect(tagKeysOf(overall)).toContain('heavyStart');
        expect(tagKeysOf(overall)).not.toContain('lean');
    });
});

describe('user is told their tool definitions dominate the prompt', () => {
    it('user gets the MCP-heavy tag when MCP definitions are a large fixed cost', async () => {
        respondWith([
            sampleRow({
                turnId: 1,
                systemPromptTotal: 20_000,
                fragmentChars: 0,
                mcpToolDefinitions: 20_000,
                window: 200_000,
            }),
        ]);

        const { overall } = await getContextProfiles(FILTER);

        expect(tagKeysOf(overall)).toContain('mcpHeavy');
    });

    it('user does not get the MCP-heavy tag when the MCP definitions are small', async () => {
        respondWith([
            sampleRow({
                turnId: 1,
                systemPromptTotal: 20_000,
                mcpToolDefinitions: 400,
                window: 200_000,
            }),
        ]);

        expect(tagKeysOf((await getContextProfiles(FILTER)).overall)).not.toContain('mcpHeavy');
    });
});

describe('user is told how fast their context fills', () => {
    it('user gets the fills-fast tag when each turn adds a noticeable slice of the window', async () => {
        respondWith([
            sampleRow({ turnId: 1, inputTokens: 1_000, window: 10_000 }),
            sampleRow({ turnId: 2, inputTokens: 1_500, window: 10_000 }),
        ]);

        const { overall } = await getContextProfiles(FILTER);

        // A 500-token step on a 10k window is 5% per turn.
        expect(overall?.growthMedian).toBe(500);
        expect(tagKeysOf(overall)).toContain('fillsFast');
    });

    it('user does not get the fills-fast tag when the context grows slowly', async () => {
        respondWith([
            sampleRow({ turnId: 1, inputTokens: 1_000, window: 200_000 }),
            sampleRow({ turnId: 2, inputTokens: 1_100, window: 200_000 }),
        ]);

        expect(tagKeysOf((await getContextProfiles(FILTER)).overall)).not.toContain('fillsFast');
    });

    it('user gets the near-full tag when a turn came close to the window limit', async () => {
        respondWith([sampleRow({ turnId: 1, inputTokens: 900, window: 1_000 })]);

        const { overall } = await getContextProfiles(FILTER);

        expect(overall?.peakFill).toBeCloseTo(0.9);
        expect(tagKeysOf(overall)).toContain('nearFull');
    });

    it('user gets no near-full tag when every turn stayed well below the limit', async () => {
        respondWith([sampleRow({ turnId: 1, inputTokens: 100, window: 1_000 })]);

        expect(tagKeysOf((await getContextProfiles(FILTER)).overall)).not.toContain('nearFull');
    });

    it('user gets the compacts tag when a turn shrank the prompt', async () => {
        respondWith([
            sampleRow({ turnId: 1, inputTokens: 30_000, window: 200_000 }),
            sampleRow({ turnId: 2, inputTokens: 5_000, window: 200_000 }),
        ]);

        const { overall } = await getContextProfiles(FILTER);

        expect(overall?.compactCount).toBe(1);
        expect(tagKeysOf(overall)).toContain('compacts');
    });
});

describe('user is told what fills their prompt', () => {
    it('user gets the attachment-heavy tag when attachments dominate the context', async () => {
        respondWith([
            sampleRow({
                turnId: 1,
                systemPromptTotal: 1_000,
                fragmentChars: 1_000,
                userPrompt: 100,
                attachments: 900,
                window: 200_000,
            }),
        ]);

        const { overall } = await getContextProfiles(FILTER);

        const attachmentShare = overall?.shares.find((share) => share.key === 'attachments')?.share;
        expect(attachmentShare).toBeCloseTo(0.45);
        expect(tagKeysOf(overall)).toContain('attachmentHeavy');
    });

    it('user gets the prompt-bloat tag when their own words take most of the context', async () => {
        respondWith([
            sampleRow({
                turnId: 1,
                systemPromptTotal: 1_000,
                fragmentChars: 1_000,
                userPrompt: 4_000,
                window: 200_000,
            }),
        ]);

        const { overall } = await getContextProfiles(FILTER);

        expect(tagKeysOf(overall)).toContain('promptBloat');
        expect(tagKeysOf(overall)).not.toContain('attachmentHeavy');
    });

    it('user gets no attachment or bloat tag when the context is ordinary', async () => {
        respondWith([
            sampleRow({
                turnId: 1,
                systemPromptTotal: 3_000,
                fragmentChars: 3_000,
                userPrompt: 500,
                window: 200_000,
            }),
        ]);

        const tags = tagKeysOf((await getContextProfiles(FILTER)).overall);
        expect(tags).not.toContain('attachmentHeavy');
        expect(tags).not.toContain('promptBloat');
    });
});

describe('user is told whether their sessions are steady or flaky', () => {
    it('user gets the steady tag after twenty turns with no failures', async () => {
        respondWith(
            Array.from({ length: 20 }, (_value, index) =>
                sampleRow({ turnId: index + 1, inputTokens: 1_000 })
            )
        );

        const { overall } = await getContextProfiles(FILTER);

        expect(overall?.turnCount).toBe(20);
        expect(overall?.errorRate).toBe(0);
        expect(tagKeysOf(overall)).toContain('steady');
        expect(tagKeysOf(overall)).not.toContain('flaky');
    });

    it('user does not get the steady tag from a short run of turns', async () => {
        respondWith(
            Array.from({ length: 5 }, (_value, index) =>
                sampleRow({ turnId: index + 1, inputTokens: 1_000 })
            )
        );

        expect(tagKeysOf((await getContextProfiles(FILTER)).overall)).not.toContain('steady');
    });

    it('user gets the flaky tag when a tenth of their turns failed', async () => {
        respondWith(
            Array.from({ length: 10 }, (_value, index) =>
                sampleRow({ turnId: index + 1, inputTokens: 1_000, failed: index === 0 })
            )
        );

        const { overall } = await getContextProfiles(FILTER);

        expect(overall?.errorRate).toBeCloseTo(0.1);
        expect(tagKeysOf(overall)).toContain('flaky');
        expect(tagKeysOf(overall)).not.toContain('steady');
    });

    it('user does not get the flaky tag from a single failure in a short run', async () => {
        respondWith([
            sampleRow({ turnId: 1, inputTokens: 1_000, failed: true }),
            sampleRow({ turnId: 2, inputTokens: 1_000 }),
        ]);

        expect(tagKeysOf((await getContextProfiles(FILTER)).overall)).not.toContain('flaky');
    });

    it('user gets the cache-miss tag when a long run reuses almost nothing from cache', async () => {
        respondWith(
            Array.from({ length: 6 }, (_value, index) =>
                sampleRow({
                    turnId: index + 1,
                    inputTokens: 9_000,
                    cacheReadTokens: 1_000,
                    window: 200_000,
                })
            )
        );

        const { overall } = await getContextProfiles(FILTER);

        expect(overall?.cacheReuseRate).toBeCloseTo(0.1);
        expect(tagKeysOf(overall)).toContain('cacheMisses');
        expect(tagKeysOf(overall)).not.toContain('cacheFriendly');
    });

    it('user gets the cache-friendly tag when most of the input came from cache', async () => {
        respondWith([
            sampleRow({ turnId: 1, inputTokens: 1_000, cacheReadTokens: 9_000, window: 200_000 }),
        ]);

        const tags = tagKeysOf((await getContextProfiles(FILTER)).overall);
        expect(tags).toContain('cacheFriendly');
        expect(tags).not.toContain('cacheMisses');
    });
});

describe('user gets a profile even when the numbers behind it are missing', () => {
    it('user gets a zero window and zero fill when the model reports no context limit', async () => {
        respondWith([sampleRow({ turnId: 1, inputTokens: 1_000, window: 0 })]);

        const { overall } = await getContextProfiles(FILTER);

        // A model with no declared limit must not divide by zero anywhere.
        expect(overall?.window).toBe(0);
        expect(overall?.peakFill).toBe(0);
        expect(Number.isFinite(overall?.score ?? Number.NaN)).toBe(true);
    });

    it('user gets an empty composition when every breakdown is unusable', async () => {
        respondWith([
            {
                ...sampleRow({ turnId: 1, inputTokens: 1_000, window: 200_000 }),
                breakdown: 'not json',
            },
        ]);

        const { overall } = await getContextProfiles(FILTER);

        // The turn still counts as a sample; only the character-derived parts are missing.
        expect(overall?.turnCount).toBe(1);
        expect(overall?.baselineMedian).toBe(0);
        expect(overall?.shares.every((share) => share.tokens === 0)).toBe(true);
        expect(overall?.shares.every((share) => share.share === 0)).toBe(true);
        expect(tagKeysOf(overall)).not.toContain('attachmentHeavy');
        expect(tagKeysOf(overall)).not.toContain('promptBloat');
    });

    it('user gets no context curve when nothing matched the filter', async () => {
        respondWith([]);

        await expect(getContextTurnPoints(FILTER)).resolves.toEqual([]);
    });
});
