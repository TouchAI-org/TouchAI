// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { getContextProfiles, getContextTurnPoints } from '@database/queries/usageContext';
import type { InvokeArgs } from '@tauri-apps/api/core';
import { interceptTauriInvoke } from '@tests/utils/tauri';
import { describe, expect, it } from 'vitest';

const FILTER = { from: '2026-01-01 00:00:00', to: '2026-12-31 23:59:59' };

function request(payload: InvokeArgs | undefined) {
    return (payload as { request: { sql: string } }).request;
}

interface SampleInput {
    turnId: number;
    createdAt: string;
    modelId: number;
    modelName: string;
    window: number;
    inputTokens: number;
    cacheReadTokens: number;
    /** system prompt 总字符数 */
    systemPromptTotal: number;
    /** fragments 的字符数合计（用于反推对话历史） */
    fragmentChars: number;
    userPrompt: number;
    builtinToolDefinitions?: number;
    mcpToolDefinitions?: number;
    attachments?: number;
    failed?: boolean;
}

/** 按 `loadSamples` 的 SELECT 顺序返回一行 */
function sampleRow(input: SampleInput) {
    const { builtinToolDefinitions = 0, mcpToolDefinitions = 0, attachments = 0 } = input;

    return {
        turnId: input.turnId,
        createdAt: input.createdAt,
        modelId: input.modelId,
        modelName: input.modelName,
        window: input.window,
        // promptTokens = input + cacheRead + cacheWrite
        promptTokens: input.inputTokens + input.cacheReadTokens,
        cacheReadTokens: input.cacheReadTokens,
        inputTokens: input.inputTokens,
        breakdown: JSON.stringify({
            fragments: { platform: input.fragmentChars },
            userPrompt: input.userPrompt,
            attachments,
            builtinToolDefinitions,
            mcpToolDefinitions,
            systemPromptTotal: input.systemPromptTotal,
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

describe('when the user looks at how full the context gets', () => {
    it('user gets nothing to show when no turn was sampled', async () => {
        respondWith([]);

        const result = await getContextProfiles(FILTER);

        expect(result.overall).toBeNull();
        expect(result.models).toEqual([]);
    });

    it('user sees the provider-reported prompt size, not an estimate', async () => {
        respondWith([
            sampleRow({
                turnId: 3,
                createdAt: '2026-05-03 10:00:00',
                modelId: 1,
                modelName: 'Model A',
                window: 200_000,
                inputTokens: 1_000,
                cacheReadTokens: 9_000,
                systemPromptTotal: 3_000,
                fragmentChars: 3_000,
                userPrompt: 40,
            }),
        ]);

        const { overall } = await getContextProfiles(FILTER);

        // 真实 prompt 是 10_000，绝不等于按字符估算出来的值
        expect(overall?.promptMedian).toBe(10_000);
        expect(overall?.promptP90).toBe(10_000);
        expect(overall?.peakFill).toBeCloseTo(0.05, 5);
    });

    it('user sees how much of the input was served from cache', async () => {
        respondWith([
            sampleRow({
                turnId: 1,
                createdAt: '2026-05-01 10:00:00',
                modelId: 1,
                modelName: 'Model A',
                window: 100_000,
                inputTokens: 250,
                cacheReadTokens: 750,
                systemPromptTotal: 0,
                fragmentChars: 0,
                userPrompt: 0,
            }),
        ]);

        const { overall } = await getContextProfiles(FILTER);

        // 750 / (750 + 250)
        expect(overall?.cacheReuseRate).toBeCloseTo(0.75, 5);
    });

    it('user sees a compaction flagged when the prompt suddenly shrinks', async () => {
        respondWith([
            sampleRow({
                turnId: 1,
                createdAt: '2026-05-01 10:00:00',
                modelId: 1,
                modelName: 'Model A',
                window: 500_000,
                inputTokens: 40_000,
                cacheReadTokens: 0,
                systemPromptTotal: 0,
                fragmentChars: 0,
                userPrompt: 0,
            }),
            sampleRow({
                turnId: 2,
                createdAt: '2026-05-01 11:00:00',
                modelId: 1,
                modelName: 'Model A',
                window: 500_000,
                inputTokens: 5_000,
                cacheReadTokens: 0,
                systemPromptTotal: 0,
                fragmentChars: 0,
                userPrompt: 0,
            }),
        ]);

        const { overall } = await getContextProfiles(FILTER);

        expect(overall?.compactCount).toBe(1);
    });

    it('user gets no compaction flag for a small drop', async () => {
        respondWith([
            sampleRow({
                turnId: 1,
                createdAt: '2026-05-01 10:00:00',
                modelId: 1,
                modelName: 'Model A',
                window: 500_000,
                inputTokens: 40_000,
                cacheReadTokens: 0,
                systemPromptTotal: 0,
                fragmentChars: 0,
                userPrompt: 0,
            }),
            sampleRow({
                turnId: 2,
                createdAt: '2026-05-01 11:00:00',
                modelId: 1,
                modelName: 'Model A',
                window: 500_000,
                inputTokens: 30_000,
                cacheReadTokens: 0,
                systemPromptTotal: 0,
                fragmentChars: 0,
                userPrompt: 0,
            }),
        ]);

        const { overall } = await getContextProfiles(FILTER);

        expect(overall?.compactCount).toBe(0);
    });

    it('user sees one consistent prompt size per model', async () => {
        respondWith([
            sampleRow({
                turnId: 1,
                createdAt: '2026-05-01 10:00:00',
                modelId: 1,
                modelName: 'Model A',
                window: 100_000,
                inputTokens: 500,
                cacheReadTokens: 0,
                systemPromptTotal: 0,
                fragmentChars: 0,
                userPrompt: 0,
            }),
            sampleRow({
                turnId: 2,
                createdAt: '2026-05-02 10:00:00',
                modelId: 2,
                modelName: 'Model B',
                window: 200_000,
                inputTokens: 3_000,
                cacheReadTokens: 0,
                systemPromptTotal: 0,
                fragmentChars: 0,
                userPrompt: 0,
            }),
        ]);

        const { models } = await getContextProfiles(FILTER);

        // 总体是 500 与 3000 的合并样本，不是两个模型平均值的平均
        expect(models).toHaveLength(2);
        expect(models.find((item) => item.modelName === 'Model A')?.promptMedian).toBe(500);
        expect(models.find((item) => item.modelName === 'Model B')?.promptMedian).toBe(3_000);
    });

    it('user sees each score dimension stay within its weight', async () => {
        respondWith([
            sampleRow({
                turnId: 1,
                createdAt: '2026-05-01 10:00:00',
                modelId: 1,
                modelName: 'Model A',
                window: 100_000,
                inputTokens: 1_000,
                cacheReadTokens: 1_000,
                systemPromptTotal: 3_000,
                fragmentChars: 3_000,
                userPrompt: 100,
            }),
        ]);

        const { overall } = await getContextProfiles(FILTER);

        expect(overall?.scores.map((part) => part.key)).toEqual([
            'cache',
            'lean',
            'pace',
            'reliable',
        ]);
        for (const part of overall?.scores ?? []) {
            expect(part.points).toBeGreaterThanOrEqual(0);
            expect(part.points).toBeLessThanOrEqual(part.most);
        }
        const total = (overall?.scores ?? []).reduce((sum, part) => sum + part.points, 0);
        expect(overall?.score).toBe(total);
    });

    it('user sees each stacked segment counted in the right bucket', async () => {
        respondWith([
            sampleRow({
                turnId: 1,
                createdAt: '2026-05-01 10:00:00',
                modelId: 1,
                modelName: 'Model A',
                window: 100_000,
                inputTokens: 1_000,
                cacheReadTokens: 0,
                // systemPrompt 比 fragments 长出 2000 字符 → 那部分是对话历史
                systemPromptTotal: 5_000,
                fragmentChars: 3_000,
                userPrompt: 100,
                mcpToolDefinitions: 900,
                builtinToolDefinitions: 300,
                attachments: 50,
            }),
        ]);

        const { overall } = await getContextProfiles(FILTER);
        const shares = new Map(overall?.shares.map((share) => [share.key, share]));

        expect(shares.get('conversation')?.share).toBeCloseTo(2_000 / 6_350, 4);
        expect(shares.get('mcpToolDefinitions')?.share).toBeCloseTo(900 / 6_350, 4);
        // 各分段占比之和为 1，不允许因为分段重叠而超过
        const total = (overall?.shares ?? []).reduce((sum, share) => sum + share.share, 0);
        expect(total).toBeCloseTo(1, 6);
    });
});

describe('when the user follows the context size turn by turn', () => {
    it('user sees the turns in time order with the compaction marked', async () => {
        respondWith([
            sampleRow({
                turnId: 2,
                createdAt: '2026-05-02 10:00:00',
                modelId: 1,
                modelName: 'Model A',
                window: 100_000,
                inputTokens: 5_000,
                cacheReadTokens: 0,
                systemPromptTotal: 0,
                fragmentChars: 0,
                userPrompt: 0,
            }),
            sampleRow({
                turnId: 1,
                createdAt: '2026-05-01 10:00:00',
                modelId: 1,
                modelName: 'Model A',
                window: 100_000,
                inputTokens: 40_000,
                cacheReadTokens: 0,
                systemPromptTotal: 0,
                fragmentChars: 0,
                userPrompt: 0,
            }),
        ]);

        const points = await getContextTurnPoints(FILTER);

        expect(points.map((point) => point.turnId)).toEqual([1, 2]);
        expect(points[0]?.fillRate).toBeCloseTo(0.4, 5);
        expect(points[1]?.isCompaction).toBe(true);
    });

    it('user gets no compaction flag when the model changed', async () => {
        respondWith([
            sampleRow({
                turnId: 1,
                createdAt: '2026-05-01 10:00:00',
                modelId: 1,
                modelName: 'Model A',
                window: 100_000,
                inputTokens: 40_000,
                cacheReadTokens: 0,
                systemPromptTotal: 0,
                fragmentChars: 0,
                userPrompt: 0,
            }),
            sampleRow({
                turnId: 2,
                createdAt: '2026-05-02 10:00:00',
                modelId: 2,
                modelName: 'Model B',
                window: 100_000,
                inputTokens: 5_000,
                cacheReadTokens: 0,
                systemPromptTotal: 0,
                fragmentChars: 0,
                userPrompt: 0,
            }),
        ]);

        const points = await getContextTurnPoints(FILTER);

        // 换模型后的窗口本就不同，不能当成压缩
        expect(points[1]?.isCompaction).toBe(false);
    });
});
