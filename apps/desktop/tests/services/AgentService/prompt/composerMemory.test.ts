import { describe, expect, it, vi } from 'vitest';

import { composePromptSnapshot } from '@/services/AgentService/prompt/composer';

describe('composePromptSnapshot memory fragments', () => {
    it('places session memory fragments in the prompt snapshot', async () => {
        vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000000');

        const snapshot = await composePromptSnapshot({
            prompt: '继续昨天的桌面任务',
            sessionMemory: ['# 记忆目录\n- id: 1\n  title: 桌面工作流'],
        });

        expect(snapshot.fragments.some((fragment) => fragment.source === 'session_memory')).toBe(
            true
        );
        expect(snapshot.systemPrompt).toContain('记忆目录');
    });
});
