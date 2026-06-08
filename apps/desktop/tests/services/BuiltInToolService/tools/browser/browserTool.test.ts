import { getLastTauriInvokeCall, mockTauriCommand } from '@tests/utils/tauri';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const browserSettingsValues = vi.hoisted(() => new Map<string, string | null>());

vi.mock('@database/queries', () => ({
    getSettingValue: vi.fn(
        async ({ key }: { key: string }) => browserSettingsValues.get(key) ?? null
    ),
}));

import {
    browserActTool,
    browserObserveTool,
    browserSessionTool,
    browserTool,
    builtInTools,
    createBrowserApprovalRequest,
    executeBrowserTool,
    executeBrowserActTool,
    executeBrowserObserveTool,
    executeBrowserSessionTool,
    redactBrowserValue,
} from '@/services/BuiltInToolService/tools/browser';
import {
    DEFAULT_BROWSER_AUTOMATION_TOOL_CONFIG,
    getBrowserAutomationStartupUrlError,
    parseBrowserAutomationToolConfig,
    serializeBrowserAutomationToolConfig,
} from '@/services/BuiltInToolService/tools/browser/config';
import { formatBrowserToolResult } from '@/services/BuiltInToolService/tools/browser/format';
import {
    formatRedactedJson,
    redactBrowserText,
    redactCredentialFieldValue,
    redactUrl,
} from '@/services/BuiltInToolService/tools/browser/redaction';
import type { BaseBuiltInToolExecutionContext } from '@/services/BuiltInToolService/types';

function fakeContext(): BaseBuiltInToolExecutionContext {
    return {
        callId: 'call-1',
        iteration: 0,
        hasExecutedBuiltInTool: () => false,
        requestUserQuestions: async (_callId, questions) =>
            questions.map((question, questionIndex) => ({
                questionIndex,
                selectedLabels: [question.options[0]?.label ?? '允许本次'],
                skipped: false,
            })),
    };
}

const defaultBrowserConfig = { mode: 'default' as const, browserId: '', startupUrl: '' };

beforeEach(() => {
    browserSettingsValues.clear();
});

describe('browser built-in tool group', () => {
    it('exports one consolidated model-visible browser tool', () => {
        expect(builtInTools.map((tool) => tool.id).sort()).toEqual(['browser']);
    });

    it('does not expose raw CDP, debug, extract, or evaluate tools', () => {
        const ids = builtInTools.map((tool) => tool.id);

        expect(ids).not.toContain('browser_cdp');
        expect(ids).not.toContain('browser_debug');
        expect(ids).not.toContain('browser_extract');
        expect(ids).not.toContain('browser_evaluate');
    });

    it('declares the required operation sets in schemas', () => {
        expect(browserTool.inputSchema.properties.operation).toEqual(
            expect.objectContaining({
                enum: [
                    'status',
                    'start',
                    'stop',
                    'connect_existing',
                    'current',
                    'tabs',
                    'screenshot',
                    'dom',
                    'navigate',
                    'click',
                    'type',
                    'fill',
                    'fill_form',
                    'press_key',
                    'scroll',
                    'wait',
                    'back',
                    'forward',
                    'reload',
                ],
            })
        );
        expect(browserSessionTool.inputSchema.properties.operation).toEqual(
            expect.objectContaining({
                enum: ['status', 'start', 'stop', 'connect_existing'],
            })
        );
        expect(browserObserveTool.inputSchema.properties.operation).toEqual(
            expect.objectContaining({
                enum: ['current', 'tabs', 'screenshot', 'dom'],
            })
        );
        expect(browserActTool.inputSchema.properties.operation).toEqual(
            expect.objectContaining({
                enum: [
                    'navigate',
                    'click',
                    'type',
                    'fill',
                    'fill_form',
                    'press_key',
                    'scroll',
                    'wait',
                    'back',
                    'forward',
                    'reload',
                ],
            })
        );

        expect(JSON.stringify(browserSessionTool.inputSchema)).not.toContain('list_browsers');
        expect(JSON.stringify(browserSessionTool.inputSchema)).not.toContain('attach');
        expect(JSON.stringify(browserSessionTool.inputSchema)).not.toContain('endpoint');
        expect(JSON.stringify(browserSessionTool.inputSchema)).not.toContain('navigate');
        expect(JSON.stringify(browserSessionTool.inputSchema)).not.toContain('browserPath');
        expect(JSON.stringify(browserSessionTool.inputSchema)).not.toContain('userDataDir');
        expect(browserSessionTool.inputSchema.additionalProperties).toBe(false);
        expect(browserSessionTool.inputSchema.properties.description).toEqual(
            expect.objectContaining({ type: 'string' })
        );
        expect(JSON.stringify(browserObserveTool.inputSchema)).toContain('includeConsole');
        expect(JSON.stringify(browserObserveTool.inputSchema)).toContain('includeNetwork');
        expect(browserObserveTool.inputSchema.properties.description).toEqual(
            expect.objectContaining({ type: 'string' })
        );
        expect(browserObserveTool.inputSchema.additionalProperties).toBe(false);
        expect(JSON.stringify(browserActTool.inputSchema)).not.toContain('selector');
        expect(JSON.stringify(browserActTool.inputSchema)).not.toContain('"x"');
        expect(JSON.stringify(browserActTool.inputSchema)).not.toContain('"y"');
        expect(JSON.stringify(browserActTool.inputSchema)).not.toContain('"field"');
        expect(browserActTool.inputSchema.additionalProperties).toBe(false);
        expect(browserActTool.inputSchema.properties.description).toEqual(
            expect.objectContaining({ type: 'string' })
        );
        expect(browserActTool.inputSchema.properties.fields).toEqual(
            expect.objectContaining({
                items: expect.objectContaining({
                    additionalProperties: false,
                    required: ['ref', 'navigationToken', 'value'],
                }),
            })
        );
    });

    it('builds concise conversation semantics for each browser tool', () => {
        expect(
            browserTool.buildConversationSemantic({
                operation: ' start ',
                description: '  鎵撳紑榛樿涓婚〉  ',
            })
        ).toEqual({
            action: 'cursor',
            target: '鎵撳紑榛樿涓婚〉',
        });
        expect(
            browserSessionTool.buildConversationSemantic({
                operation: ' start ',
                description: '  打开默认主页  ',
            })
        ).toEqual({
            action: 'cursor',
            target: '打开默认主页',
        });
        expect(
            browserObserveTool.buildConversationSemantic({
                operation: 'dom',
                description: '查看页面结构',
            })
        ).toEqual({
            action: 'cursor',
            target: '查看页面结构',
        });
        expect(browserObserveTool.buildConversationSemantic({ operation: 'current' })).toEqual({
            action: 'cursor',
            target: '查看当前页面',
        });
    });

    it('requires semantic descriptions except fixed passive status operations', async () => {
        mockTauriCommand('browser_status', { status: 'disconnected' });

        await expect(
            executeBrowserSessionTool({ operation: 'status' }, defaultBrowserConfig, fakeContext())
        ).resolves.toMatchObject({ isError: false });

        await expect(
            executeBrowserSessionTool({ operation: 'start' }, defaultBrowserConfig, fakeContext())
        ).resolves.toMatchObject({
            isError: true,
            errorMessage: expect.stringContaining('description'),
        });

        await expect(
            executeBrowserActTool(
                { operation: 'navigate', url: 'https://example.test' },
                defaultBrowserConfig,
                fakeContext()
            )
        ).resolves.toMatchObject({
            isError: true,
            errorMessage: expect.stringContaining('description'),
        });
    });

    it('routes the consolidated browser tool to the underlying native action command', async () => {
        mockTauriCommand('browser_act', { ok: true, action: 'click' });

        await expect(
            executeBrowserTool(
                {
                    operation: 'click',
                    ref: 'submit-button',
                    navigationToken: 'obs-1',
                    description: '鐐瑰嚮鎻愪氦鎸夐挳',
                },
                defaultBrowserConfig,
                fakeContext()
            )
        ).resolves.toMatchObject({ isError: false });

        expect(getLastTauriInvokeCall('browser_act')?.payload).toEqual({
            request: {
                action: 'click',
                ref: 'submit-button',
                navigationToken: 'obs-1',
            },
        });
    });

    it('delegates approval requests through the tool instances', async () => {
        await expect(
            browserTool.buildApprovalRequest({ operation: 'click', ref: 'submit-button' })
        ).resolves.toEqual(expect.objectContaining({ command: 'click submit-button' }));
        await expect(
            browserActTool.buildApprovalRequest({ operation: 'click', ref: 'submit-button' })
        ).resolves.toEqual(expect.objectContaining({ command: 'click submit-button' }));
        await expect(
            browserActTool.buildApprovalRequest({
                operation: 'click',
                ref: 'submit-button',
                description: '点击登录按钮',
            })
        ).resolves.toEqual(
            expect.objectContaining({ command: '点击登录按钮', description: '点击登录按钮' })
        );
        await expect(
            browserObserveTool.buildApprovalRequest({ operation: 'dom' })
        ).resolves.toBeNull();
    });
});

describe('browser tool redaction', () => {
    it('redacts URLs, emails, secrets, one-time codes, and credential fields', () => {
        const redacted = redactBrowserValue({
            url: 'https://example.test/login?token=secret#hash',
            email: 'alice@example.test',
            password: 'correct-horse-battery-staple',
            text: 'Use OTP 123456 and bearer abcdef1234567890abcdef1234567890',
        });

        expect(JSON.stringify(redacted)).toContain('https://example.test/login');
        expect(JSON.stringify(redacted)).not.toContain('token=secret');
        expect(JSON.stringify(redacted)).not.toContain('#hash');
        expect(JSON.stringify(redacted)).not.toContain('alice@example.test');
        expect(JSON.stringify(redacted)).not.toContain('correct-horse-battery-staple');
        expect(JSON.stringify(redacted)).not.toContain('123456');
        expect(JSON.stringify(redacted)).not.toContain('abcdef1234567890abcdef1234567890');
    });

    it('redacts text, nested arrays, screenshot payloads, credential-like field values, and URL fragments', () => {
        expect(
            redactUrl('Open https://example.test/reset?token=secret#code before continuing')
        ).toBe('Open https://example.test/reset before continuing');
        expect(
            redactBrowserText(
                'alice@example.test bearer=secret authorization=abc Bearer abcdefghijklmnopqrstuvwxyz123456'
            )
        ).toBe('[redacted-email] bearer=[redacted] authorization=[redacted] Bearer [redacted]');

        const redacted = redactBrowserValue([
            {
                field: 'one-time code',
                value: '123456',
                screenshot_base64: 'SCREENSHOT_SECRET',
            },
            {
                href: 'https://example.test/path?api_key=secret#hash',
                children: [{ label: 'normal', text: 'Visible 12345678' }],
            },
        ]);

        const serialized = JSON.stringify(redacted);
        expect(serialized).not.toContain('SCREENSHOT_SECRET');
        expect(serialized).not.toContain('api_key=secret');
        expect(serialized).not.toContain('#hash');
        expect(serialized).not.toContain('12345678');
        expect(serialized).toContain('[suppressed]');
        expect(serialized).toContain('[redacted]');
    });

    it('redacts credential values based on field hints and formats redacted JSON', () => {
        expect(redactCredentialFieldValue(undefined, 'plain visible text')).toBe(
            'plain visible text'
        );
        expect(redactCredentialFieldValue('api token', 'abc123')).toBe('[redacted]');
        expect(formatRedactedJson({ dataUrl: 'data:image/png;base64,secret' })).toContain(
            '"dataUrl": "[suppressed]"'
        );
    });
});

describe('browser tool config', () => {
    it('returns defensive default config for empty or invalid persisted config', () => {
        expect(parseBrowserAutomationToolConfig(null)).toEqual(
            DEFAULT_BROWSER_AUTOMATION_TOOL_CONFIG
        );
        expect(parseBrowserAutomationToolConfig('not-json')).toEqual(
            DEFAULT_BROWSER_AUTOMATION_TOOL_CONFIG
        );
        expect(parseBrowserAutomationToolConfig(JSON.stringify({ mode: 'unsafe' }))).toEqual(
            DEFAULT_BROWSER_AUTOMATION_TOOL_CONFIG
        );
    });

    it('parses only safe browser config fields and ignores legacy arbitrary paths', () => {
        expect(
            parseBrowserAutomationToolConfig(
                JSON.stringify({
                    mode: 'custom',
                    browserId: ' edge ',
                    startupUrl: ' https://example.test/start ',
                    browserPath: 'C:/unsafe/chrome.exe',
                    userDataDir: 'G:/unsafe-profile',
                })
            )
        ).toEqual({
            mode: 'custom',
            browserId: ' edge ',
            startupUrl: ' https://example.test/start ',
        });
    });

    it('serializes trimmed config and validates startup URLs', () => {
        expect(
            serializeBrowserAutomationToolConfig({
                mode: 'custom',
                browserId: ' edge ',
                startupUrl: ' https://example.test/start ',
            })
        ).toBe(
            JSON.stringify({
                mode: 'custom',
                browserId: 'edge',
                startupUrl: 'https://example.test/start',
            })
        );

        expect(
            getBrowserAutomationStartupUrlError({ ...defaultBrowserConfig, startupUrl: '' })
        ).toBe('');
        expect(
            getBrowserAutomationStartupUrlError({
                ...defaultBrowserConfig,
                startupUrl: 'https://example.test',
            })
        ).toBe('');
        expect(
            getBrowserAutomationStartupUrlError({
                ...defaultBrowserConfig,
                startupUrl: 'file:///C:/secret.html',
            })
        ).toBeTruthy();
        expect(
            getBrowserAutomationStartupUrlError({
                ...defaultBrowserConfig,
                startupUrl: 'not a url',
            })
        ).toBeTruthy();
    });
});

describe('browser tool approval', () => {
    it('does not request approval for routine status and observe operations', async () => {
        await expect(
            createBrowserApprovalRequest('browser_session', { operation: 'status' })
        ).resolves.toBeNull();
        await expect(
            createBrowserApprovalRequest('browser_observe', { operation: 'dom' })
        ).resolves.toBeNull();
    });

    it('skips approval prompts when browser permissions allow the operation', async () => {
        browserSettingsValues.set(
            'browser_settings',
            JSON.stringify({
                permissions: {
                    navigate: 'allow',
                    connectExisting: 'allow',
                    observeDom: 'allow',
                    screenshot: 'allow',
                    click: 'allow',
                    type: 'allow',
                    fillForm: 'allow',
                    history: 'allow',
                    diagnostics: 'allow',
                },
            })
        );

        await expect(
            createBrowserApprovalRequest('browser_session', {
                operation: 'start',
                description: '启动浏览器访问OpenAI博客',
            })
        ).resolves.toBeNull();
        await expect(
            createBrowserApprovalRequest('browser_act', {
                operation: 'navigate',
                url: 'https://openai.com/blog',
                description: '访问OpenAI博客',
            })
        ).resolves.toBeNull();
    });

    it('requests approval for navigation with a redacted target', async () => {
        const approval = await createBrowserApprovalRequest('browser_act', {
            operation: 'navigate',
            url: 'https://example.test/login?token=secret#hash',
        });

        expect(approval).toEqual(
            expect.objectContaining({
                command: 'navigate https://example.test/login',
            })
        );
        expect(JSON.stringify(approval)).not.toContain('token=secret');
        expect(JSON.stringify(approval)).not.toContain('#hash');
    });

    it('requests approval for credential-like fill operations without leaking values', async () => {
        const approval = await createBrowserApprovalRequest('browser_act', {
            operation: 'fill',
            ref: 'password-field',
            field: 'password',
            value: 'super-secret-password',
        });

        expect(approval).toEqual(
            expect.objectContaining({
                command: 'fill password-field password=[redacted]',
            })
        );
        expect(JSON.stringify(approval)).not.toContain('super-secret-password');
    });

    it('requests approval for high-impact browser actions while allowing low-impact observation', async () => {
        await expect(
            createBrowserApprovalRequest('browser_session', { operation: 'start' })
        ).resolves.toEqual(expect.objectContaining({ command: 'start' }));
        await expect(
            createBrowserApprovalRequest('browser_session', { operation: 'attach' })
        ).resolves.toBeNull();
        await expect(
            createBrowserApprovalRequest('browser_act', { operation: 'wait' })
        ).resolves.toBeNull();
        await expect(
            createBrowserApprovalRequest('browser_act', { operation: 'reload' })
        ).resolves.toEqual(expect.objectContaining({ command: 'reload selected tab' }));
    });

    it('covers all approval command shapes without exposing selector secrets', async () => {
        await expect(createBrowserApprovalRequest('browser_act', {})).resolves.toBeNull();
        await expect(
            createBrowserApprovalRequest('browser_act', { operation: 'scroll' })
        ).resolves.toBeNull();
        await expect(
            createBrowserApprovalRequest('browser_session', { operation: 'stop' })
        ).resolves.toEqual(expect.objectContaining({ command: 'stop' }));
        await expect(
            createBrowserApprovalRequest('browser_observe', { operation: 'screenshot' })
        ).resolves.toEqual(expect.objectContaining({ command: 'screenshot selected tab' }));
        await expect(
            createBrowserApprovalRequest('browser_act', { operation: 'navigate' })
        ).resolves.toEqual(expect.objectContaining({ command: 'navigate missing URL' }));
        await expect(
            createBrowserApprovalRequest('browser_act', {
                operation: 'screenshot',
                selector: '[data-token="secret"]',
            })
        ).resolves.toEqual(
            expect.objectContaining({ command: 'screenshot [data-token=[redacted]' })
        );
        await expect(
            createBrowserApprovalRequest('browser_act', {
                operation: 'fill',
                name: 'email',
                value: 'alice@example.test',
            })
        ).resolves.toEqual(
            expect.objectContaining({ command: 'fill selected tab email=[redacted]' })
        );
        await expect(
            createBrowserApprovalRequest('browser_act', { operation: 'fill_form', ref: 'form-1' })
        ).resolves.toEqual(expect.objectContaining({ command: 'fill_form form-1' }));
        await expect(
            createBrowserApprovalRequest('browser_act', { operation: 'type', ref: 'editor' })
        ).resolves.toEqual(expect.objectContaining({ command: 'type editor' }));
        await expect(
            createBrowserApprovalRequest('browser_act', { operation: 'press_key', ref: 'editor' })
        ).resolves.toEqual(expect.objectContaining({ command: 'press_key editor' }));
        await expect(
            createBrowserApprovalRequest('browser_act', { operation: 'unknown' })
        ).resolves.toBeNull();
        await expect(
            createBrowserApprovalRequest('browser_unknown' as never, { operation: 'click' })
        ).resolves.toBeNull();
    });
});

describe('browser tool execution formatting', () => {
    it('routes only managed status and stop session operations', async () => {
        mockTauriCommand('browser_status', { status: 'disconnected' });
        mockTauriCommand('browser_stop', { status: 'disconnected' });

        await expect(
            executeBrowserSessionTool({ operation: 'status' }, defaultBrowserConfig, fakeContext())
        ).resolves.toMatchObject({ isError: false });
        await expect(
            executeBrowserSessionTool(
                { operation: 'stop', description: '停止浏览器会话' },
                defaultBrowserConfig,
                fakeContext()
            )
        ).resolves.toMatchObject({ isError: false });

        expect(getLastTauriInvokeCall('browser_status')).toBeTruthy();
        expect(getLastTauriInvokeCall('browser_stop')).toBeTruthy();
        expect(getLastTauriInvokeCall('browser_connect')).toBeUndefined();
        expect(getLastTauriInvokeCall('browser_list_browsers')).toBeUndefined();
    });

    it('rejects missing browser_session operation before invoking native browser code', async () => {
        mockTauriCommand('browser_status', { status: 'connected' });

        const result = await executeBrowserSessionTool({}, defaultBrowserConfig, fakeContext());

        expect(result.isError).toBe(true);
        expect(result.result).toContain('Missing required browser_session operation');
        expect(getLastTauriInvokeCall('browser_status')).toBeUndefined();
    });

    it('normalizes session operations to the matching NativeService command and safe serde names', async () => {
        mockTauriCommand('browser_start', { status: 'connected' });

        const result = await executeBrowserSessionTool(
            {
                operation: 'start',
                description: '打开指定浏览器',
                browserId: 'chrome',
                startupUrl: 'https://example.test/start',
            },
            { mode: 'default', browserId: '', startupUrl: '' },
            fakeContext()
        );

        expect(result.isError).toBe(false);
        expect(getLastTauriInvokeCall('browser_start')?.payload).toEqual({
            request: {
                browserId: 'chrome',
                startupUrl: 'https://example.test/start',
                fingerprintMode: 'off',
                fingerprintLocale: 'zh-CN',
                fingerprintTimezone: 'Asia/Shanghai',
                fingerprintWindowSize: '1366,768',
                fingerprintStealthScript: false,
            },
        });
    });

    it('falls back to legacy url argument and omits blank custom config during start', async () => {
        mockTauriCommand('browser_start', { status: 'connected' });

        const result = await executeBrowserSessionTool(
            {
                operation: 'start',
                description: '打开旧版 URL',
                browserId: '   ',
                url: 'https://example.test/legacy-url',
            },
            { mode: 'custom', browserId: '   ', startupUrl: '   ' },
            fakeContext()
        );

        expect(result.isError).toBe(false);
        expect(getLastTauriInvokeCall('browser_start')?.payload).toEqual({
            request: {
                startupUrl: 'https://example.test/legacy-url',
                fingerprintMode: 'off',
                fingerprintLocale: 'zh-CN',
                fingerprintTimezone: 'Asia/Shanghai',
                fingerprintWindowSize: '1366,768',
                fingerprintStealthScript: false,
            },
        });
    });

    it('uses persisted safe browser config for managed start', async () => {
        mockTauriCommand('browser_start', { status: 'connected' });

        const result = await browserSessionTool.execute(
            { operation: 'start', description: '打开配置主页' },
            browserSessionTool.parseConfig(
                JSON.stringify({
                    mode: 'custom',
                    browserId: 'edge',
                    startupUrl: 'https://example.test/configured',
                    browserPath: 'C:/ignored.exe',
                    userDataDir: 'G:/ignored-profile',
                })
            ),
            fakeContext()
        );

        expect(result.isError).toBe(false);
        expect(getLastTauriInvokeCall('browser_start')?.payload).toEqual({
            request: {
                browserId: 'edge',
                startupUrl: 'https://example.test/configured',
                fingerprintMode: 'off',
                fingerprintLocale: 'zh-CN',
                fingerprintTimezone: 'Asia/Shanghai',
                fingerprintWindowSize: '1366,768',
                fingerprintStealthScript: false,
            },
        });
    });

    it('uses browser settings default homepage and executable path for managed start', async () => {
        mockTauriCommand('browser_start', { status: 'connected' });
        browserSettingsValues.set(
            'browser_settings',
            JSON.stringify({
                defaultHomepage: 'https://example.test/browser-settings-home',
                browserExecutablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
            })
        );

        const result = await executeBrowserSessionTool(
            { operation: 'start', description: '打开默认主页' },
            { mode: 'custom', browserId: 'edge', startupUrl: 'https://legacy.example.test' },
            fakeContext()
        );

        expect(result.isError).toBe(false);
        expect(getLastTauriInvokeCall('browser_start')?.payload).toEqual({
            request: {
                browserId: 'edge',
                startupUrl: 'https://example.test/browser-settings-home',
                browserExecutablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
                fingerprintMode: 'off',
                fingerprintLocale: 'zh-CN',
                fingerprintTimezone: 'Asia/Shanghai',
                fingerprintWindowSize: '1366,768',
                fingerprintStealthScript: false,
            },
        });
    });

    it('passes balanced fingerprint settings to managed browser start', async () => {
        mockTauriCommand('browser_start', { status: 'connected' });
        browserSettingsValues.set(
            'browser_settings',
            JSON.stringify({
                fingerprintMode: 'balanced',
                fingerprintLocale: 'en-US',
                fingerprintTimezone: 'America/Los_Angeles',
                fingerprintUserAgent: 'Mozilla/5.0 TouchAI-compatible',
                fingerprintWindowSize: '1440,900',
                fingerprintStealthScript: false,
            })
        );

        const result = await executeBrowserSessionTool(
            { operation: 'start', description: '启动兼容性浏览器' },
            defaultBrowserConfig,
            fakeContext()
        );

        expect(result.isError).toBe(false);
        expect(getLastTauriInvokeCall('browser_start')?.payload).toEqual({
            request: {
                fingerprintMode: 'balanced',
                fingerprintLocale: 'en-US',
                fingerprintTimezone: 'America/Los_Angeles',
                fingerprintUserAgent: 'Mozilla/5.0 TouchAI-compatible',
                fingerprintWindowSize: '1440,900',
                fingerprintStealthScript: false,
            },
        });
    });

    it('derives enhanced fingerprint profile for managed browser start', async () => {
        mockTauriCommand('browser_start', { status: 'connected' });
        browserSettingsValues.set(
            'browser_settings',
            JSON.stringify({
                fingerprintProfile: 'enhanced',
                fingerprintLocale: 'en-US',
                fingerprintTimezone: 'America/New_York',
            })
        );

        const result = await executeBrowserSessionTool(
            { operation: 'start', description: '启动增强指纹处理浏览器' },
            defaultBrowserConfig,
            fakeContext()
        );

        expect(result.isError).toBe(false);
        expect(getLastTauriInvokeCall('browser_start')?.payload).toEqual({
            request: {
                fingerprintMode: 'balanced',
                fingerprintLocale: 'en-US',
                fingerprintTimezone: 'America/New_York',
                fingerprintWindowSize: '1366,768',
                fingerprintStealthScript: true,
            },
        });
    });

    it('blocks browser actions when browser settings deny the target domain', async () => {
        mockTauriCommand('browser_navigate', { ok: true });
        browserSettingsValues.set(
            'browser_settings',
            JSON.stringify({
                blockedDomains: [{ domain: 'example.test' }],
                permissions: { navigate: 'allow' },
            })
        );

        const result = await executeBrowserActTool(
            {
                operation: 'navigate',
                description: '访问被禁止站点',
                url: 'https://example.test/private',
            },
            defaultBrowserConfig,
            fakeContext()
        );

        expect(result.isError).toBe(true);
        expect(result.result).toContain('domain-blocked');
        expect(getLastTauriInvokeCall('browser_navigate')).toBeUndefined();
    });

    it('reports when no existing browser session is discoverable', async () => {
        mockTauriCommand('browser_discover_existing', []);

        const result = await executeBrowserSessionTool(
            { operation: 'connect_existing', description: '连接当前浏览器' },
            defaultBrowserConfig,
            fakeContext()
        );

        expect(result.isError).toBe(true);
        expect(result.result).toContain('No connectable existing browser session was found');
    });

    it('discovers and connects an existing browser session after user selection', async () => {
        mockTauriCommand('browser_discover_existing', [
            {
                id: '127.0.0.1:9222',
                label: 'Google Chrome - github.com',
                endpoint: 'http://127.0.0.1:9222',
                browserName: 'Google Chrome',
                currentUrl: 'https://github.com',
                title: 'GitHub',
                tabs: [],
            },
        ]);
        mockTauriCommand('browser_connect_existing', {
            status: { status: 'connected', managed: false },
            session: { label: 'Google Chrome - github.com' },
        });

        const result = await executeBrowserSessionTool(
            { operation: 'connect_existing', description: 'Connect GitHub browser session' },
            defaultBrowserConfig,
            fakeContext()
        );

        expect(result.isError).toBe(false);
        expect(getLastTauriInvokeCall('browser_connect_existing')?.payload).toEqual({
            request: { endpoint: 'http://127.0.0.1:9222' },
        });
    });

    it('rejects hidden session operation aliases and raw attach/list operations', async () => {
        const listAlias = await executeBrowserSessionTool(
            { operation: 'list_browsers' },
            { mode: 'default', browserId: '', startupUrl: '' },
            fakeContext()
        );
        const connectAlias = await executeBrowserSessionTool(
            { operation: 'connect', endpoint: 'http://127.0.0.1:9222' },
            { mode: 'default', browserId: '', startupUrl: '' },
            fakeContext()
        );
        const list = await executeBrowserSessionTool(
            { operation: 'list' },
            { mode: 'default', browserId: '', startupUrl: '' },
            fakeContext()
        );
        const attach = await executeBrowserSessionTool(
            { operation: 'attach', endpoint: 'http://127.0.0.1:9222' },
            { mode: 'default', browserId: '', startupUrl: '' },
            fakeContext()
        );

        expect(listAlias.isError).toBe(true);
        expect(connectAlias.isError).toBe(true);
        expect(list.isError).toBe(true);
        expect(attach.isError).toBe(true);
        expect(listAlias.result).toContain('Unsupported browser_session operation');
        expect(connectAlias.result).toContain('Unsupported browser_session operation');
        expect(list.result).toContain('Unsupported browser_session operation');
        expect(attach.result).toContain('Unsupported browser_session operation');
    });

    it('routes page navigation through browser_act instead of browser_session', async () => {
        mockTauriCommand('browser_navigate', {
            ok: true,
            url: 'https://example.test/dashboard?token=secret#hash',
        });

        const result = await executeBrowserActTool(
            {
                operation: 'navigate',
                description: '访问仪表盘',
                url: 'https://example.test/dashboard?token=secret#hash',
            },
            defaultBrowserConfig,
            fakeContext()
        );

        expect(result.isError).toBe(false);
        expect(getLastTauriInvokeCall('browser_navigate')?.payload).toEqual({
            request: { url: 'https://example.test/dashboard?token=secret#hash' },
        });
        expect(result.result).toContain('https://example.test/dashboard');
        expect(result.result).not.toContain('token=secret');
    });

    it('normalizes current, tabs, and dom observe payloads', async () => {
        mockTauriCommand('browser_observe', { ok: true, tabId: 'tab-1' });

        await executeBrowserObserveTool(
            { operation: 'current', includeConsole: true, includeNetwork: false, tabId: 'tab-1' },
            defaultBrowserConfig,
            fakeContext()
        );
        expect(getLastTauriInvokeCall('browser_observe')?.payload).toEqual({
            request: {
                operation: 'state',
                tabId: 'tab-1',
                includeConsole: true,
                includeNetwork: false,
            },
        });

        await executeBrowserObserveTool({ operation: 'tabs' }, defaultBrowserConfig, fakeContext());
        expect(getLastTauriInvokeCall('browser_observe')?.payload).toEqual({
            request: { operation: 'state' },
        });

        await executeBrowserObserveTool(
            { operation: 'dom', description: '读取页面结构' },
            defaultBrowserConfig,
            fakeContext()
        );
        expect(getLastTauriInvokeCall('browser_observe')?.payload).toEqual({
            request: { operation: 'snapshot' },
        });
    });

    it('rejects unsupported observe operations before invoking native browser code', async () => {
        mockTauriCommand('browser_observe', { ok: true, tabId: 'tab-1' });

        const result = await executeBrowserObserveTool(
            { operation: 'console' },
            defaultBrowserConfig,
            fakeContext()
        );

        expect(result.isError).toBe(true);
        expect(result.result).toContain('Unsupported browser_observe operation');
        expect(getLastTauriInvokeCall('browser_observe')).toBeUndefined();
    });

    it('rejects missing observe operation and hidden observe fields before invoking native browser code', async () => {
        mockTauriCommand('browser_observe', { ok: true, tabId: 'tab-1' });

        const missingOperation = await executeBrowserObserveTool(
            { includeScreenshot: true },
            defaultBrowserConfig,
            fakeContext()
        );
        const hiddenScreenshot = await executeBrowserObserveTool(
            { operation: 'current', includeScreenshot: true },
            defaultBrowserConfig,
            fakeContext()
        );
        const ignoredHiddenScreenshot = await executeBrowserObserveTool(
            {
                operation: 'screenshot',
                description: '截取当前页面',
                includeScreenshot: false,
            },
            defaultBrowserConfig,
            fakeContext()
        );
        const hiddenDom = await executeBrowserObserveTool(
            { operation: 'dom', description: '读取页面结构', includeDom: false },
            defaultBrowserConfig,
            fakeContext()
        );

        expect(missingOperation.isError).toBe(true);
        expect(missingOperation.result).toContain('Missing required browser_observe operation');
        expect(hiddenScreenshot.isError).toBe(true);
        expect(hiddenScreenshot.result).toContain('browser_observe does not accept hidden field');
        expect(ignoredHiddenScreenshot.isError).toBe(true);
        expect(ignoredHiddenScreenshot.result).toContain(
            'browser_observe does not accept hidden field'
        );
        expect(hiddenDom.isError).toBe(true);
        expect(hiddenDom.result).toContain('browser_observe does not accept hidden field');
        expect(getLastTauriInvokeCall('browser_observe')).toBeUndefined();
    });

    it('passes stale ref payload fields through to the native act command', async () => {
        mockTauriCommand('browser_act', {
            ok: false,
            action: 'click',
            message: 'Browser ref is stale; observe again before acting',
        });

        const result = await executeBrowserActTool(
            {
                operation: 'click',
                description: '点击测试元素',
                ref: 'ref-1',
                refId: 'ref-1',
                navigationToken: 'old-token',
                tabId: 'tab-1',
            },
            defaultBrowserConfig,
            fakeContext()
        );

        expect(result.isError).toBe(false);
        expect(getLastTauriInvokeCall('browser_act')?.payload).toEqual({
            request: {
                action: 'click',
                ref: 'ref-1',
                refId: 'ref-1',
                navigationToken: 'old-token',
                tabId: 'tab-1',
            },
        });
        expect(result.result).toContain('stale');
    });

    it('routes observe through the tool instance and redacts observe errors', async () => {
        mockTauriCommand('browser_observe', () => {
            throw new Error(
                'console contained password=secret and https://example.test/?token=secret#hash'
            );
        });

        const result = await browserObserveTool.execute(
            { operation: 'current' },
            defaultBrowserConfig,
            fakeContext()
        );

        expect(result).toEqual(
            expect.objectContaining({
                isError: true,
                status: 'error',
            })
        );
        expect(result.result).toContain('https://example.test/');
        expect(result.result).not.toContain('password=secret');
        expect(result.result).not.toContain('token=secret');
    });

    it('passes supported action payload fields and drops invalid optional fields', async () => {
        mockTauriCommand('browser_act', { ok: true, action: 'fill_form' });

        const result = await browserActTool.execute(
            {
                operation: 'fill_form',
                description: '填写测试表单',
                tabId: '',
                ref: 'form-1',
                targetRef: 'form-1',
                navigationToken: 'obs-1',
                text: 'ignored text',
                value: 'ignored value',
                field: 'ignored field',
                fields: [
                    {
                        ref: 'email',
                        navigationToken: 'obs-1',
                        value: 'alice@example.test',
                        selector: '#email',
                    },
                    null,
                    'bad',
                ],
                key: 'Enter',
                deltaX: Number.POSITIVE_INFINITY,
                deltaY: 120,
                timeoutMs: 1000,
            },
            defaultBrowserConfig,
            fakeContext()
        );

        expect(result.isError).toBe(false);
        expect(getLastTauriInvokeCall('browser_act')?.payload).toEqual({
            request: {
                action: 'fill_form',
                ref: 'form-1',
                targetRef: 'form-1',
                navigationToken: 'obs-1',
                text: 'ignored text',
                value: 'ignored value',
                fields: [{ refId: 'email', navigationToken: 'obs-1', value: 'alice@example.test' }],
                key: 'Enter',
                deltaY: 120,
                timeoutMs: 1000,
            },
        });
    });

    it('rejects unsupported act operations before invoking native browser code', async () => {
        mockTauriCommand('browser_act', { ok: true, action: 'unknown' });

        const result = await executeBrowserActTool(
            { operation: 'unknown', ref: 'submit-button', navigationToken: 'obs-1' },
            defaultBrowserConfig,
            fakeContext()
        );

        expect(result.isError).toBe(true);
        expect(result.result).toContain('Unsupported browser_act operation');
        expect(getLastTauriInvokeCall('browser_act')).toBeUndefined();
    });

    it('rejects missing act operation before invoking native browser code', async () => {
        mockTauriCommand('browser_act', { ok: true, action: 'click' });

        const result = await executeBrowserActTool(
            { ref: 'submit-button', navigationToken: 'obs-1' },
            defaultBrowserConfig,
            fakeContext()
        );

        expect(result.isError).toBe(true);
        expect(result.result).toContain('Missing required browser_act operation');
        expect(getLastTauriInvokeCall('browser_act')).toBeUndefined();
    });

    it('preserves valid form field arrays for native fill_form actions', async () => {
        mockTauriCommand('browser_act', { ok: true, action: 'fill_form' });

        await executeBrowserActTool(
            {
                operation: 'fill_form',
                description: '填写测试表单',
                fields: [
                    { ref: 'email', navigationToken: 'obs-1', value: 'alice@example.test' },
                    { ref: 'password', navigationToken: 'obs-1', value: 'secret' },
                ],
            },
            defaultBrowserConfig,
            fakeContext()
        );

        expect(getLastTauriInvokeCall('browser_act')?.payload).toEqual({
            request: {
                action: 'fill_form',
                fields: [
                    { refId: 'email', navigationToken: 'obs-1', value: 'alice@example.test' },
                    { refId: 'password', navigationToken: 'obs-1', value: 'secret' },
                ],
            },
        });
    });

    it('preserves empty and whitespace text values for native typing actions', async () => {
        mockTauriCommand('browser_act', { ok: true, action: 'fill' });

        await executeBrowserActTool(
            {
                operation: 'fill',
                description: '填写测试字段',
                ref: 'input-1',
                navigationToken: 'obs-1',
                value: '',
            },
            defaultBrowserConfig,
            fakeContext()
        );
        expect(getLastTauriInvokeCall('browser_act')?.payload).toEqual({
            request: {
                action: 'fill',
                ref: 'input-1',
                navigationToken: 'obs-1',
                value: '',
            },
        });

        await executeBrowserActTool(
            {
                operation: 'type',
                description: '输入测试文本',
                ref: 'editor',
                navigationToken: 'obs-1',
                text: '   ',
            },
            defaultBrowserConfig,
            fakeContext()
        );
        expect(getLastTauriInvokeCall('browser_act')?.payload).toEqual({
            request: {
                action: 'type',
                ref: 'editor',
                navigationToken: 'obs-1',
                text: '   ',
            },
        });
    });

    it('returns redacted error results when native commands fail', async () => {
        mockTauriCommand('browser_navigate', () => {
            throw new Error(
                'navigation failed with token=secret at https://example.test/path?token=secret#hash'
            );
        });

        const result = await executeBrowserActTool(
            {
                operation: 'navigate',
                description: '访问错误页面',
                url: 'https://example.test/path?token=secret#hash',
            },
            defaultBrowserConfig,
            fakeContext()
        );

        expect(result).toEqual(
            expect.objectContaining({
                isError: true,
                status: 'error',
            })
        );
        expect(result.result).toContain('Browser tool failed');
        expect(result.result).toContain('https://example.test/path');
        expect(result.result).not.toContain('token=secret');
        expect(result.result).not.toContain('#hash');
    });

    it('routes history actions to native commands and rejects screenshot as an action', async () => {
        mockTauriCommand('browser_back', { ok: true });
        mockTauriCommand('browser_forward', { ok: true });
        mockTauriCommand('browser_reload', { ok: true });
        mockTauriCommand('browser_observe', { screenshotBase64: 'SECRET', mimeType: 'image/png' });

        await executeBrowserActTool(
            { operation: 'back', description: '返回上一页', tabId: 'tab-1' },
            defaultBrowserConfig,
            fakeContext()
        );
        await executeBrowserActTool(
            { operation: 'forward', description: '前进下一页', tabId: 'tab-1' },
            defaultBrowserConfig,
            fakeContext()
        );
        await executeBrowserActTool(
            { operation: 'reload', description: '刷新当前页面', tabId: 'tab-1' },
            defaultBrowserConfig,
            fakeContext()
        );
        const screenshot = await executeBrowserActTool(
            { operation: 'screenshot', description: '截取当前页面', tabId: 'tab-1' },
            defaultBrowserConfig,
            fakeContext()
        );

        expect(getLastTauriInvokeCall('browser_back')?.payload).toEqual({
            request: { tabId: 'tab-1' },
        });
        expect(getLastTauriInvokeCall('browser_forward')?.payload).toEqual({
            request: { tabId: 'tab-1' },
        });
        expect(getLastTauriInvokeCall('browser_reload')?.payload).toEqual({
            request: { tabId: 'tab-1' },
        });
        expect(getLastTauriInvokeCall('browser_observe')).toBeUndefined();
        expect(screenshot.isError).toBe(true);
        expect(screenshot.result).toContain('Unsupported browser_act operation');
    });

    it('suppresses screenshot base64 in model-visible output', async () => {
        mockTauriCommand('browser_observe', {
            operation: 'screenshot',
            mimeType: 'image/png',
            screenshotBase64: 'SCREENSHOTBASE64SECRET',
            base64: 'iVBORw0KGgoAAAANSUhEUgAAASECRET',
            width: 800,
            height: 600,
        });

        const result = await executeBrowserObserveTool(
            { operation: 'screenshot', description: '截取当前页面' },
            defaultBrowserConfig,
            fakeContext()
        );

        expect(result.isError).toBe(false);
        expect(result.result).toContain('screenshot');
        expect(result.result).toContain('base64 suppressed');
        expect(result.result).not.toContain('iVBORw0KGgoAAAANSUhEUgAAASECRET');
        expect(result.result).not.toContain('SCREENSHOTBASE64SECRET');
        expect(result.attachments).toBeUndefined();
    });

    it('strips screenshot payload fields from generic observe output', async () => {
        mockTauriCommand('browser_observe', {
            operation: 'state',
            status: { status: 'connected' },
            screenshotBase64: 'SCREENSHOTBASE64SECRET',
            screenshot_base64: 'ANOTHERSECRET',
            dataUrl: 'data:image/png;base64,DATAURLSECRET',
        });

        const result = await executeBrowserObserveTool(
            { operation: 'current' },
            defaultBrowserConfig,
            fakeContext()
        );

        expect(result.result).toContain('"status"');
        expect(result.result).not.toContain('SCREENSHOTBASE64SECRET');
        expect(result.result).not.toContain('ANOTHERSECRET');
        expect(result.result).not.toContain('DATAURLSECRET');
        expect(result.result).not.toContain('screenshotBase64');
        expect(result.result).not.toContain('screenshot_base64');
        expect(result.result).not.toContain('dataUrl');
    });

    it('returns a real image attachment when screenshot response includes a file path', async () => {
        mockTauriCommand('browser_observe', {
            operation: 'screenshot',
            url: 'https://example.test/releases',
            filePath: 'D:/TouchAI/screenshots/browser-shot.png',
            screenshotBase64: 'SCREENSHOTBASE64SECRET',
            mimeType: 'image/png',
            width: 800,
            height: 600,
        });

        const result = await executeBrowserObserveTool(
            { operation: 'screenshot', description: '截取当前页面' },
            defaultBrowserConfig,
            fakeContext()
        );

        expect(result.result).toContain('D:/TouchAI/screenshots/browser-shot.png');
        expect(result.result).toContain('url: https://example.test/releases');
        expect(result.result).toContain(
            'markdown: ![Browser screenshot of https://example.test/releases]('
        );
        expect(result.result).toContain('asset.localhost');
        expect(result.result).not.toContain('SCREENSHOTBASE64SECRET');
        expect(result.attachments).toEqual([
            expect.objectContaining({
                type: 'image',
                path: 'D:/TouchAI/screenshots/browser-shot.png',
                originPath: 'D:/TouchAI/screenshots/browser-shot.png',
                mimeType: 'image/png',
                supportStatus: 'supported',
            }),
        ]);
    });

    it('formats screenshot response aliases and non-record responses safely', () => {
        const screenshot = formatBrowserToolResult('screenshot', {
            path: 'G:\\TouchAI\\browser\\shot.jpeg',
            mime_type: 'image/jpeg',
            data_url: 'data:image/jpeg;base64,SECRET',
        });

        expect(screenshot.result).toContain('G:\\TouchAI\\browser\\shot.jpeg');
        expect(screenshot.result).toContain('unknown dimensions');
        expect(screenshot.result).not.toContain('SECRET');
        expect(screenshot.attachments?.[0]).toEqual(
            expect.objectContaining({
                name: 'shot.jpeg',
                mimeType: 'image/jpeg',
            })
        );

        const text = formatBrowserToolResult('status', 'https://example.test/?token=secret#hash');
        expect(text.result).toBe('"https://example.test/"');
    });

    it('strips runtime implementation details from model-visible status output', () => {
        const status = formatBrowserToolResult('status', {
            status: 'connected',
            endpoint: 'http://127.0.0.1:50123',
            activeTabId: 'tab-1',
        });

        expect(status.result).toContain('"status": "connected"');
        expect(status.result).toContain('"activeTabId": "tab-1"');
        expect(status.result).not.toContain('endpoint');
        expect(status.result).not.toContain('50123');
    });

    it('formats screenshot metadata without dimensions, base64, or filename', () => {
        const screenshot = formatBrowserToolResult('screenshot', {
            file_path: 'G:\\TouchAI\\browser\\',
            width: 320,
        });

        expect(screenshot.result).toContain('unknown dimensions');
        expect(screenshot.result).not.toContain('base64 suppressed');
        expect(screenshot.attachments?.[0]).toEqual(
            expect.objectContaining({
                name: 'browser-screenshot.png',
                mimeType: 'image/png',
            })
        );
    });
});
