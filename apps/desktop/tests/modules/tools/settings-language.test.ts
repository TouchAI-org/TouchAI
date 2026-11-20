import { createAgentWindowFixture, network, response } from '@tests/utils/agentWindow';
import { getTauriInvokeCalls, mockTauriCommand } from '@tests/utils/tauri';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { selectToolCalls } from '@/app/api/agent/history';
import { formatShortcutRegistrationError, replyErrorMessage } from '@/app/api/settings/messages';
import { SettingsErrorCode } from '@/app/api/settings/preferences';
import { createDefaultSearchKeybindings } from '@/config/searchKeybindings';
import { getLocale, setLocale, t, tt } from '@/i18n';
import { createSettingTools } from '@/modules/tools';

const originalPlatform = navigator.platform;
let fixture: ReturnType<typeof createAgentWindowFixture>;
let failSettingsIO = false;
let failNotice = false;

function setPlatform(value: string) {
    Object.defineProperty(navigator, 'platform', { configurable: true, value });
}

beforeEach(async () => {
    failSettingsIO = false;
    failNotice = false;
    setPlatform('Win32');
    fixture = createAgentWindowFixture('main', undefined, {
        beforeQuery({ sql, params }) {
            if (
                failSettingsIO &&
                sql.includes('"settings"') &&
                params.includes('start_minimized')
            ) {
                throw new Error('private-storage-marker and owner details');
            }
        },
        aroundInvoke(call, next) {
            const payload = call.payload as
                | { event?: string; payload?: { type?: string } }
                | undefined;
            if (
                failNotice &&
                call.cmd === 'plugin:event|emit' &&
                payload?.event === 'settings:command' &&
                payload.payload?.type === 'change'
            ) {
                throw new Error('fixture event delivery unavailable');
            }
            return next();
        },
    });
    mockTauriCommand('is_autostart_enabled', false);
    await fixture.window.ready;
    await fixture.window.settings.initialize();
    setLocale('en-US');
});

afterEach(async () => {
    failSettingsIO = false;
    failNotice = false;
    await fixture.window.dispose();
    setPlatform(originalPlatform);
});

async function settingCommand(args: Record<string, unknown>, approve = args.action === 'set') {
    network.replies.push(
        response('', false, {
            name: 'builtin__setting',
            arguments: JSON.stringify(args),
        }),
        response('setting command finished')
    );
    const task = await fixture.window.api.startTask({
        prompt: 'manage the requested application preference',
    });
    if (approve) {
        await expect
            .poll(() => fixture.window.api.getTaskSnapshot(task.taskId)?.pendingToolApproval)
            .toBeTruthy();
        const approval = fixture.window.api.getTaskSnapshot(task.taskId)!.pendingToolApproval!;
        expect(
            fixture.window.api.approveTaskToolCall(
                task.taskId,
                approval.callId,
                approval.decisionId
            )
        ).toBe(true);
    }
    return task;
}

function callResult(taskId: string) {
    return fixture.window.api
        .getTaskSnapshot(taskId)!
        .sessionHistory.flatMap(selectToolCalls)
        .find((call) => call.namespacedName === 'builtin__setting')!;
}

function descriptor() {
    return createSettingTools({
        messages: {
            t: (key, values) => t(key as Parameters<typeof t>[0], values),
            tt,
        },
        settings: {
            async read(key) {
                const value = await fixture.window.settings.readEffectiveValue(key);
                if (
                    typeof value !== 'string' &&
                    typeof value !== 'number' &&
                    typeof value !== 'boolean'
                ) {
                    throw new Error('unsupported fixture preference');
                }
                return value;
            },
            mutate: fixture.window.settings.mutate,
        },
    })[0]!;
}

describe('given assistant settings commands use the real main writer and unified execution path', () => {
    it('user reads the setting list and committed shortcut value in English', async () => {
        const listed = await settingCommand({ action: 'list' }, false);
        await listed.completion;
        expect(callResult(listed.taskId).result).toMatch(
            /Available settings[\s\S]*Global shortcut[\s\S]*Current value[\s\S]*Description/
        );
        const current = await settingCommand({ action: 'get', keys: ['global_shortcut'] }, false);
        await current.completion;
        expect(callResult(current.taskId).result).toContain('Current setting values');
        expect(callResult(current.taskId).result).toContain(
            'Global shortcut (global_shortcut): Alt+Space'
        );
    });

    it('user reads localized update approval and the same settings conversation summaries', () => {
        const tool = descriptor();
        expect(
            tool.buildApprovalRequest(
                { action: 'set', key: 'start_minimized', value: true, reason: 'Requested change' },
                tool.defaultConfig,
                'builtin__setting',
                { callId: 'approval', iteration: 0 }
            )
        ).toMatchObject({
            title: 'Confirm setting change',
            command: '1. Start minimized (start_minimized): true',
            reason: 'This operation changes TouchAI application settings and affects future behavior immediately.',
            approveLabel: 'Approve',
            rejectLabel: 'Reject',
        });
        expect(tool.buildConversationSemantic({ action: 'list' })).toMatchObject({
            action: 'read',
            target: 'Available settings',
        });
        expect(
            tool.buildConversationSemantic({
                action: 'get',
                keys: ['global_shortcut', 'start_minimized'],
            })
        ).toMatchObject({ action: 'read', target: 'Global shortcut, Start minimized' });
        expect(tool.buildConversationSemantic({ action: 'bogus' })).toMatchObject({
            action: 'process',
            target: 'Application settings',
        });
    });

    it.each([
        ['already registered', 'Shortcut Alt+Space is already used by another app.'],
        ['invalid shortcut', 'Shortcut Alt+Space has an invalid format.'],
        ['Unknown key', 'Shortcut contains an unsupported key.'],
        ['system error', 'Failed to register shortcut: system error'],
    ])(
        'user reads stable shortcut failure wording when registration reports %s',
        (error, message) => {
            expect(formatShortcutRegistrationError('Alt+Space', error)).toBe(message);
        }
    );

    it('user sees registration failure and the previous committed shortcut remains usable', async () => {
        mockTauriCommand('register_global_shortcut', ({ shortcut }: { shortcut: string }) => {
            if (shortcut === 'Alt+Shift+Space') throw new Error('invalid shortcut');
        });
        const task = await settingCommand({
            action: 'set',
            key: 'global_shortcut',
            value: 'Alt+Shift+Space',
            reason: 'Requested change',
        });
        await task.completion;
        expect(callResult(task.taskId)).toMatchObject({
            isError: true,
            result: expect.stringContaining('Shortcut Alt+Shift+Space has an invalid format.'),
        });
        expect(fixture.window.settings.getSnapshot().globalShortcut).toBe('Alt+Space');
        expect(
            fixture.database
                .prepare('SELECT value FROM settings WHERE key = ?')
                .get('global_shortcut')
        ).toEqual({ value: 'Alt+Space' });
    });

    it('user sees an unconfirmed storage effect without private details or automatic replay', async () => {
        failSettingsIO = true;
        const task = await settingCommand({
            action: 'set',
            key: 'start_minimized',
            value: false,
            reason: 'Requested change',
        });
        await expect(task.completion).rejects.toMatchObject({ code: 'SIDE_EFFECT_UNCERTAIN' });
        expect(callResult(task.taskId)).toMatchObject({
            isError: true,
            result: expect.stringContaining(
                'The setting result is unconfirmed. Re-check settings before retrying.'
            ),
        });
        expect(callResult(task.taskId).result).not.toMatch(/private-storage-marker|owner details/);
        expect(network.requests).toHaveLength(1);
        expect(fixture.window.settings.getSnapshot().startMinimized).toBe(true);
        expect(
            fixture.database
                .prepare('SELECT value FROM settings WHERE key = ?')
                .get('start_minimized')
        ).toEqual({ value: 'true' });
    });

    it('user cancels an unanswered setting approval and no preference is written', async () => {
        const task = await settingCommand(
            { action: 'set', key: 'start_minimized', value: false, reason: 'Requested change' },
            false
        );
        await expect
            .poll(() => fixture.window.api.getTaskSnapshot(task.taskId)?.pendingToolApproval)
            .toBeTruthy();
        fixture.window.api.cancelTask(task.taskId);
        await expect(task.completion).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
        expect(
            fixture.database
                .prepare('SELECT value FROM settings WHERE key = ?')
                .get('start_minimized')
        ).toEqual({ value: 'true' });
        expect(network.requests).toHaveLength(1);
    });

    it('user cancels after native work starts without replaying it or accepting a late task success', async () => {
        let nativeStarted = false;
        let finishNative!: () => void;
        const pendingNative = new Promise<void>((resolve) => {
            finishNative = resolve;
        });
        mockTauriCommand('register_global_shortcut', async ({ shortcut }: { shortcut: string }) => {
            if (shortcut === 'Alt+Shift+Space') {
                nativeStarted = true;
                await pendingNative;
            }
        });
        const task = await settingCommand({
            action: 'set',
            key: 'global_shortcut',
            value: 'Alt+Shift+Space',
            reason: 'Requested change',
        });
        await expect.poll(() => nativeStarted).toBe(true);
        fixture.window.api.cancelTask(task.taskId);
        await expect(task.completion).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
        finishNative();
        await expect
            .poll(() => fixture.window.settings.getSnapshot().globalShortcut)
            .toBe('Alt+Shift+Space');
        expect(fixture.window.api.getTaskSnapshot(task.taskId)?.status).toBe('cancelled');
        expect(network.requests).toHaveLength(1);
        expect(
            getTauriInvokeCalls('register_global_shortcut').filter(
                ({ payload }) => (payload as { shortcut?: string })?.shortcut === 'Alt+Shift+Space'
            )
        ).toHaveLength(1);
    });

    it('user sees a conflicting search shortcut rejected without replacing its saved global shortcut', async () => {
        await fixture.window.settings.mutate('search_keybindings', {
            ...createDefaultSearchKeybindings(),
            'search.history.open': 'Mod+K',
        });
        const task = await settingCommand({
            action: 'set',
            key: 'global_shortcut',
            value: 'Ctrl+K',
            reason: 'Requested change',
        });
        await task.completion;
        expect(callResult(task.taskId)).toMatchObject({
            isError: true,
            result: expect.stringContaining('Open session history'),
        });
        expect(
            getTauriInvokeCalls('register_global_shortcut').map(({ payload }) => payload)
        ).not.toContainEqual({ shortcut: 'Ctrl+K' });
        expect(fixture.window.settings.getSnapshot().globalShortcut).toBe('Alt+Space');
    });

    it('user sees a macOS reserved shortcut rejected before native registration', async () => {
        setPlatform('MacIntel');
        const task = await settingCommand({
            action: 'set',
            key: 'global_shortcut',
            value: 'Cmd+Space',
            reason: 'Requested change',
        });
        await task.completion;
        expect(callResult(task.taskId)).toMatchObject({
            isError: true,
            result: expect.stringContaining('macOS'),
        });
        expect(
            getTauriInvokeCalls('register_global_shortcut').map(({ payload }) => payload)
        ).not.toContainEqual({ shortcut: 'Cmd+Space' });
        expect(fixture.window.settings.getSnapshot().globalShortcut).toBe('Alt+Space');
    });

    it('user reads and changes the language through the same declared and approved setting', async () => {
        await fixture.window.settings.mutate('language', 'zh-CN');
        setLocale('en-US');
        const tool = descriptor();
        expect(tool.inputSchema.properties?.key).toMatchObject({
            enum: expect.arrayContaining(['language']),
        });
        expect(tool.inputSchema.properties?.keys).toMatchObject({
            items: { enum: expect.arrayContaining(['language']) },
        });
        const current = await settingCommand({ action: 'get', keys: ['language'] }, false);
        await current.completion;
        expect(callResult(current.taskId).result).toContain('Language (language): zh-CN');
        const changed = await settingCommand({
            action: 'set',
            key: 'language',
            value: 'en-US',
            reason: 'Use English',
        });
        await changed.completion;
        expect(callResult(changed.taskId)).toMatchObject({
            isError: false,
            result: expect.stringContaining('Language (language): en-US'),
        });
        expect(fixture.window.settings.getSnapshot().language).toBe('en-US');
        expect(getLocale()).toBe('en-US');
    });

    it('user receives invalid boolean-setting details in the active language without changing storage', async () => {
        const tool = descriptor();
        await expect(
            tool.execute(
                { action: 'set', key: 'start_minimized', value: 'yes', reason: 'Requested change' },
                tool.defaultConfig,
                { callId: 'invalid', iteration: 0 }
            )
        ).rejects.toThrow(/Setting tool received an invalid value for "start_minimized"\.\n- /);
        expect(fixture.window.settings.getSnapshot().startMinimized).toBe(true);
    });

    it('user reads short owner failure messages rather than transport internals', () => {
        expect(replyErrorMessage(SettingsErrorCode.NotReady)).toBe(
            'Settings are not ready yet. Try again shortly.'
        );
        for (const code of [
            SettingsErrorCode.StaleEpoch,
            SettingsErrorCode.OwnerDisposed,
            SettingsErrorCode.TooManyPending,
            'unknown-code',
        ]) {
            expect(replyErrorMessage(code)).toBe('Setting update failed.');
        }
    });

    it('user sees a saved-with-sync-warning result when another window cannot receive the notice', async () => {
        failNotice = true;
        const task = await settingCommand({
            action: 'set',
            key: 'start_minimized',
            value: false,
            reason: 'Requested change',
        });
        await task.completion;
        expect(callResult(task.taskId)).toMatchObject({
            isError: false,
            result: expect.stringContaining('syncing to other windows failed'),
        });
        expect(
            fixture.database
                .prepare('SELECT value FROM settings WHERE key = ?')
                .get('start_minimized')
        ).toEqual({ value: 'false' });
        expect(fixture.window.settings.getSnapshot().startMinimized).toBe(false);
    });
});
