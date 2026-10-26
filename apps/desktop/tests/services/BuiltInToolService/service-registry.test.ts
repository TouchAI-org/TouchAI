import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The built-in tool service decides which tools the model is offered and which tool a model
 * tool name actually refers to. Getting either wrong either hides a tool the user enabled or
 * runs one they disabled.
 */
const {
    findBuiltInToolByToolIdMock,
    findEnabledBuiltInToolsMock,
    findAllBuiltInToolsMock,
    createBuiltInToolMock,
    registryGetMock,
    registryListMock,
} = vi.hoisted(() => ({
    findBuiltInToolByToolIdMock: vi.fn(),
    findEnabledBuiltInToolsMock: vi.fn(),
    findAllBuiltInToolsMock: vi.fn(),
    createBuiltInToolMock: vi.fn(),
    registryGetMock: vi.fn(),
    registryListMock: vi.fn(),
}));

vi.mock('@database/queries', () => ({
    createBuiltInTool: createBuiltInToolMock,
    createBuiltInToolLog: vi.fn(),
    findBuiltInToolByToolId: findBuiltInToolByToolIdMock,
    findEnabledBuiltInTools: findEnabledBuiltInToolsMock,
    findAllBuiltInTools: findAllBuiltInToolsMock,
    touchBuiltInToolLastUsed: vi.fn(),
    updateBuiltInToolLogByCallId: vi.fn(),
}));

vi.mock('@/services/BuiltInToolService/registry', () => ({
    builtInToolRegistry: {
        get: registryGetMock,
        list: registryListMock,
    },
}));

beforeEach(() => {
    vi.clearAllMocks();
});

async function loadService() {
    return (await import('@/services/BuiltInToolService/service')).builtInToolService;
}

function descriptor(overrides: Record<string, unknown> = {}) {
    return {
        id: 'bash',
        displayName: 'Bash',
        description: 'Run a command',
        inputSchema: { type: 'object' },
        defaultConfig: { approvalMode: 'high_risk' },
        parseConfig: (json: string | null) => (json ? JSON.parse(json) : {}),
        buildConversationSemantic: () => ({ kind: 'generic' }),
        ...overrides,
    };
}

describe('user enables a built-in tool', () => {
    it('user gets a definition for each enabled tool', async () => {
        findEnabledBuiltInToolsMock.mockResolvedValue([
            { tool_id: 'bash', config_json: null },
            { tool_id: 'web_fetch', config_json: null },
        ]);
        registryGetMock.mockImplementation((id: string) =>
            descriptor({ id, description: `desc-${id}` })
        );

        const service = await loadService();
        const definitions = await service.getEnabledToolDefinitions();

        expect(definitions.map((entry) => entry.name)).toEqual([
            'builtin__bash',
            'builtin__web_fetch',
        ]);
    });

    it('user gets no definition for a tool that is no longer registered', async () => {
        findEnabledBuiltInToolsMock.mockResolvedValue([{ tool_id: 'ghost', config_json: null }]);
        registryGetMock.mockReturnValue(undefined);

        const service = await loadService();
        const definitions = await service.getEnabledToolDefinitions();

        // A leftover database row for a removed tool must not reach the model.
        expect(definitions).toEqual([]);
    });

    it('user gets the other tools kept when one fails to build its definition', async () => {
        findEnabledBuiltInToolsMock.mockResolvedValue([
            { tool_id: 'broken', config_json: '{not json' },
            { tool_id: 'bash', config_json: null },
        ]);
        registryGetMock.mockImplementation((id: string) =>
            descriptor({
                id,
                parseConfig: (json: string | null) => {
                    if (json) throw new Error('bad config');
                    return {};
                },
            })
        );

        const service = await loadService();
        const definitions = await service.getEnabledToolDefinitions();

        // One broken tool must not hide every other tool from the model.
        expect(definitions.map((entry) => entry.name)).toEqual(['builtin__bash']);
    });

    it('user gets the definition built from the tool config when the tool provides one', async () => {
        findEnabledBuiltInToolsMock.mockResolvedValue([
            { tool_id: 'bash', config_json: '{"approvalMode":"never"}' },
        ]);
        registryGetMock.mockReturnValue(
            descriptor({
                buildToolDefinition: async (name: string, config: { approvalMode: string }) => ({
                    name,
                    description: `mode=${config.approvalMode}`,
                    input_schema: { type: 'object' },
                }),
            })
        );

        const service = await loadService();
        const definitions = await service.getEnabledToolDefinitions();

        // The dynamic definition has to see the user's saved config.
        expect(definitions[0]!.description).toBe('mode=never');
    });

    it('user gets an empty list when nothing is enabled', async () => {
        findEnabledBuiltInToolsMock.mockResolvedValue([]);

        const service = await loadService();

        await expect(service.getEnabledToolDefinitions()).resolves.toEqual([]);
    });
});

describe('user calls a built-in tool by name', () => {
    it('user gets the tool resolved when it is enabled', async () => {
        findBuiltInToolByToolIdMock.mockResolvedValue({
            tool_id: 'bash',
            enabled: 1,
            config_json: '{"approvalMode":"never"}',
        });
        registryGetMock.mockReturnValue(descriptor());

        const service = await loadService();
        const resolved = await service.resolveToolCall('builtin__bash');

        expect(resolved).toMatchObject({
            namespacedName: 'builtin__bash',
            config: { approvalMode: 'never' },
        });
    });

    it('user gets no resolution for a tool that is disabled', async () => {
        findBuiltInToolByToolIdMock.mockResolvedValue({
            tool_id: 'bash',
            enabled: 0,
            config_json: null,
        });

        const service = await loadService();

        // A disabled tool must not be callable even if the model asks for it.
        await expect(service.resolveToolCall('builtin__bash')).resolves.toBeNull();
    });

    it('user gets no resolution for a name without the built-in prefix', async () => {
        const service = await loadService();

        // An MCP tool name must not be treated as a built-in one.
        await expect(service.resolveToolCall('mcp__1__query')).resolves.toBeNull();
        expect(findBuiltInToolByToolIdMock).not.toHaveBeenCalled();
    });

    it('user gets no resolution for a tool missing from the database', async () => {
        findBuiltInToolByToolIdMock.mockResolvedValue(undefined);

        const service = await loadService();

        await expect(service.resolveToolCall('builtin__bash')).resolves.toBeNull();
    });

    it('user gets no resolution for a tool that is no longer registered', async () => {
        findBuiltInToolByToolIdMock.mockResolvedValue({
            tool_id: 'removed',
            enabled: 1,
            config_json: null,
        });
        registryGetMock.mockReturnValue(undefined);

        const service = await loadService();

        await expect(service.resolveToolCall('builtin__removed')).resolves.toBeNull();
    });
});

describe('user upgrades and the tool registry is synchronised', () => {
    it('user gets only the newly registered tools created', async () => {
        findAllBuiltInToolsMock.mockResolvedValue([{ tool_id: 'bash' }]);
        registryListMock.mockReturnValue([
            { id: 'bash', displayName: 'Bash', description: 'd', defaultConfig: {} },
            { id: 'web_fetch', displayName: 'Web', description: 'd', defaultConfig: {} },
        ]);
        createBuiltInToolMock.mockResolvedValue({ id: 2 });

        const service = await loadService();
        await service.syncRegisteredTools();

        // Re-creating an existing tool would reset the user's saved config.
        expect(createBuiltInToolMock).toHaveBeenCalledTimes(1);
        expect(createBuiltInToolMock).toHaveBeenCalledWith(
            expect.objectContaining({ tool_id: 'web_fetch' })
        );
    });

    it('user gets nothing created when every tool is already registered', async () => {
        findAllBuiltInToolsMock.mockResolvedValue([{ tool_id: 'bash' }]);
        registryListMock.mockReturnValue([
            { id: 'bash', displayName: 'Bash', description: 'd', defaultConfig: {} },
        ]);

        const service = await loadService();
        await service.syncRegisteredTools();

        expect(createBuiltInToolMock).not.toHaveBeenCalled();
    });

    it('user gets a new tool enabled by default so it appears in settings', async () => {
        findAllBuiltInToolsMock.mockResolvedValue([]);
        registryListMock.mockReturnValue([
            { id: 'bash', displayName: 'Bash', description: 'd', defaultConfig: { a: 1 } },
        ]);
        createBuiltInToolMock.mockResolvedValue({ id: 1 });

        const service = await loadService();
        await service.syncRegisteredTools();

        expect(createBuiltInToolMock).toHaveBeenCalledWith(
            expect.objectContaining({
                enabled: 1,
                config_json: JSON.stringify({ a: 1 }),
            })
        );
    });
});
