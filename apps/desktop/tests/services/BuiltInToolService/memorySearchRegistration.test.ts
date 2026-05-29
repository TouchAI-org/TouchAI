import { beforeEach, describe, expect, it, vi } from 'vitest';

import { builtInToolRegistry, builtInToolService } from '@/services/BuiltInToolService';

vi.mock('@database/queries', () => ({
    findEnabledBuiltInTools: vi.fn(),
}));

const { findEnabledBuiltInTools } = await import('@database/queries');

const baseToolEntity = {
    id: 1,
    enabled: 1,
    risk_level: 'low' as const,
    config_json: null,
    last_used_at: null,
    created_at: '2026-05-22T00:00:00.000Z',
    updated_at: '2026-05-22T00:00:00.000Z',
};

describe('memory and conversation search registration', () => {
    beforeEach(() => {
        vi.mocked(findEnabledBuiltInTools).mockResolvedValue([
            {
                ...baseToolEntity,
                id: 1,
                tool_id: 'memory',
                display_name: 'Memory',
                description: '读取和维护记忆',
            },
            {
                ...baseToolEntity,
                id: 2,
                tool_id: 'search_conversation',
                display_name: 'SearchConversation',
                description: '搜索历史对话',
            },
        ]);
    });

    it('registers memory and search_conversation descriptors', () => {
        expect(builtInToolRegistry.get('memory')?.displayName).toBe('Memory');
        expect(builtInToolRegistry.get('search_conversation')?.displayName).toBe(
            'SearchConversation'
        );
    });

    it('exposes both tools with builtin names for models', async () => {
        const definitions = await builtInToolService.getEnabledToolDefinitions();

        expect(definitions.map((definition) => definition.name)).toEqual([
            'builtin__memory',
            'builtin__search_conversation',
        ]);
        expect(definitions[0]?.input_schema.properties).toHaveProperty('action');
        expect(definitions[1]?.input_schema.properties).toHaveProperty('keywords');
    });
});
