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

    it('marks only the tools whose schema actually received the _meta parameter', async () => {
        getEnabledToolDefinitionsMock.mockResolvedValue([
            tool('builtin__bash', { adaptiveTimeoutCeilingMs: 120000 }),
            tool('builtin__read'),
        ]);

        const { resolveToolDefinitions } = await import('@/services/AgentService/catalog/tools');
        const definitions = await resolveToolDefinitions(model);
        const byName = Object.fromEntries((definitions ?? []).map((item) => [item.name, item]));

        // The capability flag is what the executor gates `_meta` stripping on,
        // so it must be present exactly when `_meta` was injected.
        expect(byName['builtin__bash']?.adaptiveTimeoutCeilingMs).toBe(120000);
        expect(byName['builtin__read']).not.toHaveProperty('adaptiveTimeoutCeilingMs');
    });

    it('keeps the ceiling out of the provider-facing input schema', async () => {
        getEnabledToolDefinitionsMock.mockResolvedValue([
            tool('builtin__bash', { adaptiveTimeoutCeilingMs: 120000 }),
        ]);

        const { resolveToolDefinitions } = await import('@/services/AgentService/catalog/tools');
        const definitions = await resolveToolDefinitions(model);

        for (const definition of definitions ?? []) {
            expect(definition.input_schema).not.toHaveProperty('adaptiveTimeoutCeilingMs');
            expect(definition.input_schema.properties).not.toHaveProperty(
                'adaptiveTimeoutCeilingMs'
            );
        }
    });

    it('skips adaptive timeout when the tool already declares a _meta property', async () => {
        getEnabledMcpToolsMock.mockResolvedValue([
            {
                name: 'mcp__1__custom',
                description: 'custom',
                input_schema: {
                    type: 'object' as const,
                    properties: { _meta: { type: 'object' } },
                },
                adaptiveTimeoutCeilingMs: TOOL_TIMEOUT_MAX_MS,
            },
        ]);

        const { resolveToolDefinitions } = await import('@/services/AgentService/catalog/tools');
        const definitions = await resolveToolDefinitions(model);
        const custom = definitions?.find((item) => item.name === 'mcp__1__custom');

        // The server's own `_meta` schema is preserved verbatim and the tool is
        // not marked as supporting adaptive timeout.
        expect(custom?.input_schema.properties._meta).toEqual({ type: 'object' });
        expect(custom).not.toHaveProperty('adaptiveTimeoutCeilingMs');
    });

    it('skips adaptive timeout when _meta is a required tool argument', async () => {
        getEnabledMcpToolsMock.mockResolvedValue([
            {
                name: 'mcp__1__required-meta',
                description: 'required meta',
                input_schema: {
                    type: 'object' as const,
                    properties: { arg: { type: 'string' } },
                    required: ['_meta'],
                },
                adaptiveTimeoutCeilingMs: TOOL_TIMEOUT_MAX_MS,
            },
        ]);

        const { resolveToolDefinitions } = await import('@/services/AgentService/catalog/tools');
        const definitions = await resolveToolDefinitions(model);
        const definition = definitions?.find((item) => item.name === 'mcp__1__required-meta');

        expect(definition?.input_schema.properties).not.toHaveProperty('_meta');
        expect(definition?.input_schema.required).toEqual(['_meta']);
        expect(definition).not.toHaveProperty('adaptiveTimeoutCeilingMs');
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
