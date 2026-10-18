// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { normalizeAiUsage } from '@services/AgentService/infrastructure/providers/ai-sdk/stream';
import { streamText } from 'ai';
import { describe, expect, it } from 'vitest';

/**
 * 对真实 provider 的集成探针：验证 AI SDK 确实回传 totalUsage，
 * 并固化各字段的形状，供采集层（`normalizeAiUsage`）回归。
 *
 * 默认跳过——它需要本地 magpie 网关（`127.0.0.1:3425`）。
 * 手动运行：
 *
 * ```
 * TOUCHAI_USAGE_PROBE=1 pnpm test:run -- tests/integration/usage-probe.test.ts
 * ```
 *
 * 网关不可用时也可以直接跳过，所以 CI 不会因为它变红。
 */
const enabled = process.env.TOUCHAI_USAGE_PROBE === '1';
const MODEL = process.env.TOUCHAI_USAGE_PROBE_MODEL ?? 'group/auto-deepseek-v4-1-flash';
const BASE_URL = process.env.TOUCHAI_USAGE_PROBE_BASE_URL ?? 'http://127.0.0.1:3425/v1';

describe.skipIf(!enabled)('usage probe against a live provider', () => {
    it('returns a fully populated totalUsage that normalizeAiUsage can consume', async () => {
        const provider = createOpenAICompatible({
            name: 'probe',
            baseURL: BASE_URL,
            apiKey: 'probe',
        });

        const result = streamText({
            model: provider(MODEL),
            messages: [{ role: 'user', content: 'Say hello in one short sentence.' }],
            maxRetries: 0,
        });

        let finish: { finishReason: string; totalUsage: unknown } | undefined;
        for await (const part of result.fullStream) {
            if (part.type === 'finish') {
                finish = part as typeof finish;
                break;
            }
        }

        expect(finish, 'provider did not emit a finish part').toBeDefined();
        expect(finish?.finishReason).toBeTruthy();

        const usage = normalizeAiUsage(finish?.totalUsage as never);

        expect(usage, 'totalUsage was missing or unusable').toBeDefined();
        // 供应商必须至少报出输入与输出；其余分项允许缺失（由 ?? 0 兜底）
        expect(
            usage!.inputTokens + usage!.cacheReadTokens + usage!.cacheWriteTokens
        ).toBeGreaterThan(0);
        expect(usage!.outputTokens).toBeGreaterThan(0);
        // 归一后各项都必须是有限非负数，绝不能是 NaN / undefined
        for (const value of [
            usage!.inputTokens,
            usage!.outputTokens,
            usage!.cacheReadTokens,
            usage!.cacheWriteTokens,
            usage!.reasoningTokens,
        ]) {
            expect(Number.isFinite(value)).toBe(true);
            expect(value).toBeGreaterThanOrEqual(0);
        }
    }, 60_000);
});
