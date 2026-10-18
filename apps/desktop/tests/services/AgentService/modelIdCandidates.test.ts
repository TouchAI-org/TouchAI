// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import { expandModelIdCandidates } from '@services/AgentService/infrastructure/modelMetadata/modelIdCandidates';
import { describe, expect, it } from 'vitest';

function candidates(modelId: string): string[] {
    return expandModelIdCandidates(modelId).map((item) => item.candidate);
}

describe('expandModelIdCandidates', () => {
    it('keeps the original id first', () => {
        expect(candidates('claude-sonnet-4-5')[0]).toBe('claude-sonnet-4-5');
    });

    it('lowercases ASCII so matching is case-insensitive', () => {
        expect(candidates('Claude-Sonnet-4-5')).toContain('claude-sonnet-4-5');
    });

    it('strips a namespace prefix', () => {
        expect(candidates('deepseek/deepseek-v4-flash')).toContain('deepseek-v4-flash');
    });

    it('strips a route prefix', () => {
        expect(candidates('auto-deepseek-v4-flash')).toContain('deepseek-v4-flash');
    });

    it('strips date and named suffixes', () => {
        expect(candidates('claude-sonnet-4-5-20250929')).toContain('claude-sonnet-4-5');
        expect(candidates('gpt-5-latest')).toContain('gpt-5');
    });

    it('combines namespace and route prefixes seen on relay gateways', () => {
        // 中转把「分组/路由」叠在一起：group/auto-<上游 id>
        // 只剥 namespace 会剩下 auto-xxx，只剥 route 又对不上带 namespace 的写法
        expect(candidates('group/auto-deepseek-v4-1-flash')).toContain('deepseek-v4-1-flash');
    });

    it('reaches the upstream spelling behind a hyphenated version', () => {
        // 上游写 deepseek-v4.1-flash，中转写 deepseek-v4-1-flash；
        // 候选里必须出现中转写法，才能通过别名表映射到上游记录
        expect(candidates('group/auto-deepseek-v4-1-flash')).toContain('deepseek-v4-1-flash');
        expect(candidates('group/auto-deepseek-v4-1-flash')).toContain('auto-deepseek-v4-1-flash');
    });

    it('never returns duplicates', () => {
        const list = candidates('group/auto-deepseek-v4-1-flash');
        expect(new Set(list).size).toBe(list.length);
    });

    it('respects the depth limit', () => {
        const shallow = expandModelIdCandidates('group/auto-deepseek-v4-1-flash', 1);

        // 深度 1 只能拿到一层裁剪结果
        expect(shallow.every((item) => item.depth <= 1)).toBe(true);
        expect(shallow.map((item) => item.candidate)).not.toContain('deepseek-v4-1-flash');
    });
});
