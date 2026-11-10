import { createSettingsBus, type SettingsBus } from '@tests/utils/settingsTransport';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDefaultSearchKeybindings } from '@/config/searchKeybindings';
import { getLocale, setLocale } from '@/i18n';
import { resolveToolFailure } from '@/services/BuiltInToolService/errors';
import {
    buildSettingApprovalRequest,
    executeSettingTool,
    settingTool,
} from '@/services/BuiltInToolService/tools/setting';
import { SETTING_TOOL_INPUT_SCHEMA } from '@/services/BuiltInToolService/tools/setting/constants';
import {
    formatSingleUpdate,
    getSettings,
    listSupportedSettings,
    parseSettingRequest,
} from '@/services/BuiltInToolService/tools/setting/helper';
import { setActiveSettingsService } from '@/services/SettingsService';
import { SettingsService } from '@/services/SettingsService/service';

const originalPlatform = navigator.platform;

function setPlatform(platform: string) {
    Object.defineProperty(window.navigator, 'platform', {
        configurable: true,
        value: platform,
    });
}

const dbMock = vi.hoisted(() => ({
    values: new Map<string, string | null>(),
}));

const nativeMock = vi.hoisted(() => ({
    registerGlobalShortcut: vi.fn(),
}));

vi.mock('@database/queries', () => ({
    getSettingValue: vi.fn(async ({ key }: { key: string }) => dbMock.values.get(key) ?? null),
    getSettingValues: vi.fn(async ({ keys }: { keys: string[] }) =>
        Object.fromEntries(keys.map((key) => [key, dbMock.values.get(key) ?? null]))
    ),
    setSetting: vi.fn(async ({ key, value }: { key: string; value: string }) => {
        dbMock.values.set(key, value);
        return { id: 1, key, value, created_at: '', updated_at: '' };
    }),
}));

vi.mock('@services/NativeService', () => ({
    native: {
        autostart: {
            isAutostartEnabled: vi.fn(async () => false),
            enableAutostart: vi.fn(async () => undefined),
            disableAutostart: vi.fn(async () => undefined),
        },
        shortcut: {
            registerGlobalShortcut: nativeMock.registerGlobalShortcut,
        },
        window: {
            setSearchWindowDefaults: vi.fn(async () => undefined),
        },
    },
}));

function createExecutionContext(): Parameters<typeof executeSettingTool>[2] {
    return {
        signal: new AbortController().signal,
        callId: 'setting-call',
        iteration: 1,
    };
}

describe('user changes app settings through the assistant', () => {
    let service: SettingsService;
    let bus: SettingsBus;

    beforeEach(async () => {
        vi.clearAllMocks();
        setPlatform('Win32');
        dbMock.values.clear();
        nativeMock.registerGlobalShortcut.mockResolvedValue(undefined);
        bus = createSettingsBus();
        service = new SettingsService({ transport: bus.transport('main') });
        setActiveSettingsService(service);
        await service.initialize();
    });

    afterEach(() => {
        setActiveSettingsService(null);
        setPlatform(originalPlatform);
    });

    it('user reads setting list and get results in English', async () => {
        setLocale('en-US');

        const listOutput = await listSupportedSettings(service);
        const getOutput = await getSettings(service, ['global_shortcut']);

        expect(listOutput).toContain('Available settings');
        expect(listOutput).toContain('Global shortcut');
        expect(listOutput).toContain('Current value');
        expect(listOutput).toContain('Description');
        expect(getOutput).toContain('Current setting values');
        expect(getOutput).toContain('Global shortcut (global_shortcut): Alt+Space');
    });

    it('user reads setting updates and approval cards in English', () => {
        setLocale('en-US');

        expect(formatSingleUpdate('start_minimized', true)).toBe(
            '1. Start minimized (start_minimized): true'
        );
        const approval = buildSettingApprovalRequest({
            action: 'set',
            key: 'start_minimized',
            value: true,
            reason: 'User asked for it.',
        });

        expect(approval).toMatchObject({
            title: 'Confirm setting change',
            command: '1. Start minimized (start_minimized): true',
            reason: 'This operation changes TouchAI application settings and affects future behavior immediately.',
            approveLabel: 'Approve',
            rejectLabel: 'Reject',
        });
    });

    it('user reads setting conversation summaries in English', () => {
        setLocale('en-US');

        expect(settingTool.buildConversationSemantic({ action: 'list' })).toMatchObject({
            action: 'read',
            target: 'Available settings',
        });
        expect(
            settingTool.buildConversationSemantic({
                action: 'get',
                keys: ['global_shortcut', 'start_minimized'],
            })
        ).toMatchObject({
            action: 'read',
            target: 'Global shortcut, Start minimized',
        });
        expect(settingTool.buildConversationSemantic({ action: 'bogus' })).toMatchObject({
            action: 'process',
            target: 'Application settings',
        });
    });

    it('user reads a failed setting update when the shortcut cannot be registered', async () => {
        setLocale('en-US');
        nativeMock.registerGlobalShortcut.mockRejectedValueOnce(new Error('invalid shortcut'));

        const result = await executeSettingTool(
            {
                action: 'set',
                key: 'global_shortcut',
                value: 'Alt+Shift+Space',
                reason: 'User asked for it.',
            },
            {},
            createExecutionContext()
        );

        expect(result).toMatchObject({
            isError: true,
            status: 'error',
            errorMessage: 'Setting update failed.',
        });
        expect(result.result).toContain('Setting update failed');
        expect(result.result).not.toContain('invalid shortcut');
        expect(result.result).not.toContain('owner');
        expect(service.getSnapshot().globalShortcut).toBe('Alt+Space');
    });

    it('user reads an unconfirmed setting update without being told it failed', async () => {
        setLocale('en-US');
        vi.spyOn(service, 'mutate').mockResolvedValueOnce({
            status: 'unknown',
            key: 'start_minimized',
            code: SettingsErrorCode.Timeout,
            message: 'Settings result unknown: re-check settings before retrying.',
        });

        const result = await executeSettingTool(
            {
                action: 'set',
                key: 'start_minimized',
                value: false,
                reason: 'User asked for it.',
            },
            {},
            createExecutionContext()
        );

        expect(result).toMatchObject({
            isError: true,
            status: 'error',
            errorMessage: 'Settings result unknown: re-check settings before retrying.',
        });
        expect(result.result).toContain('Settings result unknown');
        expect(result.result).not.toContain('Setting update failed');
    });

    it('user cancels while the settings owner initializes and no setting is written', async () => {
        setLocale('en-US');
        const controller = new AbortController();
        const initialize = vi.spyOn(service, 'initialize').mockImplementation(async () => {
            controller.abort();
        });
        const mutate = vi.spyOn(service, 'mutate');

        const result = await executeSettingTool(
            {
                action: 'set',
                key: 'start_minimized',
                value: true,
                reason: 'User asked for it.',
            },
            {},
            {
                ...createExecutionContext(),
                signal: controller.signal,
            }
        );

        expect(initialize).toHaveBeenCalledTimes(1);
        expect(mutate).not.toHaveBeenCalled();
        expect(result).toMatchObject({
            isError: true,
            status: 'error',
            errorMessage: 'Request cancelled',
        });
    });

    it('user sees the real committed result when cancellation arrives after the write starts', async () => {
        setLocale('en-US');
        const controller = new AbortController();
        const mutate = vi.spyOn(service, 'mutate').mockImplementation(async (key, value) => {
            controller.abort();
            return {
                status: 'committed',
                key,
                value,
                revision: service.getRevision() + 1,
            };
        });

        const result = await executeSettingTool(
            {
                action: 'set',
                key: 'start_minimized',
                value: false,
                reason: 'User asked for it.',
            },
            {},
            {
                ...createExecutionContext(),
                signal: controller.signal,
            }
        );

        expect(mutate).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject({
            isError: false,
            status: 'success',
        });
        expect(result.result).toContain('Setting updated');
    });

    it('user sees a shortcut that duplicates a search shortcut rejected before registration', async () => {
        setLocale('en-US');
        dbMock.values.set(
            'search_keybindings',
            JSON.stringify({
                ...createDefaultSearchKeybindings(),
                'search.history.open': 'Mod+K',
            })
        );
        const bus = createSettingsBus();
        service = new SettingsService({ transport: bus.transport('main') });
        setActiveSettingsService(service);
        await service.initialize();

        const result = await executeSettingTool(
            {
                action: 'set',
                key: 'global_shortcut',
                value: 'Ctrl+K',
                reason: 'User asked for it.',
            },
            {},
            createExecutionContext()
        );

        expect(result).toMatchObject({
            isError: true,
            status: 'error',
        });
        expect(result.errorMessage).toContain('Open session history');
        expect(nativeMock.registerGlobalShortcut).not.toHaveBeenCalledWith('Ctrl+K');
    });

    it('user sees a macOS system-reserved shortcut rejected before registration', async () => {
        setLocale('en-US');
        setPlatform('MacIntel');

        const result = await executeSettingTool(
            {
                action: 'set',
                key: 'global_shortcut',
                value: 'Cmd+Space',
                reason: 'User asked for it.',
            },
            {},
            createExecutionContext()
        );

        expect(result).toMatchObject({
            isError: true,
            status: 'error',
        });
        expect(result.errorMessage).toContain('macOS');
        expect(nativeMock.registerGlobalShortcut).not.toHaveBeenCalledWith('Cmd+Space');
    });

    it('user sees the language setting exposed in list, get, schema, approval, and set flows', async () => {
        setLocale('en-US');
        // A fresh install defaults to the first-launch locale; pin the persisted value so
        // the read path is deterministic instead of depending on the test host locale.
        dbMock.values.set('language', 'zh-CN');
        await service.refresh();

        const listOutput = await listSupportedSettings(service);
        const getOutput = await getSettings(service, ['language']);
        const keyProperty = SETTING_TOOL_INPUT_SCHEMA.properties?.key;
        const keysProperty = SETTING_TOOL_INPUT_SCHEMA.properties?.keys;

        expect(listOutput).toContain('Language');
        expect(getOutput).toContain('Language (language): zh-CN');
        expect(keyProperty).toMatchObject({
            enum: expect.arrayContaining(['language']),
        });
        expect(keysProperty).toMatchObject({
            items: {
                enum: expect.arrayContaining(['language']),
            },
        });
        expect(
            buildSettingApprovalRequest({
                action: 'set',
                key: 'language',
                value: 'en-US',
                reason: 'User asked for English UI.',
            })
        ).toMatchObject({
            command: '1. Language (language): en-US',
        });

        const result = await executeSettingTool(
            {
                action: 'set',
                key: 'language',
                value: 'en-US',
                reason: 'User asked for English UI.',
            },
            {},
            createExecutionContext()
        );

        expect(result).toMatchObject({
            isError: false,
            status: 'success',
        });
        expect(service.getSnapshot().language).toBe('en-US');
        expect(getLocale()).toBe('en-US');
    });

    it('user reads invalid setting values in the active language with validation details kept', () => {
        setLocale('en-US');

        const error = (() => {
            try {
                return parseSettingRequest({
                    action: 'set',
                    key: 'start_minimized',
                    value: 'yes',
                    reason: 'User asked for it.',
                });
            } catch (caught) {
                return caught;
            }
        })();
        const failure = resolveToolFailure(error, {
            toolId: 'setting',
            fallbackMessage: 'Tool execution failed',
        });

        expect(failure).toMatchObject({ status: 'error' });
        expect(failure.message).toMatch(
            /Setting tool received an invalid value for "start_minimized"\.\n- /
        );
        expect(failure.message).not.toBe('Tool execution failed');
    });

    it('user sees success without an internal sync note when cross-window notification fails', async () => {
        setLocale('en-US');
        bus.failNotices = true;

        const result = await executeSettingTool(
            {
                action: 'set',
                key: 'start_minimized',
                value: false,
                reason: 'User asked for it.',
            },
            {},
            createExecutionContext()
        );
        bus.failNotices = false;

        expect(result).toMatchObject({
            isError: false,
            status: 'success',
        });
        expect(result.result).not.toContain('Note');
        expect(result.result).not.toContain('sync');
    });
});
