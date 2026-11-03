import { createSettingsBus, type SettingsBus } from '@tests/utils/settingsTransport';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDefaultSearchKeybindings } from '@/config/searchKeybindings';
import { getLocale, setLocale } from '@/i18n';
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
import { setActiveSettingsService } from '@/services/SettingsService';
import { replyErrorMessage, unknownKeyMessage } from '@/services/SettingsService/messages';
import { SettingsService } from '@/services/SettingsService/service';
import { SettingsErrorCode } from '@/services/SettingsService/types';

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

    it('user reads setting updates, approval cards, and registration errors in English', () => {
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
            errorMessage: 'Shortcut Alt+Shift+Space has an invalid format.',
        });
        expect(result.result).toContain('Setting update failed');
        expect(service.getSnapshot().globalShortcut).toBe('Alt+Space');
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

        expect(() =>
            parseSettingRequest({
                action: 'set',
                key: 'start_minimized',
                value: 'yes',
                reason: 'User asked for it.',
            })
        ).toThrow(/Setting tool received an invalid value for "start_minimized"\.\n- /);
    });

    it('user reads unknown-key and owner-reply messages in English', async () => {
        setLocale('en-US');

        expect(unknownKeyMessage('not_a_setting')).toBe('Unsupported setting key: not_a_setting');
        expect(replyErrorMessage(SettingsErrorCode.NotReady)).toBe(
            'Settings are not ready yet; try again in a moment.'
        );
        expect(replyErrorMessage(SettingsErrorCode.StaleEpoch)).toBe(
            'Settings result unknown: the response came from a superseded settings owner.'
        );
        expect(replyErrorMessage(SettingsErrorCode.OwnerDisposed)).toBe(
            'The settings owner was closed.'
        );
        expect(replyErrorMessage(SettingsErrorCode.TooManyPending)).toBe(
            'Too many settings requests. Try again later.'
        );
        expect(replyErrorMessage('something-unknown')).toBe('The settings owner is unavailable.');
    });

    it('user sees a note when a setting saved but syncing to other windows failed', async () => {
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
        expect(result.result).toContain('Note');
        expect(result.result).toContain('syncing to other windows failed');
    });
});
