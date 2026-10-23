import { describe, expect, it } from 'vitest';

import {
    expandModelIdCandidates,
    MAX_MODEL_ID_CANDIDATE_DEPTH,
    type ModelIdCandidate,
} from '@/services/AgentService/infrastructure/modelMetadata/modelIdCandidates';

function depthOf(candidates: ModelIdCandidate[], candidate: string): number | undefined {
    return candidates.find((item) => item.candidate === candidate)?.depth;
}

describe('user gets gateway-rewritten model ids matched to catalog entries', () => {
    it('user sees an untouched id kept as a single depth-0 candidate', () => {
        expect(expandModelIdCandidates('gpt-5-6-sol')).toEqual([
            { candidate: 'gpt-5-6-sol', depth: 0 },
        ]);
    });

    it('user sees date and release suffixes stripped one layer at a time', () => {
        expect(depthOf(expandModelIdCandidates('gpt-5-2025-08-07'), 'gpt-5')).toBe(1);
        expect(
            depthOf(expandModelIdCandidates('claude-3-5-haiku-20241022'), 'claude-3-5-haiku')
        ).toBe(1);
        expect(depthOf(expandModelIdCandidates('gemini-2-5-pro-202406'), 'gemini-2-5-pro')).toBe(1);
        expect(depthOf(expandModelIdCandidates('o4-mini-2025'), 'o4-mini')).toBe(1);
        expect(
            depthOf(expandModelIdCandidates('claude-3-5-haiku-latest'), 'claude-3-5-haiku')
        ).toBe(1);
        expect(depthOf(expandModelIdCandidates('gpt-5-codex-preview'), 'gpt-5-codex')).toBe(1);
        expect(depthOf(expandModelIdCandidates('deepseek-reasoner-exp'), 'deepseek-reasoner')).toBe(
            1
        );
    });

    it('user sees gateway namespaces and route prefixes stripped as independent branches', () => {
        expect(depthOf(expandModelIdCandidates('any/claude-3-5-haiku'), 'claude-3-5-haiku')).toBe(
            1
        );
        expect(depthOf(expandModelIdCandidates('auto-gpt-5-6-sol'), 'gpt-5-6-sol')).toBe(1);
        expect(depthOf(expandModelIdCandidates('any-gpt-5'), 'gpt-5')).toBe(1);

        // group/auto-xxx 需要命名空间与路由前缀两刀，两枝必须独立存在。
        const grouped = expandModelIdCandidates('group/auto-gpt-5-6-sol');
        expect(depthOf(grouped, 'auto-gpt-5-6-sol')).toBe(1);
        expect(depthOf(grouped, 'gpt-5-6-sol')).toBe(2);
    });

    it('user sees namespace and suffix stripping combined without losing either branch', () => {
        const candidates = expandModelIdCandidates('workbuddy-ai/step-5-preview');

        expect(depthOf(candidates, 'workbuddy-ai/step-5')).toBe(1);
        expect(depthOf(candidates, 'step-5-preview')).toBe(1);
        expect(depthOf(candidates, 'step-5')).toBe(2);
    });

    it('user sees matching stay case-insensitive without touching non-ASCII characters', () => {
        const candidates = expandModelIdCandidates('ANY/Claude-3-5-Haiku');

        expect(candidates[0]).toEqual({ candidate: 'any/claude-3-5-haiku', depth: 0 });
        expect(depthOf(candidates, 'claude-3-5-haiku')).toBe(1);
    });

    it('user sees expansion stop at the depth limit', () => {
        const candidates = expandModelIdCandidates('x/y/z/w/v/u/t/s');

        expect(depthOf(candidates, 't/s')).toBe(MAX_MODEL_ID_CANDIDATE_DEPTH);
        expect(depthOf(candidates, 's')).toBeUndefined();
    });

    it('user sees every candidate unique and sorted by depth', () => {
        const candidates = expandModelIdCandidates('any/auto-gpt-5-6-sol');
        const unique = new Set(candidates.map((item) => item.candidate));

        expect(unique.size).toBe(candidates.length);
        expect(candidates.map((item) => item.depth)).toEqual(
            [...candidates].map((item) => item.depth).sort((left, right) => left - right)
        );
    });

    it('user sees realistic gateway ids reach their canonical ids', () => {
        const expectations: Array<[string, string, number]> = [
            ['any/claude-3-5-haiku-20241022', 'claude-3-5-haiku', 2],
            ['group/auto-gpt-5-6-sol', 'gpt-5-6-sol', 2],
            ['deepseek-ai/DeepSeek-V3-0324', 'deepseek-v3', 2],
            ['workbuddy-ai/step-5-preview', 'step-5', 2],
            ['any/gemini-2-5-pro-latest', 'gemini-2-5-pro', 2],
        ];

        for (const [modelId, canonicalId, depth] of expectations) {
            expect(depthOf(expandModelIdCandidates(modelId), canonicalId)).toBe(depth);
        }
    });
});
