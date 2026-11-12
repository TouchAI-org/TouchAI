import type { BaseBuiltInToolExecutionContext } from '@services/BuiltInToolService/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const settings = {
    allowForeground: false,
    allowedApps: [] as string[],
    approval: 'each' as 'each' | 'session-window' | 'full-access',
    cursorVisible: true,
    enabled: true,
    maxImageDimension: 1568,
    recordingEnabled: false,
    telemetryEnabled: false,
};

const allowed = new Set<string>();
const allowForSession = vi.fn((key: string) => allowed.add(key));
const execute = vi.fn();
const cancel = vi.fn();
const pulseGlow = vi.fn(async () => undefined);
const startActivity = vi.fn(async () => undefined);
const enabled = vi.fn(async () => true);
const groups = vi.fn(async (): Promise<Record<string, boolean>> => ({}));
let selectedDriver = 'cua-driver';
const agentCatalog = [
    'desktop_snapshot',
    'desktop_click',
    'desktop_batch',
    'desktop_clipboard_get',
].map((name) => ({
    name,
    description: name,
    inputSchema: { type: 'object' },
}));
const catalog = [
    {
        name: 'browser_prepare',
        description: 'Prepare an existing browser',
        inputSchema: { type: 'object' },
    },
    {
        name: 'launch_app',
        description: 'Launch an application',
        inputSchema: { type: 'object' },
    },
    {
        name: 'browser_dialog',
        description: 'Inspect or answer a browser dialog',
        inputSchema: { type: 'object' },
    },
    {
        name: 'press_key',
        description: 'Send a key',
        inputSchema: { type: 'object', properties: { delivery_mode: { type: 'string' } } },
    },
    {
        name: 'get_browser_state',
        description: 'Read attached browser state',
        inputSchema: { type: 'object' },
        annotations: { readOnlyHint: true },
    },
    {
        name: 'browser_navigate',
        description: 'Navigate an attached browser tab',
        inputSchema: {
            type: 'object',
            required: ['target_id', 'tab_id', 'url'],
            properties: {
                target_id: { type: 'string' },
                tab_id: { type: 'string' },
                url: { type: 'string' },
            },
        },
    },
    {
        name: 'kill_app',
        description: 'Terminate a process',
        inputSchema: { type: 'object', properties: { pid: { type: 'number' } } },
    },
    { name: 'run_steps', description: 'Sequential actions', inputSchema: { type: 'object' } },
    { name: 'run_script', description: 'Sandbox script', inputSchema: { type: 'object' } },
    { name: 'clipboard_write', description: 'Write clipboard', inputSchema: { type: 'object' } },
    { name: 'hotkey', description: 'Shortcut', inputSchema: { type: 'object' } },
    {
        name: 'get_window_state',
        description: 'Observe',
        inputSchema: { type: 'object' },
        annotations: { readOnlyHint: true },
    },
];
const persistImage = vi.hoisted(() =>
    vi.fn(async () => ({
        id: 'image-1',
        type: 'image',
        path: '/cache/screenshot.png',
        originPath: 'computer-use://capture',
        name: 'screenshot.png',
    }))
);

vi.mock('@/services/AgentService/infrastructure/attachments/storage', () => ({
    createPersistedAttachmentFromData: persistImage,
}));

vi.mock('@services/ComputerUseService', () => ({
    computerUseService: {
        allowForSession: (key: string) => allowForSession(key),
        execute: (...args: unknown[]) => execute(...args),
        isAllowedForSession: (key: string) => allowed.has(key),
        loadSettings: async () => settings,
        isEnabled: () => enabled(),
        loadGroups: () => groups(),
        listTools: async () => (selectedDriver === 'agent-desktop' ? agentCatalog : catalog),
        loadDriver: async () => selectedDriver,
        pulseGlow,
        startActivity,
    },
    targetKey: (pid?: unknown, windowId?: unknown) =>
        `${String(pid ?? '-')}:${String(windowId ?? '-')}`,
}));

const { ComputerUseTool } = await import('@services/BuiltInToolService/tools/computerUse/index');

const tool = new ComputerUseTool();

function context(signal?: AbortSignal): BaseBuiltInToolExecutionContext {
    return {
        callId: 'call-1',
        hasExecutedBuiltInTool: () => false,
        iteration: 1,
        signal,
    } as BaseBuiltInToolExecutionContext;
}

function driverResult(structured: Record<string, unknown> = {}) {
    return {
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
        structuredContent: structured,
    };
}

beforeEach(() => {
    selectedDriver = 'cua-driver';
    allowed.clear();
    allowForSession.mockClear();
    execute.mockReset();
    cancel.mockReset();
    pulseGlow.mockReset();
    startActivity.mockReset();
    persistImage.mockClear();
    settings.approval = 'each';
    settings.allowForeground = false;
    settings.cursorVisible = true;
    settings.allowedApps = [];
    enabled.mockResolvedValue(true);
    groups.mockResolvedValue({});
    execute.mockReturnValue({
        cancel,
        executionId: 'exec-1',
        result: Promise.resolve(driverResult({ effect: 'confirmed', route: 'accessibility' })),
    });
});

describe('computer use tool', () => {
    it('user given no stored tool configuration when loading it then uses the foreground-enabled default', () => {
        expect(tool.defaultConfig).toEqual({ allowForeground: true });
        expect(tool.parseConfig(null)).toEqual({ allowForeground: true });
        expect(tool.parseConfig('{}')).toEqual({ allowForeground: true });
        expect(tool.parseConfig('{"allowForeground":false}')).toEqual({ allowForeground: false });
    });

    it('user given foreground control is off when attaching an existing browser then the driver may attach without launching', async () => {
        const result = await tool.execute(
            {
                action: 'browser_prepare',
                arguments: { pid: 123, window_id: 456, strategy: { kind: 'existing_profile' } },
            },
            tool.defaultConfig,
            context()
        );
        expect(result.isError).toBe(false);
        expect(execute).toHaveBeenCalledWith('browser_prepare', {
            pid: 123,
            window_id: 456,
            strategy: { kind: 'existing_profile' },
            allow_launch: false,
        });
    });

    it.each([{ allow_launch: true }, { delivery_mode: 'foreground' }])(
        'user given foreground control is off when explicitly requesting browser foreground work %j then remains refused',
        async (request) => {
            const result = await tool.execute(
                {
                    action: 'browser_prepare',
                    arguments: { ...request, strategy: { kind: 'existing_profile' } },
                },
                tool.defaultConfig,
                context()
            );
            expect(result.result).toBe('foreground_not_allowed');
            expect(execute).not.toHaveBeenCalled();
        }
    );

    it('user given foreground control is off when preparing model tools then receives the current restriction and no-launch option', async () => {
        const definition = await tool.buildToolDefinition('computer_use', tool.defaultConfig);
        expect(definition.description).toContain('Foreground access is disabled');
        expect(definition.description).toContain('allow_launch:false');
    });

    it('user given an app name when using the native launch action then reaches the driver with the correct field', async () => {
        const result = await tool.execute(
            { action: 'launch_app', arguments: { app: 'Notepad', start_minimized: true } },
            tool.defaultConfig,
            context()
        );
        expect(result.isError).toBe(false);
        expect(execute).toHaveBeenCalledWith('launch_app', {
            name: 'Notepad',
            start_minimized: true,
        });
    });

    it('user given conflicting app names when launching then sees the conflict before any app is opened', async () => {
        const result = await tool.execute(
            { action: 'launch_app', arguments: { app: 'Notepad', name: 'Calculator' } },
            tool.defaultConfig,
            context()
        );
        expect(result.result).toContain('conflicting_argument:name');
        expect(execute).not.toHaveBeenCalled();
    });

    it('user given a partially failed native batch when it returns then sees failure and keeps completed results', async () => {
        selectedDriver = 'agent-desktop';
        settings.approval = 'full-access';
        settings.allowForeground = true;
        execute.mockReturnValue({
            cancel,
            executionId: 'partial-batch',
            result: Promise.resolve(
                driverResult({
                    ok: true,
                    data: {
                        results: [
                            { ok: true, data: { action: 'click' } },
                            { ok: false, error: { code: 'STALE_REF' } },
                        ],
                        not_started_entries: 1,
                    },
                })
            ),
        });
        const result = await tool.execute(
            {
                action: 'desktop_batch',
                arguments: { commands_json: '[{"command":"wait","args":{"ms":1}}]' },
            },
            { allowForeground: true },
            context()
        );
        expect(result.isError).toBe(true);
        expect(result.result).toContain('STALE_REF');
    });
    it('user given agent desktop when preparing the model then gets its schemas without incompatible driver instructions', async () => {
        selectedDriver = 'agent-desktop';
        const definition = await tool.buildToolDefinition('computer_use', {
            allowForeground: true,
        });
        expect(definition.description).toContain('agent-desktop');
        expect(definition.description).not.toContain('browser_prepare');
        expect(JSON.stringify(definition.input_schema)).not.toContain('element_token');
    });

    it('user given a disabled clipboard group when an agent desktop batch reads it then is refused before execution', async () => {
        selectedDriver = 'agent-desktop';
        settings.approval = 'full-access';
        settings.allowForeground = true;
        groups.mockResolvedValue({ clipboard: false });
        const result = await tool.execute(
            {
                action: 'desktop_batch',
                arguments: {
                    commands_json: JSON.stringify([{ command: 'clipboard-get', args: {} }]),
                },
            },
            { allowForeground: true },
            context()
        );
        expect(result.isError).toBe(true);
        expect(result.result).toContain('clipboard');
        expect(execute).not.toHaveBeenCalled();
    });

    it('user given a native element reference when clicking then keeps the driver argument unchanged', async () => {
        selectedDriver = 'agent-desktop';
        settings.approval = 'full-access';
        settings.allowForeground = true;
        const result = await tool.execute(
            { action: 'desktop_click', arguments: { ref_id: '@s123:e2' } },
            { allowForeground: true },
            context()
        );
        expect(result.isError).toBe(false);
        expect(execute).toHaveBeenCalledWith('desktop_click', { ref_id: '@s123:e2' });
    });
    it('user given a direct native operation with its own nested action when executing then preserves both action meanings', async () => {
        execute.mockImplementation((driver: string, args: Record<string, unknown>) => ({
            cancel,
            executionId: 'dialog',
            result: Promise.resolve({
                content: [{ type: 'text', text: JSON.stringify({ driver, args }) }],
            }),
        }));
        const input = {
            action: 'browser_dialog',
            arguments: { action: 'inspect', target_id: 'target', tab_id: 'tab' },
        };
        const approval = await tool.buildApprovalRequest(input, tool.defaultConfig);
        expect(approval?.command).toContain('browser_dialog');
        expect(approval?.command).toContain('inspect');
        const result = await tool.execute(input, tool.defaultConfig, context());
        expect(result.isError).toBe(false);
        expect(JSON.parse(result.result)).toEqual({
            driver: 'browser_dialog',
            args: input.arguments,
        });
    });

    it.each([
        { action: 'observe', pid: 12, window_id: 34, tree_format: 'elements' },
        {
            action: 'call',
            tool: 'get_window_state',
            arguments: { pid: 12, window_id: 34, tree_format: 'elements' },
        },
    ])(
        'user given an elements-only observation %j when reading then receives the requested labels and tokens',
        async (input) => {
            execute.mockReturnValueOnce({
                cancel,
                executionId: 'elements',
                result: Promise.resolve({
                    content: [{ type: 'text', text: 'tree is in structuredContent.elements' }],
                    structuredContent: {
                        snapshot_id: 's1',
                        elements: [{ name: 'Design author', element_token: 's1:2', role: 'link' }],
                    },
                }),
            });
            const result = await tool.execute(input, tool.defaultConfig, context());
            expect(result.isError).toBe(false);
            expect(result.result).toContain('Design author');
            expect(result.result).toContain('s1:2');
            expect(result.result.match(/Design author/g)).toHaveLength(1);
        }
    );

    it('user given an explicit background native key when executing in full access then keeps background delivery', async () => {
        settings.approval = 'full-access';
        settings.allowForeground = true;
        execute.mockImplementation((driver: string, args: Record<string, unknown>) => ({
            cancel,
            executionId: 'background',
            result: Promise.resolve({
                content: [{ type: 'text', text: JSON.stringify({ driver, args }) }],
            }),
        }));
        const result = await tool.execute(
            { action: 'press_key', key: 'Escape', foreground: false },
            tool.defaultConfig,
            context()
        );
        expect(result.isError).toBe(false);
        expect(JSON.parse(result.result).args).toEqual({
            key: 'Escape',
            delivery_mode: 'background',
        });
    });

    it.each([
        {
            action: 'call',
            tool: 'press_key',
            arguments: { foreground: false, delivery_mode: 'foreground' },
        },
        { action: 'run_steps', pid: 12, arguments: { pid: 99, steps: [] } },
    ])(
        'user given conflicting native fields %j when executing then gets refused before input',
        async (input) => {
            settings.allowForeground = true;
            const result = await tool.execute(input, tool.defaultConfig, context());
            expect(result.isError).toBe(true);
            expect(result.errorMessage).toContain('conflicting_argument:');
            expect(execute).not.toHaveBeenCalled();
        }
    );

    it('user given per-action approval when using a direct native action then sees the actual operation for review', async () => {
        const approval = await tool.buildApprovalRequest(
            { action: 'kill_app', pid: 42 },
            tool.defaultConfig
        );
        expect(approval?.command).toContain('kill_app');
        expect(approval?.command).toContain('42');
    });

    it('user given disabled input tools when using a direct native action then cannot bypass that permission', async () => {
        groups.mockResolvedValue({ input: false });
        const result = await tool.execute(
            { action: 'press_key', key: 'Escape' },
            tool.defaultConfig,
            context()
        );
        expect(result.errorMessage).toBe('tool_group_disabled:input');
        expect(execute).not.toHaveBeenCalled();
        const definition = await tool.buildToolDefinition('computer_use', tool.defaultConfig);
        expect(definition.input_schema.properties.action).toMatchObject({
            enum: expect.not.arrayContaining(['press_key']),
        });
        expect(definition.input_schema.properties.action).toMatchObject({
            enum: expect.arrayContaining(['kill_app']),
        });
    });

    it('user given a long semantic page when reading then keeps actionable controls and continuation before supplementary content', async () => {
        execute.mockReturnValueOnce({
            cancel,
            executionId: 'semantic',
            result: Promise.resolve({
                content: [{ type: 'text', text: 'semantic snapshot' }],
                structuredContent: {
                    content_refs: [{ name: 'large content '.repeat(3000) }],
                    outline: 'outline '.repeat(1000),
                    page: { title: 'Design search' },
                    snapshot: { format: 'semantic_v2', complete: false, continuation: 'next-page' },
                    refs: [{ ref: 'p1:4', name: 'Search', role: 'textbox' }],
                    target_id: 'target',
                    tab_id: 'tab',
                },
            }),
        });
        const result = await tool.execute(
            {
                action: 'call',
                tool: 'get_browser_state',
                arguments: { target_id: 'target', tab_id: 'tab' },
            },
            tool.defaultConfig,
            context()
        );
        expect(result.result).toContain('p1:4');
        expect(result.result).toContain('next-page');
        expect(result.result.indexOf('p1:4')).toBeLessThan(result.result.indexOf('large content'));
        expect(result.result.length).toBeLessThan(33000);
    });

    it('user given an explicitly requested legacy browser format when reading then keeps that format', async () => {
        execute.mockImplementation((driver: string, args: Record<string, unknown>) => ({
            cancel,
            executionId: 'legacy',
            result: Promise.resolve({
                content: [{ type: 'text', text: JSON.stringify({ driver, args }) }],
            }),
        }));
        const result = await tool.execute(
            {
                action: 'call',
                tool: 'get_browser_state',
                arguments: { target_id: 'target', tab_id: 'tab', snapshot_format: 'dom_refs_v1' },
            },
            tool.defaultConfig,
            context()
        );
        expect(JSON.parse(result.result).args.snapshot_format).toBe('dom_refs_v1');
    });

    it.each([
        { action: 'press_key', pid: 12, window_id: 34, key: 'Escape', foreground: true },
        {
            action: 'call',
            tool: 'press_key',
            arguments: { pid: 12, window_id: 34, key: 'Escape', foreground: true },
        },
    ])(
        'user given native key input %j when executing then receives supported foreground delivery',
        async (input) => {
            settings.approval = 'full-access';
            settings.allowForeground = true;
            execute.mockImplementation((driver: string, args: Record<string, unknown>) => ({
                cancel,
                executionId: 'native-key',
                result: Promise.resolve({
                    content: [{ type: 'text', text: JSON.stringify({ driver, args }) }],
                }),
            }));
            const result = await tool.execute(input, tool.defaultConfig, context());
            expect(result.isError).toBe(false);
            const delivered = JSON.parse(result.result);
            expect(delivered).toMatchObject({
                driver: 'press_key',
                args: { pid: 12, window_id: 34, key: 'Escape', delivery_mode: 'foreground' },
            });
            expect(delivered.args).not.toHaveProperty('foreground');
        }
    );

    it('user given disabled foreground control when using a native key action then is refused before input', async () => {
        const result = await tool.execute(
            { action: 'press_key', pid: 12, window_id: 34, key: 'Escape', foreground: true },
            tool.defaultConfig,
            context()
        );
        expect(result.errorMessage).toBe('foreground_not_allowed');
        expect(execute).not.toHaveBeenCalled();
    });
    it('user given batch fields at the top level when executing then gets the same ordered input as nested arguments', async () => {
        settings.approval = 'full-access';
        settings.allowForeground = true;
        execute.mockImplementation((driver: string, args: Record<string, unknown>) => ({
            cancel,
            executionId: 'batch',
            result: Promise.resolve({
                content: [{ type: 'text', text: JSON.stringify({ driver, args }) }],
            }),
        }));
        const result = await tool.execute(
            {
                action: 'run_steps',
                pid: 12,
                window_id: 34,
                delivery_mode: 'foreground',
                steps: [{ tool: 'press_key', args: { key: 'Enter' } }],
                observe: {},
            },
            tool.defaultConfig,
            context()
        );
        expect(result.isError).toBe(false);
        expect(JSON.parse(result.result)).toMatchObject({
            driver: 'run_steps',
            args: {
                pid: 12,
                window_id: 34,
                steps: [{ tool: 'press_key', args: { key: 'Enter' } }],
                observe: {},
            },
        });
    });

    it('user given a browser snapshot without a requested legacy format when reading then receives visible semantic content first', async () => {
        execute.mockImplementation((driver: string, args: Record<string, unknown>) => ({
            cancel,
            executionId: 'snapshot',
            result: Promise.resolve({
                content: [{ type: 'text', text: JSON.stringify({ driver, args }) }],
            }),
        }));
        const result = await tool.execute(
            {
                action: 'call',
                tool: 'get_browser_state',
                arguments: { target_id: 'target', tab_id: 'tab' },
            },
            tool.defaultConfig,
            context()
        );
        expect(JSON.parse(result.result)).toMatchObject({
            args: { snapshot_format: 'semantic_v2' },
        });
    });
    it('user given an exactly bound browser when receiving its state then gets a ready next read that preserves the session', async () => {
        execute.mockReturnValueOnce({
            cancel,
            executionId: 'browser',
            result: Promise.resolve(
                driverResult({
                    mode: 'bind',
                    binding_quality: 'exact',
                    target_id: 'target-1',
                    tabs: [{ active: true, tab_id: 'tab-2' }],
                })
            ),
        });
        const result = await tool.execute(
            {
                action: 'call',
                tool: 'get_browser_state',
                arguments: { pid: 12, window_id: 34, session: 'fixture' },
            },
            tool.defaultConfig,
            context()
        );
        expect(result.result).toContain('Next browser read:');
        expect(result.result).toContain(
            '"arguments":{"target_id":"target-1","tab_id":"tab-2","session":"fixture"}'
        );
    });
    it('user given a native window observation when reading it then receives one tree and actionable capture metadata', async () => {
        execute.mockReturnValueOnce({
            cancel,
            executionId: 'observe',
            result: Promise.resolve({
                content: [{ type: 'text', text: 'Window: fixture editor' }],
                structuredContent: {
                    tree_markdown: 'Window: fixture editor',
                    elements: [{ name: 'fixture editor' }],
                    capture_id: 'c1',
                    snapshot_id: 's1',
                },
            }),
        });
        const result = await tool.execute(
            { action: 'call', tool: 'get_window_state', arguments: { pid: 12, window_id: 34 } },
            tool.defaultConfig,
            context()
        );
        expect(result.result.match(/fixture editor/g)).toHaveLength(1);
        expect(result.result).toContain('"snapshot_id":"s1"');
    });
    it.each([
        [
            { action: 'observe', arguments: { pid: 12, window_id: 34 } },
            'get_window_state',
            { pid: 12, window_id: 34 },
        ],
        [
            { action: 'list_windows', arguments: { on_screen_only: false } },
            'list_windows',
            { on_screen_only: false },
        ],
        [
            { action: 'launch', arguments: { path: 'C:/fixture.exe', start_minimized: true } },
            'launch_app',
            { path: 'C:/fixture.exe', start_minimized: true },
        ],
        [
            {
                action: 'set_window_frame',
                pid: 12,
                arguments: { pid: 12, window_id: 34, width: 900 },
            },
            'set_window_frame',
            { pid: 12, window_id: 34, width: 900 },
        ],
        [
            { action: 'call', arguments: { tool: 'kill_app', arguments: { pid: 12 } } },
            'kill_app',
            { pid: 12 },
        ],
    ] as const)(
        'user given nested request %j when executing then retains its intended target',
        async (input, name, expected) => {
            execute.mockImplementation((driver: string, args: Record<string, unknown>) => ({
                cancel,
                executionId: 'nested',
                result: Promise.resolve({
                    content: [{ type: 'text', text: JSON.stringify({ driver, args }) }],
                }),
            }));
            const result = await tool.execute(input, tool.defaultConfig, context());
            expect(result.isError).toBe(false);
            expect(JSON.parse(result.result)).toMatchObject({ driver: name, args: expected });
        }
    );

    it('user given nested targets when approving then sees the actual target and conflicting targets cannot execute', async () => {
        const approval = await tool.buildApprovalRequest(
            { action: 'click', arguments: { pid: 12, window_id: 34, element_token: 's1:2' } },
            tool.defaultConfig
        );
        expect(approval?.command).toContain('pid 12');
        const result = await tool.execute(
            { action: 'click', pid: 56, arguments: { pid: 12, window_id: 34 } },
            tool.defaultConfig,
            context()
        );
        expect(result.isError).toBe(true);
        expect(result.result).toContain('conflicting_argument:pid');
        expect(execute).not.toHaveBeenCalled();
    });

    it('user given nested launch arguments when the application is outside the allowed scope then gets refused', async () => {
        settings.allowedApps = ['allowed.exe'];
        const result = await tool.execute(
            { action: 'launch', arguments: { path: 'C:/blocked.exe' } },
            tool.defaultConfig,
            context()
        );
        expect(result.errorMessage).toBe('app_not_allowed');
    });

    it('user given a browser refusal when reading the result then sees an error and every required field together', async () => {
        execute.mockReturnValueOnce({
            cancel,
            executionId: 'refused',
            result: Promise.resolve({
                content: [{ type: 'text', text: 'refused' }],
                structuredContent: {
                    status: 'refused',
                    refusal: { code: 'browser_consent_required' },
                },
            }),
        });
        const result = await tool.execute(
            { action: 'call', tool: 'browser_navigate', arguments: { url: 'https://example.com' } },
            tool.defaultConfig,
            context()
        );
        expect(result.isError).toBe(true);
        expect(result.result).toContain('target_id');
        expect(result.result).toContain('tab_id');
    });
    it('user given a native shortcut when executing then receives the same working key delivery as the shortcut alias', async () => {
        settings.allowForeground = true;
        await tool.execute(
            {
                action: 'call',
                tool: 'hotkey',
                arguments: { pid: 12, window_id: 34, keys: ['ctrl', 's'] },
            },
            tool.defaultConfig,
            context()
        );
        expect(execute).toHaveBeenCalledWith('press_key', {
            pid: 12,
            window_id: 34,
            key: 's',
            modifiers: ['ctrl'],
            delivery_mode: 'foreground',
        });
    });

    it('user given a batch with Unicode and shortcuts when executing then gets intact foreground input in both step formats', async () => {
        settings.allowForeground = true;
        await tool.execute(
            {
                action: 'run_steps',
                arguments: {
                    steps: [
                        { hotkey: { keys: ['ctrl', 'a'] } },
                        {
                            tool: 'type_text',
                            args: { text: '中文 😀 𠮷', delivery_mode: 'background' },
                        },
                    ],
                },
            },
            tool.defaultConfig,
            context()
        );
        expect(execute).toHaveBeenCalledWith(
            'run_steps',
            expect.objectContaining({
                steps: [
                    { press_key: { key: 'a', modifiers: ['ctrl'], delivery_mode: 'foreground' } },
                    {
                        tool: 'type_text',
                        args: { text: '中文 😀 𠮷', delivery_mode: 'foreground' },
                    },
                ],
            })
        );
    });

    it('user given a text only model when observing through the native interface then receives accessibility without unused pixels', async () => {
        await tool.execute(
            {
                action: 'call',
                tool: 'get_window_state',
                arguments: { pid: 12, window_id: 34, include_screenshot: true },
            },
            tool.defaultConfig,
            context()
        );
        expect(execute).toHaveBeenCalledWith(
            'get_window_state',
            expect.objectContaining({ include_screenshot: false, include_accessibility_tree: true })
        );
    });

    it('user given disabled window tools when observing without a target then cannot list windows indirectly', async () => {
        groups.mockResolvedValue({ windows: false });
        const result = await tool.execute({ action: 'observe' }, tool.defaultConfig, context());
        expect(result.errorMessage).toBe('tool_group_disabled:windows');
        expect(execute).not.toHaveBeenCalled();
    });

    it('user given disabled foreground access when batching a nested shortcut then gets refused before input', async () => {
        const result = await tool.execute(
            { action: 'run_steps', arguments: { steps: [{ hotkey: { keys: ['ctrl', 's'] } }] } },
            tool.defaultConfig,
            context()
        );
        expect(result.errorMessage).toBe('foreground_not_allowed');
        expect(execute).not.toHaveBeenCalled();
    });

    it('user given a stale call when cancelling before settings load then performs no desktop action', async () => {
        const controller = new AbortController();
        controller.abort();
        const result = await tool.execute(
            { action: 'click' },
            tool.defaultConfig,
            context(controller.signal)
        );
        expect(result.status).toBe('timeout');
        expect(execute).not.toHaveBeenCalled();
    });
    it('user given a disabled master switch when executing an old call then receives a refusal', async () => {
        enabled.mockResolvedValue(false);
        const result = await tool.execute(
            { action: 'list_windows' },
            tool.defaultConfig,
            context()
        );
        expect(result.errorMessage).toBe('computer_use_disabled');
        expect(execute).not.toHaveBeenCalled();
    });

    it('user given an installed driver when describing a tool then receives its full native schema', async () => {
        const result = await tool.execute(
            { action: 'describe_tool', tool: 'kill_app' },
            tool.defaultConfig,
            context()
        );
        expect(JSON.parse(result.result)).toMatchObject(
            catalog.find((entry) => entry.name === 'kill_app')!
        );
        expect(execute).not.toHaveBeenCalled();
    });

    it('user given full access when invoking a native tool then preserves all native arguments', async () => {
        settings.approval = 'full-access';
        settings.allowForeground = true;
        const result = await tool.execute(
            { action: 'call', tool: 'kill_app', arguments: { pid: 42, session: 'task' } },
            tool.defaultConfig,
            context()
        );
        expect(execute).toHaveBeenCalledWith('kill_app', { pid: 42, session: 'task' });
        expect(result.isError).toBe(false);
    });

    it('user given disabled clipboard tools when invoking an alias or native tool then both are refused', async () => {
        groups.mockResolvedValue({ clipboard: false });
        for (const args of [
            { action: 'clipboard_write', text: 'secret' },
            { action: 'call', tool: 'clipboard_write', arguments: { text: 'secret' } },
        ]) {
            const result = await tool.execute(args, tool.defaultConfig, context());
            expect(result.errorMessage).toBe('tool_group_disabled:clipboard');
        }
        expect(execute).not.toHaveBeenCalled();
    });

    it('user given disabled input tools when using a batch or script then cannot bypass that group', async () => {
        settings.approval = 'full-access';
        settings.allowForeground = true;
        groups.mockResolvedValue({ input: false });
        for (const action of ['run_steps', 'run_script']) {
            const result = await tool.execute(
                {
                    action,
                    arguments: {
                        steps: [{ tool: 'press_key', args: { key: 'Enter' } }],
                        script: 'return 1;',
                    },
                },
                tool.defaultConfig,
                context()
            );
            expect(result.errorMessage).toBe('tool_group_disabled:input');
        }
        expect(execute).not.toHaveBeenCalled();
    });

    it('user given a batch with a failed step when execution returns then sees partial progress and fresh capture metadata', async () => {
        settings.approval = 'full-access';
        settings.allowForeground = true;
        execute.mockReturnValueOnce({
            cancel,
            executionId: 'batch',
            result: Promise.resolve({
                isError: false,
                content: [{ type: 'text', text: 'Stopped' }],
                structuredContent: {
                    ok: false,
                    total: 3,
                    executed: 2,
                    failed_step: 1,
                    observation: {
                        state: { capture_id: 'after-batch', tree_markdown: 'Dialog opened' },
                    },
                },
            }),
        });
        const result = await tool.execute(
            {
                action: 'run_steps',
                arguments: { steps: [{ tool: 'press_key', args: { key: 'Enter' } }], observe: {} },
            },
            tool.defaultConfig,
            context()
        );
        expect(result.isError).toBe(true);
        expect(result.result).toContain('after-batch');
        expect(result.result).toContain('failed_step');
        expect(execute).toHaveBeenCalledTimes(1);
    });

    it('user given per-action approval when calling a native mutation then sees the native arguments for review', async () => {
        const approval = await tool.buildApprovalRequest(
            { action: 'call', tool: 'kill_app', arguments: { pid: 42 } },
            tool.defaultConfig
        );
        expect(approval?.command).toContain('kill_app');
        expect(approval?.command).toContain('42');
    });

    it('user given an unknown driver tool when invoking it then gets a clear error without dispatch', async () => {
        const result = await tool.execute(
            { action: 'call', tool: 'not_registered', arguments: {} },
            tool.defaultConfig,
            context()
        );
        expect(result.errorMessage).toBe('unknown_driver_tool');
        expect(execute).not.toHaveBeenCalled();
    });
    it.each([
        { action: 'type', text: 'https://example.com', driver: 'type_text' },
        { action: 'scroll', direction: 'down', amount: 3, driver: 'scroll' },
        { action: 'key', key: 'Enter', driver: 'press_key' },
    ])(
        'user in full access delivers $action without a refused background attempt',
        async (input) => {
            settings.approval = 'full-access';
            settings.allowForeground = true;
            await tool.execute({ ...input, pid: 12, window_id: 34 }, tool.defaultConfig, context());
            expect(execute).toHaveBeenCalledWith(
                input.driver,
                expect.objectContaining({ delivery_mode: 'foreground' })
            );
        }
    );

    it('user keeps explicitly requested background text input in full access', async () => {
        settings.approval = 'full-access';
        settings.allowForeground = true;
        await tool.execute(
            { action: 'type', text: 'test', foreground: false, pid: 12, window_id: 34 },
            tool.defaultConfig,
            context()
        );
        expect(execute).toHaveBeenCalledWith(
            'type_text',
            expect.objectContaining({ delivery_mode: 'background' })
        );
    });

    it('user receives fresh screenshot coordinates after an unconfirmed pixel action', async () => {
        execute.mockReturnValueOnce({
            cancel,
            executionId: 'click',
            result: Promise.resolve(driverResult({ effect: 'unverifiable' })),
        });
        execute.mockReturnValueOnce({
            cancel,
            executionId: 'observe',
            result: Promise.resolve({
                content: [
                    { type: 'text', text: 'snapshot_id=s2; updated page' },
                    { type: 'image', data: 'aGk=', mimeType: 'image/png' },
                ],
                structuredContent: {
                    capture_id: 'new-capture',
                    screenshot_width: 1200,
                    screenshot_height: 900,
                },
            }),
        });
        const result = await tool.execute(
            { action: 'click', pid: 12, window_id: 34, x: 50, y: 80 },
            tool.defaultConfig,
            {
                ...context(),
                currentModel: { modalities: '{"input":["text","image"]}' },
            } as BaseBuiltInToolExecutionContext
        );
        expect(result.attachments).toHaveLength(1);
        expect(result.result).toContain('new-capture');
        expect(result.result).toContain('snapshot_id=s2');
        expect(execute).toHaveBeenLastCalledWith(
            'get_window_state',
            expect.objectContaining({ include_screenshot: true })
        );
    });

    it.each(
        [
            [],
            ['ctrl'],
            ['ctrl', 42],
            ['ctrl', ''],
            ['a', 'b'],
            ['a', 'ctrl'],
            ['ctrl', 'shift'],
        ].map((keys) => ({
            keys,
        }))
    )('user gets invalid hotkey $keys rejected before any input is delivered', async ({ keys }) => {
        settings.allowForeground = true;
        const result = await tool.execute(
            { action: 'hotkey', pid: 1, window_id: 2, keys },
            tool.defaultConfig,
            context()
        );
        expect(result.errorMessage).toBe('invalid_arguments');
        expect(execute).not.toHaveBeenCalled();
        expect(pulseGlow).not.toHaveBeenCalled();
    });

    it('user types emoji through Unicode input when foreground access is enabled', async () => {
        settings.allowForeground = true;
        await tool.execute(
            { action: 'type', pid: 1, window_id: 2, text: '中文 😀' },
            tool.defaultConfig,
            context()
        );
        expect(execute).toHaveBeenCalledWith(
            'type_text',
            expect.objectContaining({ text: '中文 😀', delivery_mode: 'foreground' })
        );
    });

    it('user gets a foreground refusal instead of corrupt emoji when foreground access is disabled', async () => {
        const result = await tool.execute(
            { action: 'type', pid: 1, window_id: 2, text: '中文 😀' },
            tool.defaultConfig,
            context()
        );
        expect(result.errorMessage).toBe('foreground_not_allowed');
        expect(execute).not.toHaveBeenCalled();
    });

    it('user reads requested clipboard text when the driver only includes it in structured content', async () => {
        execute.mockReturnValueOnce({
            cancel,
            executionId: 'clipboard',
            result: Promise.resolve({
                content: [
                    { type: 'text', text: 'Clipboard has 4 available types; text requested.' },
                ],
                structuredContent: { text: '中文 😀\nResult = 56', types: ['CF_UNICODETEXT'] },
            }),
        });
        const result = await tool.execute(
            { action: 'clipboard_read', include_text: true },
            tool.defaultConfig,
            context()
        );
        expect(result.result).toContain('中文 😀');
        expect(result.result).toContain('Result = 56');
    });

    it('user requesting clipboard types does not receive clipboard text', async () => {
        execute.mockReturnValueOnce({
            cancel,
            executionId: 'clipboard',
            result: Promise.resolve({
                content: [{ type: 'text', text: 'Clipboard has 4 available types; text omitted.' }],
                structuredContent: { text: 'PRIVATE CLIPBOARD', types: ['CF_UNICODETEXT'] },
            }),
        });
        const result = await tool.execute(
            { action: 'clipboard_read' },
            tool.defaultConfig,
            context()
        );
        expect(result.result).not.toContain('PRIVATE CLIPBOARD');
    });

    it('user sees the delivered click position without another desktop observation', async () => {
        execute.mockReturnValueOnce({
            cancel,
            executionId: 'click',
            result: Promise.resolve(
                driverResult({
                    effect: 'confirmed',
                    summary: 'Performed UIA Invoke on [2] (screen (-310,562)).',
                })
            ),
        });
        await tool.execute(
            { action: 'click', pid: 1, window_id: 2, element_token: 's1:2' },
            tool.defaultConfig,
            context()
        );
        expect(pulseGlow).toHaveBeenLastCalledWith({ x: -310, y: 562 }, undefined);
        expect(execute.mock.calls.map(([name]) => name)).toEqual(['click']);
    });

    it('user gets no operation pointer when the cursor setting is off', async () => {
        settings.cursorVisible = false;
        execute.mockReturnValueOnce({
            cancel,
            executionId: 'click',
            result: Promise.resolve(
                driverResult({
                    effect: 'confirmed',
                    summary: 'Performed UIA Invoke on [2] (screen (310,562)).',
                })
            ),
        });
        await tool.execute(
            { action: 'click', pid: 1, window_id: 2, element_token: 's1:2' },
            tool.defaultConfig,
            context()
        );
        expect(pulseGlow.mock.calls).toEqual([[]]);
    });

    it.each([
        'Sent click via SendInput to pid 12 at (-310.5,562) (delivery_mode:foreground).',
        'Posted click to Chromium pid 12 at (-310.5,562) (background, no foreground swap).',
    ])('user sees a pixel click at its delivered screen position: %s', async (summary) => {
        settings.allowForeground = true;
        execute.mockReturnValueOnce({
            cancel,
            executionId: 'click',
            result: Promise.resolve({
                content: [
                    {
                        type: 'text',
                        text: summary,
                    },
                ],
                structuredContent: { effect: 'unverifiable' },
            }),
        });
        await tool.execute(
            { action: 'click', pid: 12, window_id: 34, x: 100, y: 200, foreground: true },
            tool.defaultConfig,
            context()
        );
        expect(pulseGlow).toHaveBeenLastCalledWith({ x: -310.5, y: 562 }, undefined);
    });

    it('user sees the pointer at the end of a completed drag', async () => {
        execute.mockReturnValueOnce({
            cancel,
            executionId: 'drag',
            result: Promise.resolve(
                driverResult({
                    effect: 'confirmed',
                    summary: 'Dragged screen (100,200) → (350,450).',
                })
            ),
        });
        await tool.execute(
            { action: 'drag', pid: 12, window_id: 34, from_x: 0, from_y: 0, to_x: 250, to_y: 250 },
            tool.defaultConfig,
            context()
        );
        expect(pulseGlow).toHaveBeenLastCalledWith({ x: 350, y: 450 }, undefined);
    });

    it('user sees no delivered pointer for a refused click', async () => {
        execute.mockReturnValueOnce({
            cancel,
            executionId: 'click',
            result: Promise.resolve({
                isError: true,
                content: [{ type: 'text', text: 'Click failed at screen (100,200).' }],
            }),
        });
        await tool.execute(
            { action: 'click', pid: 12, window_id: 34, x: 100, y: 200 },
            tool.defaultConfig,
            context()
        );
        expect(pulseGlow.mock.calls).toEqual([[]]);
    });

    it('user gets a click and type recovery when an input rejects direct value assignment', async () => {
        execute.mockReturnValueOnce({
            cancel,
            executionId: 'value',
            result: Promise.resolve({
                isError: true,
                content: [{ type: 'text', text: 'Element does not support ValuePattern' }],
            }),
        });
        const result = await tool.execute(
            { action: 'set_value', pid: 1, window_id: 2, element_token: 's1:2', value: 'test' },
            tool.defaultConfig,
            context()
        );
        expect(result.isError).toBe(true);
        expect(result.result).toContain('click');
        expect(result.result).toContain('type');
        expect(result.result).toContain('Do not retry set_value');
    });

    it('user receives screenshot pixels and capture coordinates with an image-capable model', async () => {
        execute.mockReturnValueOnce({
            cancel,
            executionId: 'observe',
            result: Promise.resolve({
                content: [
                    { type: 'text', text: 'Window snapshot' },
                    { type: 'image', mimeType: 'image/png', data: 'aGk=' },
                ],
                structuredContent: {
                    capture_id: 'capture-1',
                    screenshot_width: 800,
                    screenshot_height: 600,
                    window_bounds: { x: 80, y: 40, width: 1200, height: 900 },
                },
            }),
        });
        const result = await tool.execute(
            { action: 'observe', pid: 1, window_id: 2, include_screenshot: true },
            tool.defaultConfig,
            {
                ...context(),
                currentModel: { modalities: '{"input":["text","image"]}' },
            } as BaseBuiltInToolExecutionContext
        );
        expect(result.attachments).toHaveLength(1);
        expect(result.attachments?.[0]?.path).toBe('/cache/screenshot.png');
        expect(result.result).toContain('capture-1');
        expect(result.result).toContain('800');
        expect(result.result).not.toContain('aGk=');
    });

    it('user with a text-only model receives an accessibility fallback instead of invisible screenshots', async () => {
        execute.mockReturnValueOnce({
            cancel,
            executionId: 'observe',
            result: Promise.resolve({
                content: [{ type: 'image', mimeType: 'image/png', data: 'aGk=' }],
            }),
        });
        const result = await tool.execute(
            { action: 'observe', pid: 1, window_id: 2, include_screenshot: true },
            tool.defaultConfig,
            {
                ...context(),
                currentModel: { modalities: '{"input":["text"]}' },
            } as BaseBuiltInToolExecutionContext
        );
        expect(result.attachments).toBeUndefined();
        expect(result.result).toContain('does not support images');
        expect(persistImage).not.toHaveBeenCalled();
    });

    it('user observes a window without being asked to approve', async () => {
        const request = await Promise.resolve(
            tool.buildApprovalRequest({ action: 'observe', pid: 1 }, tool.defaultConfig)
        );

        expect(request).toBeNull();
    });

    it('user sees the target window in the approval for a click', async () => {
        const request = await tool.buildApprovalRequest(
            { action: 'click', element_token: 's1:2', pid: 12, window_id: 34 },
            tool.defaultConfig
        );

        expect(request?.command).toContain('pid 12');
        expect(request?.command).toContain('s1:2');
        expect(request?.approveLabel).toBe('批准');
    });

    it('user is not asked again for the same action on an allowed window', async () => {
        settings.approval = 'session-window';
        allowed.add('12:34');

        await expect(
            tool.buildApprovalRequest(
                { action: 'click', pid: 12, window_id: 34 },
                tool.defaultConfig
            )
        ).resolves.toBeNull();
    });

    it('user in full access is not asked to approve mutating actions', async () => {
        settings.approval = 'full-access';

        const requests = [
            { action: 'click', element_token: 's1:2', pid: 12, window_id: 34 },
            { action: 'type', pid: 12, text: 'hello', window_id: 34 },
            { action: 'key', key: 'Enter', pid: 12, window_id: 34 },
            { action: 'launch', path: 'C:\\Windows\\System32\\notepad.exe' },
        ].map((args) => Promise.resolve(tool.buildApprovalRequest(args, tool.defaultConfig)));

        await expect(Promise.all(requests)).resolves.toEqual([null, null, null, null]);
    });

    it('user in full access is not asked to approve a foreground action when enabled', async () => {
        settings.approval = 'full-access';
        settings.allowForeground = true;

        await expect(
            tool.buildApprovalRequest(
                { action: 'click', foreground: true, pid: 12, window_id: 34 },
                tool.defaultConfig
            )
        ).resolves.toBeNull();
    });

    it('user in full access still cannot use the foreground when it is disabled', async () => {
        settings.approval = 'full-access';

        const result = await tool.execute(
            { action: 'click', foreground: true, pid: 12, window_id: 34 },
            tool.defaultConfig,
            context()
        );

        expect(execute).not.toHaveBeenCalled();
        expect(result.isError).toBe(true);
        expect(result.errorMessage).toBe('foreground_not_allowed');
    });

    it('user still confirms a foreground escalation on an allowed window', async () => {
        settings.approval = 'session-window';
        settings.allowForeground = true;
        allowed.add('12:34');

        const request = await tool.buildApprovalRequest(
            { action: 'click', foreground: true, pid: 12, window_id: 34 },
            tool.defaultConfig
        );

        expect(request).not.toBeNull();
        expect(request?.reason).toContain('前台升级');
    });

    it('user sees the click routed in the background with its verdict', async () => {
        const result = await tool.execute(
            { action: 'click', element_token: 's1:2', pid: 12, window_id: 34 },
            tool.defaultConfig,
            context()
        );

        expect(execute).toHaveBeenCalledWith('click', {
            delivery_mode: 'background',
            element_token: 's1:2',
            pid: 12,
            window_id: 34,
        });
        expect(result.isError).toBe(false);
        expect(result.structuredPayload).toMatchObject({
            action: 'click',
            effect: 'confirmed',
            kind: 'computer_use',
            route: 'accessibility',
        });
    });

    it('user sees a foreground request escalated explicitly', async () => {
        settings.allowForeground = true;

        await tool.execute(
            { action: 'click', element_token: 's1:2', foreground: true, pid: 12, window_id: 34 },
            tool.defaultConfig,
            context()
        );

        expect(execute).toHaveBeenCalledWith(
            'click',
            expect.objectContaining({ delivery_mode: 'foreground' })
        );
    });

    it('user sees typing, keys, scrolling and launching reach the driver', async () => {
        await tool.execute(
            { action: 'type', pid: 1, text: 'hello', window_id: 2 },
            tool.defaultConfig,
            context()
        );
        expect(execute).toHaveBeenLastCalledWith(
            'type_text',
            expect.objectContaining({
                text: 'hello',
            })
        );

        settings.allowForeground = true;
        await tool.execute(
            { action: 'key', key: 's', modifiers: ['Ctrl'], pid: 1, window_id: 2 },
            tool.defaultConfig,
            context()
        );
        expect(execute).toHaveBeenLastCalledWith(
            'press_key',
            expect.objectContaining({
                delivery_mode: 'foreground',
                key: 's',
                modifiers: ['Ctrl'],
            })
        );

        await tool.execute(
            { action: 'scroll', amount: 3, direction: 'down', pid: 1, window_id: 2 },
            tool.defaultConfig,
            context()
        );
        expect(execute).toHaveBeenLastCalledWith(
            'scroll',
            expect.objectContaining({
                amount: 3,
                direction: 'down',
            })
        );

        await tool.execute({ action: 'launch', app: 'notepad.exe' }, tool.defaultConfig, context());
        expect(execute).toHaveBeenLastCalledWith('launch_app', { name: 'notepad.exe' });
    });

    it('user discovers open windows when observe has no target', async () => {
        const result = await tool.execute({ action: 'observe' }, tool.defaultConfig, context());

        expect(execute).toHaveBeenCalledWith('list_windows', {});
        expect(pulseGlow).not.toHaveBeenCalled();
        expect(result.isError).toBe(false);
    });

    it('user can list windows explicitly without an approval', async () => {
        const request = await tool.buildApprovalRequest(
            { action: 'list_windows' },
            tool.defaultConfig
        );
        const result = await tool.execute(
            { action: 'list_windows' },
            tool.defaultConfig,
            context()
        );

        expect(request).toBeNull();
        expect(execute).toHaveBeenCalledWith('list_windows', {});
        expect(pulseGlow).not.toHaveBeenCalled();
        expect(result.isError).toBe(false);
    });

    it('user sees the screen glow only when an action starts changing the desktop', async () => {
        await tool.execute(
            { action: 'click', element_token: 's1:2', pid: 12, window_id: 34 },
            tool.defaultConfig,
            context()
        );

        expect(pulseGlow).toHaveBeenCalledTimes(1);
    });

    it('user launches with the path and minimized option the driver requires', async () => {
        await tool.execute(
            {
                action: 'launch',
                app: 'notepad.exe',
                path: 'C:\\Windows\\System32\\notepad.exe',
                start_minimized: true,
            },
            tool.defaultConfig,
            context()
        );

        expect(execute).toHaveBeenCalledWith('launch_app', {
            name: 'notepad.exe',
            path: 'C:\\Windows\\System32\\notepad.exe',
            start_minimized: true,
        });
    });

    it('user always confirms a launch even after an empty session key was allowed', async () => {
        settings.approval = 'session-window';
        allowed.add('-:-');

        const request = await tool.buildApprovalRequest(
            { action: 'launch', path: 'C:\\Windows\\System32\\notepad.exe' },
            tool.defaultConfig
        );

        expect(request).not.toBeNull();
        expect(request?.command).toContain('notepad.exe');
    });

    it('user does not grant a session approval to a launch without a target', async () => {
        settings.approval = 'session-window';

        await tool.execute(
            { action: 'launch', path: 'C:\\Windows\\System32\\notepad.exe' },
            tool.defaultConfig,
            context()
        );

        expect(allowForSession).not.toHaveBeenCalled();
        expect(allowed.has('-:-')).toBe(false);
    });

    it('user gets a modified key sent through the foreground only when allowed', async () => {
        settings.allowForeground = true;
        settings.approval = 'session-window';
        allowed.add('12:34');

        const request = await tool.buildApprovalRequest(
            { action: 'key', key: 'a', modifiers: ['Ctrl'], pid: 12, window_id: 34 },
            tool.defaultConfig
        );
        const result = await tool.execute(
            { action: 'key', key: 'a', modifiers: ['Ctrl'], pid: 12, window_id: 34 },
            tool.defaultConfig,
            context()
        );

        expect(request?.reason).toContain('前台升级');
        expect(execute).toHaveBeenCalledWith(
            'press_key',
            expect.objectContaining({ delivery_mode: 'foreground', modifiers: ['Ctrl'] })
        );
        expect(result.isError).toBe(false);
    });

    it('user gets a clear refusal when a modified key needs a disabled foreground', async () => {
        const result = await tool.execute(
            { action: 'key', key: 'a', modifiers: ['Ctrl'], pid: 12, window_id: 34 },
            tool.defaultConfig,
            context()
        );

        expect(execute).not.toHaveBeenCalled();
        expect(pulseGlow).not.toHaveBeenCalled();
        expect(result.isError).toBe(true);
        expect(result.errorMessage).toBe('foreground_not_allowed');
    });

    it('user cannot bypass the foreground setting through the tool config', async () => {
        const result = await tool.execute(
            { action: 'click', element_token: 's1:2', foreground: true, pid: 12, window_id: 34 },
            { allowForeground: true },
            context()
        );

        expect(execute).not.toHaveBeenCalled();
        expect(result.errorMessage).toBe('foreground_not_allowed');
    });

    it('user gets a launch refused when the app is outside the allowed list', async () => {
        settings.allowedApps = ['CalculatorApp'];

        const result = await tool.execute(
            {
                action: 'launch',
                path: 'C:\\Windows\\System32\\notepad.exe',
                start_minimized: true,
            },
            tool.defaultConfig,
            context()
        );

        expect(execute).not.toHaveBeenCalled();
        expect(result.isError).toBe(true);
        expect(result.errorMessage).toBe('app_not_allowed');
    });

    it('user gets a launch allowed when the executable name is listed', async () => {
        settings.allowedApps = ['Notepad'];

        await tool.execute(
            {
                action: 'launch',
                path: 'C:\\Windows\\System32\\notepad.exe',
                start_minimized: true,
            },
            tool.defaultConfig,
            context()
        );

        expect(execute).toHaveBeenCalledWith(
            'launch_app',
            expect.objectContaining({
                path: 'C:\\Windows\\System32\\notepad.exe',
            })
        );
    });

    it('user gets a launch refused when the allowlist is set and no app is identified', async () => {
        settings.allowedApps = ['Notepad'];

        const result = await tool.execute({ action: 'launch' }, tool.defaultConfig, context());

        expect(execute).not.toHaveBeenCalled();
        expect(result.errorMessage).toBe('app_not_allowed');
    });

    it('user gets a session grant reused by another action on the same window', async () => {
        settings.approval = 'session-window';
        allowed.add('12:34');

        await expect(
            tool.buildApprovalRequest(
                { action: 'type', pid: 12, text: 'hello', window_id: 34 },
                tool.defaultConfig
            )
        ).resolves.toBeNull();
    });

    it('user sees a driver error reported as a failed action', async () => {
        execute.mockReturnValue({
            cancel,
            executionId: 'exec-1',
            result: Promise.resolve({
                content: [{ type: 'text', text: 'window_target_not_found' }],
                isError: true,
            }),
        });

        const result = await tool.execute(
            { action: 'click', element_token: 's1:2', pid: 1, window_id: 2 },
            tool.defaultConfig,
            context()
        );

        expect(result.isError).toBe(true);
        expect(result.status).toBe('error');
        expect(result.result).toBe('window_target_not_found');
    });

    it('user receives the current window after an unconfirmed action without a false failure', async () => {
        execute.mockReturnValueOnce({
            cancel,
            executionId: 'exec-1',
            result: Promise.resolve(
                driverResult({ effect: 'unverifiable', route: 'synthetic_events' })
            ),
        });
        execute.mockReturnValueOnce({
            cancel,
            executionId: 'exec-observe',
            result: Promise.resolve({
                content: [{ type: 'text', text: 'snapshot_id=s2; Edit Name value=New provider' }],
                isError: false,
            }),
        });

        const result = await tool.execute(
            { action: 'key', key: 'a', pid: 1, window_id: 2 },
            tool.defaultConfig,
            context()
        );

        expect(result.isError).toBe(false);
        expect(result.status).toBe('success');
        expect(result.errorMessage).toBeUndefined();
        expect(result.result).toContain('snapshot_id=s2');
        expect(execute).toHaveBeenLastCalledWith(
            'get_window_state',
            expect.objectContaining({
                pid: 1,
                window_id: 2,
                include_screenshot: false,
                timeout_ms: 3000,
            })
        );
        expect(result.structuredPayload).toMatchObject({ effect: 'unverifiable' });
    });

    it('user keeps the delivered action when the follow-up observation fails', async () => {
        execute.mockReturnValueOnce({
            cancel,
            executionId: 'exec-action',
            result: Promise.resolve(driverResult({ effect: 'suspected_noop' })),
        });
        execute.mockReturnValueOnce({
            cancel,
            executionId: 'exec-observe',
            result: Promise.reject(new Error('window closed')),
        });

        const result = await tool.execute(
            { action: 'click', element_token: 's1:2', pid: 1, window_id: 2 },
            tool.defaultConfig,
            context()
        );

        expect(result.isError).toBe(false);
        expect(result.result).toContain('window closed');
        expect(result.result).toContain('observe the target before retrying');
        expect(result.structuredPayload).toMatchObject({ effect: 'suspected_noop' });
        expect(execute.mock.calls.filter(([name]) => name === 'click')).toHaveLength(1);
    });

    it('user cancels the follow-up observation without repeating the action', async () => {
        const controller = new AbortController();
        let finish!: (value: Record<string, unknown>) => void;
        const cancelObservation = vi.fn(() => finish(driverResult()));
        execute.mockReturnValueOnce({
            cancel,
            executionId: 'action',
            result: Promise.resolve(driverResult({ effect: 'unverifiable' })),
        });
        execute.mockReturnValueOnce({
            cancel: cancelObservation,
            executionId: 'observe',
            result: new Promise((resolve) => {
                finish = resolve;
            }),
        });
        const running = tool.execute(
            { action: 'click', pid: 1, window_id: 2 },
            tool.defaultConfig,
            context(controller.signal)
        );
        await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(2));
        controller.abort();
        const result = await running;
        expect(cancelObservation).toHaveBeenCalledTimes(1);
        expect(result.status).toBe('timeout');
        expect(execute.mock.calls.filter(([name]) => name === 'click')).toHaveLength(1);
    });

    it('user cancelling the action stops the driver call', async () => {
        const controller = new AbortController();
        let rejectCall!: (error: Error) => void;
        cancel.mockImplementation(() => rejectCall(new Error('cancelled')));
        execute.mockReturnValue({
            cancel,
            executionId: 'exec-1',
            result: new Promise((_resolve, reject) => {
                rejectCall = reject;
            }),
        });

        const pending = tool.execute(
            { action: 'click', element_token: 's1:2', pid: 1, window_id: 2 },
            tool.defaultConfig,
            context(controller.signal)
        );
        await vi.waitFor(() => expect(execute).toHaveBeenCalled());
        controller.abort();

        const result = await pending;
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(result.isError).toBe(true);
        expect(result.status).toBe('timeout');
    });

    it('user can inspect apps, the desktop, and filtered windows', async () => {
        await tool.execute({ action: 'list_apps' }, tool.defaultConfig, context());
        expect(execute).toHaveBeenLastCalledWith('list_apps', {});

        await tool.execute(
            { action: 'list_windows', on_screen_only: true, pid: 12 },
            tool.defaultConfig,
            context()
        );
        expect(execute).toHaveBeenLastCalledWith('list_windows', {
            on_screen_only: true,
            pid: 12,
        });

        await tool.execute(
            { action: 'desktop_state', max_image_dimension: 1280 },
            tool.defaultConfig,
            context()
        );
        expect(execute).toHaveBeenLastCalledWith('get_desktop_state', {
            max_image_dimension: 1280,
        });

        await tool.execute({ action: 'screen_size' }, tool.defaultConfig, context());
        expect(execute).toHaveBeenLastCalledWith('get_screen_size', {});
    });

    it('user can resize and bring an exact window to the front', async () => {
        settings.allowForeground = true;

        await tool.execute(
            {
                action: 'set_window_frame',
                height: 720,
                pid: 12,
                width: 1280,
                window_id: 34,
                x: 40,
                y: 30,
            },
            tool.defaultConfig,
            context()
        );
        expect(execute).toHaveBeenLastCalledWith('set_window_frame', {
            height: 720,
            pid: 12,
            width: 1280,
            window_id: 34,
            x: 40,
            y: 30,
        });

        await tool.execute(
            { action: 'bring_to_front', pid: 12, window_id: 34 },
            tool.defaultConfig,
            context()
        );
        expect(execute).toHaveBeenLastCalledWith('bring_to_front', {
            pid: 12,
            window_id: 34,
        });
    });

    it('user cannot bring a window to the front when foreground is disabled', async () => {
        const result = await tool.execute(
            { action: 'bring_to_front', pid: 12, window_id: 34 },
            tool.defaultConfig,
            context()
        );

        expect(execute).not.toHaveBeenCalled();
        expect(result.errorMessage).toBe('foreground_not_allowed');
    });

    it('user can drag and send a foreground hotkey without the XAML accelerator restriction', async () => {
        settings.allowForeground = true;

        await tool.execute(
            {
                action: 'drag',
                from_x: 10,
                from_y: 20,
                pid: 12,
                to_x: 80,
                to_y: 90,
                window_id: 34,
            },
            tool.defaultConfig,
            context()
        );
        expect(execute).toHaveBeenLastCalledWith(
            'drag',
            expect.objectContaining({
                delivery_mode: 'background',
                from_x: 10,
                from_y: 20,
                to_x: 80,
                to_y: 90,
            })
        );

        await tool.execute(
            {
                action: 'hotkey',
                keys: ['ctrl', 'c'],
                pid: 12,
                window_id: 34,
            },
            tool.defaultConfig,
            context()
        );
        expect(execute).toHaveBeenLastCalledWith(
            'press_key',
            expect.objectContaining({
                delivery_mode: 'foreground',
                key: 'c',
                modifiers: ['ctrl'],
            })
        );
    });

    it('user can forward advanced observation controls', async () => {
        await tool.execute(
            {
                action: 'observe',
                include_accessibility_tree: true,
                include_screenshot: true,
                max_elements: 500,
                pid: 12,
                query: 'Save',
                since: 's1',
                tree_format: 'elements',
                window_id: 34,
            },
            tool.defaultConfig,
            {
                ...context(),
                currentModel: { modalities: '{"input":["text","image"]}' },
            } as BaseBuiltInToolExecutionContext
        );

        expect(execute).toHaveBeenLastCalledWith('get_window_state', {
            include_accessibility_tree: true,
            include_screenshot: true,
            max_elements: 500,
            pid: 12,
            query: 'Save',
            since: 's1',
            timeout_ms: 3000,
            tree_format: 'elements',
            window_id: 34,
        });
    });

    it('user can set UIA values, invoke menus, verify, zoom, and parse captures', async () => {
        await tool.execute(
            { action: 'set_value', element_token: 's1:2', pid: 12, value: 'hello', window_id: 34 },
            tool.defaultConfig,
            context()
        );
        expect(execute).toHaveBeenLastCalledWith(
            'set_value',
            expect.objectContaining({ element_token: 's1:2', value: 'hello' })
        );

        await tool.execute(
            {
                action: 'invoke_menu',
                menu_path: ['File', 'Save As...'],
                pid: 12,
                window_id: 34,
            },
            tool.defaultConfig,
            context()
        );
        expect(execute).toHaveBeenLastCalledWith('invoke_menu', {
            path: ['File', 'Save As...'],
            pid: 12,
            window_id: 34,
        });

        await tool.execute(
            {
                action: 'verify_state',
                expect: [{ window: { exists: true } }],
                pid: 12,
                window_id: 34,
            },
            tool.defaultConfig,
            context()
        );
        expect(execute).toHaveBeenLastCalledWith(
            'verify_state',
            expect.objectContaining({ expect: [{ window: { exists: true } }] })
        );

        await tool.execute(
            { action: 'zoom', pid: 12, window_id: 34, x1: 1, x2: 100, y1: 2, y2: 80 },
            tool.defaultConfig,
            context()
        );
        expect(execute).toHaveBeenLastCalledWith('zoom', {
            pid: 12,
            window_id: 34,
            x1: 1,
            x2: 100,
            y1: 2,
            y2: 80,
        });

        await tool.execute(
            {
                action: 'parse_visual_regions',
                capture_id: 'c1',
                kinds: ['text'],
                max_regions: 20,
            },
            tool.defaultConfig,
            context()
        );
        expect(execute).toHaveBeenLastCalledWith('parse_visual_regions', {
            capture_id: 'c1',
            options: { kinds: ['text'], max_regions: 20 },
        });
    });

    it('user is asked before clipboard text can be read even in a session mode', async () => {
        settings.approval = 'session-window';

        const request = await Promise.resolve(
            tool.buildApprovalRequest(
                { action: 'clipboard_read', include_text: true },
                tool.defaultConfig
            )
        );

        expect(request).not.toBeNull();
        expect(request?.command).toContain('clipboard_read');
    });

    it('user sees an unknown action rejected without touching the driver', async () => {
        const result = await tool.execute({ action: 'explode' }, tool.defaultConfig, context());

        expect(execute).not.toHaveBeenCalled();
        expect(result.isError).toBe(true);
        expect(result.errorMessage).toBe('unsupported action');
    });
});
