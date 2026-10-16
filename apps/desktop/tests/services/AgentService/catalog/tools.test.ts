import type { ModelWithProvider } from '@database/queries/models';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TOOL_TIMEOUT_MAX_MS, TOOL_TIMEOUT_MIN_MS } from '@/utils/timeouts';

const { getEnabledMcpToolsMock, getEnabledToolDefinitionsMock } = vi.hoisted(() => ({
    getEnabledMcpToolsMock: vi.fn(),
    getEnabledToolDefinitionsMock: vi.fn(),
}));

vi.mock('@/services/BuiltInToolService', () => ({
    builtInToolService: { getEnabledToolDefinitions: getEnabledToolDefinitionsMock },
}));

vi.mock('@/services/AgentService/infrastructure/mcp', () => ({
    mcpManager: { getEnabledToolDefinitions: getEnabledMcpToolsMock },
}));

const model = { tool_call: 1 } as ModelWithProvider;

function tool(name: string, extra: Record<string, unknown> = {}) {
    return {
        name,
        description: `${name} description`,
        input_schema: { type: 'object' as const, properties: { arg: { type: 'string' } } },
        ...extra,
    };
}

describe('resolveToolDefinitions adaptive timeout schema', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getEnabledMcpToolsMock.mockResolvedValue([]);
        getEnabledToolDefinitionsMock.mockResolvedValue([]);
    });

    it('returns undefined for models that do not support tool calls', async () => {
        const { resolveToolDefinitions } = await import('@/services/AgentService/catalog/tools');

        await expect(
            resolveToolDefinitions({ tool_call: 0 } as ModelWithProvider)
        ).resolves.toBeUndefined();
    });

    it('injects _meta only for tools that declare an adaptive timeout ceiling', async () => {
        getEnabledToolDefinitionsMock.mockResolvedValue([
            tool('builtin__bash', { adaptiveTimeoutCeilingMs: 120000 }),
            tool('builtin__read'),
        ]);

        const { resolveToolDefinitions } = await import('@/services/AgentService/catalog/tools');
        const definitions = await resolveToolDefinitions(model);
        const byName = Object.fromEntries((definitions ?? []).map((item) => [item.name, item]));

        expect(byName['builtin__bash']?.input_schema.properties).toHaveProperty('_meta');
        expect(byName['builtin__read']?.input_schema.properties).not.toHaveProperty('_meta');
    });

    it('never leaks the internal ceiling field into the provider payload', async () => {
        getEnabledToolDefinitionsMock.mockResolvedValue([
            tool('builtin__bash', { adaptiveTimeoutCeilingMs: 120000 }),
            tool('builtin__read'),
        ]);

        const { resolveToolDefinitions } = await import('@/services/AgentService/catalog/tools');
        const definitions = await resolveToolDefinitions(model);

        for (const definition of definitions ?? []) {
            expect(definition).not.toHaveProperty('adaptiveTimeoutCeilingMs');
        }
    });

    it('exposes each tool-specific ceiling instead of a shared upper bound', async () => {
        getEnabledMcpToolsMock.mockResolvedValue([
            tool('mcp__1__search', { adaptiveTimeoutCeilingMs: TOOL_TIMEOUT_MAX_MS }),
        ]);
        getEnabledToolDefinitionsMock.mockResolvedValue([
            tool('builtin__bash', { adaptiveTimeoutCeilingMs: 120000 }),
        ]);

        const { resolveToolDefinitions } = await import('@/services/AgentService/catalog/tools');
        const definitions = await resolveToolDefinitions(model);
        const byName = Object.fromEntries((definitions ?? []).map((item) => [item.name, item]));

        function timeoutBounds(name: string) {
            const meta = byName[name]?.input_schema.properties._meta as {
                properties: { timeoutMs: { minimum: number; maximum: number } };
            };
            return meta.properties.timeoutMs;
        }

        // Bash is capped by the Rust executor hard limit.
        expect(timeoutBounds('builtin__bash')).toMatchObject({
            minimum: TOOL_TIMEOUT_MIN_MS,
            maximum: 120000,
        });
        // MCP honors the full shared range.
        expect(timeoutBounds('mcp__1__search')).toMatchObject({
            minimum: TOOL_TIMEOUT_MIN_MS,
            maximum: TOOL_TIMEOUT_MAX_MS,
        });
    });

    it('drops excluded tool names before augmenting schemas', async () => {
        getEnabledToolDefinitionsMock.mockResolvedValue([
            tool('builtin__bash', { adaptiveTimeoutCeilingMs: 120000 }),
            tool('builtin__read'),
        ]);

        const { resolveToolDefinitions } = await import('@/services/AgentService/catalog/tools');
        const definitions = await resolveToolDefinitions(model, {
            excludedToolNames: ['builtin__read'],
        });

        expect((definitions ?? []).map((item) => item.name)).toEqual(['builtin__bash']);
    });
});
