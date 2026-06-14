import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDefaultSearchKeybindings } from '@/config/searchKeybindings';
import { setLocale } from '@/i18n';
import {
    buildSettingApprovalRequest,
    executeSettingTool,
    settingTool,
} from '@/services/BuiltInToolService/tools/setting';
import { SETTING_TOOL_INPUT_SCHEMA } from '@/services/BuiltInToolService/tools/setting/constants';
import {
    formatShortcutRegistrationError,
    formatSingleUpdate,
    getSettings,
    listSupportedSettings,
    parseSettingRequest,
} from '@/services/BuiltInToolService/tools/setting/helper';

const {
    mockSettingsStore,
    mockRegisterGlobalShortcut,
    mockUpdateGlobalShortcut,
    mockUpdateLanguage,
} = vi.hoisted(() => {
    const mockUpdateGlobalShortcut = vi.fn();
    const mockUpdateLanguage = vi.fn();
    return {
        mockRegisterGlobalShortcut: vi.fn(),
        mockUpdateGlobalShortcut,
        mockUpdateLanguage,
        mockSettingsStore: {
            settings: {
                globalShortcut: 'Alt+Space',
                searchKeybindings: {},
                startOnBoot: false,
                startMinimized: true,
                outputScrollBehavior: 'follow_output',
                searchWindowSizePreset: 'normal',
                language: 'zh-CN',
            },
            initialize: vi.fn(async () => undefined),
            updateGlobalShortcut: mockUpdateGlobalShortcut,
            updateStartOnBoot: vi.fn(),
            updateStartMinimized: vi.fn(),
            updateOutputScrollBehavior: vi.fn(),
            updateSearchWindowSizePreset: vi.fn(),
            updateLanguage: mockUpdateLanguage,
        },
    };
});

vi.mock('@/stores/settings', () => ({
    useSettingsStore: () => mockSettingsStore,
}));

vi.mock('@services/NativeService', () => ({
    native: {
        autostart: {
            isAutostartEnabled: vi.fn(async () => true),
        },
        shortcut: {
            registerGlobalShortcut: mockRegisterGlobalShortcut,
        },
        window: {
            setSearchWindowDefaults: vi.fn(),
        },
    },
}));

const settingsStore = {
    settings: {
        globalShortcut: 'Alt+Space',
        searchKeybindings: {},
        startOnBoot: false,
        startMinimized: true,
        outputScrollBehavior: 'follow_output',
        searchWindowSizePreset: 'normal',
        language: 'zh-CN',
    },
} as never;

function createExecutionContext(): Parameters<typeof executeSettingTool>[2] {
    return {
        signal: new AbortController().signal,
        callId: 'setting-call',
        iteration: 1,
        hasExecutedBuiltInTool: vi.fn(() => false),
    };
}

describe('Setting built-in tool i18n', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockRegisterGlobalShortcut.mockResolvedValue(undefined);
        mockUpdateGlobalShortcut.mockResolvedValue(undefined);
        mockUpdateLanguage.mockResolvedValue(undefined);
        mockSettingsStore.settings.globalShortcut = 'Alt+Space';
        mockSettingsStore.settings.searchKeybindings = createDefaultSearchKeybindings();
        mockSettingsStore.settings.language = 'zh-CN';
    });

    it('formats list and get outputs in English when active locale is English', async () => {
        setLocale('en-US');

        const listOutput = await listSupportedSettings(settingsStore);
        const getOutput = await getSettings(settingsStore, ['global_shortcut']);

        expect(listOutput).toContain('Available settings');
        expect(listOutput).toContain('Global shortcut');
        expect(listOutput).toContain('Current value');
        expect(listOutput).toContain('Description');
        expect(getOutput).toContain('Current setting values');
        expect(getOutput).toContain('Global shortcut (global_shortcut): Alt+Space');
    });

    it('formats setting updates, approval cards, and registration errors in English', () => {
        setLocale('en-US');

        expect(formatSingleUpdate('start_minimized', true)).toBe(
            '1. Start minimized (start_minimized): true'
        );
        expect(formatShortcutRegistrationError('Alt+Space', 'already registered')).toBe(
            'Shortcut Alt+Space is already used by another app.'
        );
        expect(formatShortcutRegistrationError('Alt+Space', 'invalid shortcut')).toBe(
            'Shortcut Alt+Space has an invalid format.'
        );
        expect(formatShortcutRegistrationError('Alt+Space', 'Unknown key')).toBe(
            'Shortcut contains an unsupported key.'
        );
        expect(formatShortcutRegistrationError('Alt+Space', 'system error')).toBe(
            'Failed to register shortcut: system error'
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

    it('formats conversation semantics in English', () => {
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

    it('formats failed setting updates and successful rollback in English', async () => {
        setLocale('en-US');
        mockRegisterGlobalShortcut.mockRejectedValueOnce(new Error('invalid shortcut'));
        mockRegisterGlobalShortcut.mockResolvedValueOnce(undefined);

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
            errorMessage: 'Shortcut Alt+Shift+Space has an invalid format.',
        });
        expect(result.result).toContain('Setting update failed');
        expect(result.result).toContain(
            'Tried to restore the setting value from before execution.'
        );
    });

    it('rejects global shortcuts that duplicate search shortcuts before registration', async () => {
        setLocale('en-US');
        mockSettingsStore.settings.searchKeybindings = {
            ...createDefaultSearchKeybindings(),
            'search.history.open': 'Mod+K',
        };

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
        expect(mockRegisterGlobalShortcut).not.toHaveBeenCalledWith('Ctrl+K');
    });

    it('formats failed rollback in English', async () => {
        setLocale('en-US');
        mockRegisterGlobalShortcut
            .mockRejectedValueOnce(new Error('invalid shortcut'))
            .mockRejectedValueOnce(new Error('rollback failed'));

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

        expect(result.isError).toBe(true);
        expect(result.result).toContain(
            'Restore failed: Failed to register shortcut: Error: rollback failed'
        );
    });

    it('exposes language in list, get, schema, approval, and set flows', async () => {
        setLocale('en-US');

        const listOutput = await listSupportedSettings(settingsStore);
        const getOutput = await getSettings(settingsStore, ['language' as never]);
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
        expect(mockUpdateLanguage).toHaveBeenCalledWith('en-US');
    });

    it('localizes invalid setting values while preserving validation details', () => {
        setLocale('en-US');

        expect(() =>
            parseSettingRequest({
                action: 'set',
                key: 'start_minimized',
                value: 'yes',
                reason: 'User asked for it.',
            })
        ).toThrow(/Setting tool received an invalid value for "start_minimized"\.\n- /);
    });
});
