import { createSettingsBus, type SettingsBus } from '@tests/utils/settingsTransport';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createDefaultSearchKeybindings } from '@/config/searchKeybindings';
import type { SettingsEffects } from '@/services/SettingsService/effects';
import { SettingsService } from '@/services/SettingsService/service';
import { SettingsErrorCode } from '@/services/SettingsService/types';

const dbMock = vi.hoisted(() => ({
    values: new Map<string, string | null>(),
    setCalls: [] as Array<{ key: string; value: string }>,
    failNextSet: false,
    setThrowsAfterWrite: false,
    batchReads: 0,
    // Controllable, explicit gates: no test relies on a tiny setTimeout to pass by luck.
    holdReads: false,
    readResolvers: [] as Array<() => void>,
    readBackThrows: false,
}));

vi.mock('@database/queries', () => {
    const readValue = async ({ key }: { key: string }) => {
        if (dbMock.holdReads) {
            await new Promise<void>((resolve) => dbMock.readResolvers.push(resolve));
        }
        if (dbMock.readBackThrows) {
            throw new Error('database read failed');
        }
        return dbMock.values.get(key) ?? null;
    };

    return {
        getSettingValue: vi.fn(readValue),
        getSettingValues: vi.fn(async ({ keys }: { keys: string[] }) => {
            dbMock.batchReads += 1;
            return Object.fromEntries(
                await Promise.all(keys.map(async (key) => [key, await readValue({ key })]))
            );
        }),
        setSetting: vi.fn(async ({ key, value }: { key: string; value: string }) => {
            dbMock.setCalls.push({ key, value });
            if (dbMock.setThrowsAfterWrite) {
                dbMock.values.set(key, value);
                throw new Error('ambiguous acknowledgement');
            }
            if (dbMock.failNextSet) {
                dbMock.failNextSet = false;
                throw new Error('database locked');
            }
            dbMock.values.set(key, value);
            return { id: 1, key, value, created_at: '', updated_at: '' };
        }),
    };
});

async function flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
}

function releaseHeldReads(): void {
    dbMock.holdReads = false;
    const resolvers = dbMock.readResolvers.splice(0);
    for (const resolve of resolvers) {
        resolve();
    }
}

function createEffects(): SettingsEffects {
    return {
        isAutostartEnabled: vi.fn(async () => false),
        setAutostart: vi.fn(async () => undefined),
        registerGlobalShortcut: vi.fn(async () => undefined),
        setSearchWindowDefaults: vi.fn(async () => undefined),
        applyLanguage: vi.fn(),
    };
}

describe('user changes a setting through the single owner', () => {
    let bus: SettingsBus;

    beforeEach(() => {
        dbMock.values.clear();
        dbMock.setCalls.length = 0;
        dbMock.failNextSet = false;
        dbMock.setThrowsAfterWrite = false;
        dbMock.batchReads = 0;
        dbMock.holdReads = false;
        dbMock.readResolvers.length = 0;
        dbMock.readBackThrows = false;
        bus = createSettingsBus();
    });

    function createOwner(effects: SettingsEffects): SettingsService {
        return new SettingsService({
            transport: bus.transport('main'),
            effects,
            requestTimeoutMs: 30,
        });
    }

    function createClient(label: string, effects: SettingsEffects): SettingsService {
        return new SettingsService({
            transport: bus.transport(label),
            effects,
            requestTimeoutMs: 100,
        });
    }

    it('user sees a failed write when the owner has not finished loading', async () => {
        const owner = createOwner(createEffects());

        await expect(owner.mutate('output_scroll_behavior', 'stay_position')).rejects.toMatchObject(
            {
                code: SettingsErrorCode.NotReady,
            }
        );
    });

    it('user starts with one batched settings read instead of one query per key', async () => {
        const owner = createOwner(createEffects());

        await owner.initialize();

        expect(dbMock.batchReads).toBe(1);
    });

    it('user sees the saved value once the owner is ready', async () => {
        const owner = createOwner(createEffects());
        await owner.initialize();

        const result = await owner.mutate('output_scroll_behavior', 'stay_position');

        expect(result.status).toBe('committed');
        expect(owner.getSnapshot().outputScrollBehavior).toBe('stay_position');
        expect(dbMock.values.get('output_scroll_behavior')).toBe('stay_position');
    });

    describe('given a global shortcut is already used by a search action', () => {
        it('user cannot save the conflicting global shortcut', async () => {
            dbMock.values.set(
                'search_keybindings',
                JSON.stringify({
                    ...createDefaultSearchKeybindings(),
                    'search.input.focus': 'Mod+K',
                })
            );
            const owner = createOwner(createEffects());
            await owner.initialize();

            const result = await owner.mutate('global_shortcut', 'Mod+K');

            expect(result.status).toBe('rejected');
            expect(owner.getSnapshot().globalShortcut).toBe('Alt+Space');
            expect(dbMock.values.get('global_shortcut')).toBe('Alt+Space');
        });
    });

    describe('given the global shortcut is set', () => {
        it('user cannot save a search shortcut that collides with it', async () => {
            const owner = createOwner(createEffects());
            await owner.initialize();
            await owner.mutate('global_shortcut', 'Mod+9');

            const result = await owner.mutate('search_keybindings', {
                ...createDefaultSearchKeybindings(),
                'search.input.focus': 'Mod+9',
            });

            expect(result.status).toBe('rejected');
            expect(owner.getSnapshot().searchKeybindings['search.input.focus']).toBe('Mod+L');
        });
    });

    it('user keeps the previous value when the operating-system action fails', async () => {
        const effects = createEffects();
        const owner = createOwner(effects);
        await owner.initialize();
        vi.mocked(effects.registerGlobalShortcut).mockRejectedValueOnce(
            new Error('already registered')
        );

        const result = await owner.mutate('global_shortcut', 'Ctrl+Shift+A');

        expect(result.status).toBe('rejected');
        expect(owner.getSnapshot().globalShortcut).toBe('Alt+Space');
        expect(dbMock.values.get('global_shortcut')).toBe('Alt+Space');
    });

    it('user sees the previous value restored when persistence fails and the readback confirms a different value', async () => {
        const effects = createEffects();
        const owner = createOwner(effects);
        await owner.initialize();
        dbMock.failNextSet = true;
        // The write failed, but the readback succeeds and still returns the old value, so
        // the outcome is confirmed as "not committed" and the native effect is reverted.

        const result = await owner.mutate('start_on_boot', true);

        expect(result.status).toBe('restored');
        expect(owner.getSnapshot().startOnBoot).toBe(false);
        expect(dbMock.values.get('start_on_boot')).toBe('false');
        expect(vi.mocked(effects.setAutostart)).toHaveBeenLastCalledWith(false);
    });

    it('user keeps the new value when the database actually committed despite an error', async () => {
        const owner = createOwner(createEffects());
        await owner.initialize();
        dbMock.setThrowsAfterWrite = true;

        const result = await owner.mutate('start_on_boot', true);

        expect(result.status).toBe('committed');
        expect(owner.getSnapshot().startOnBoot).toBe(true);
    });

    it('user is warned to re-check settings when the native rollback also fails', async () => {
        const effects = createEffects();
        vi.mocked(effects.setAutostart).mockImplementation(async (enabled: boolean) => {
            if (!enabled) {
                throw new Error('os unavailable');
            }
        });
        const owner = createOwner(effects);
        await owner.initialize();
        dbMock.failNextSet = true;

        const result = await owner.mutate('start_on_boot', true);

        expect(result.status).toBe('recovery-required');
    });

    it('user keeps the committed value when notifying other windows fails', async () => {
        const owner = createOwner(createEffects());
        await owner.initialize();
        bus.failNotices = true;

        const result = await owner.mutate('output_scroll_behavior', 'stay_position');
        bus.failNotices = false;

        expect(result.status).toBe('committed');
        expect(result.status === 'committed' ? result.warning : undefined).toBeTruthy();
        expect(owner.getSnapshot().outputScrollBehavior).toBe('stay_position');
    });

    it('user sees writes from two windows serialize against the latest cross-key state', async () => {
        const effects = createEffects();
        const owner = createOwner(effects);
        await owner.initialize();
        const windowA = createClient('win-a', effects);
        const windowB = createClient('win-b', effects);
        await windowA.initialize();
        await windowB.initialize();

        const first = windowA.mutate('search_keybindings', {
            ...createDefaultSearchKeybindings(),
            'search.input.focus': 'Mod+9',
        });
        const second = windowB.mutate('global_shortcut', 'Mod+9');
        const [firstResult, secondResult] = await Promise.all([first, second]);

        expect(firstResult.status).toBe('committed');
        expect(secondResult.status).toBe('rejected');
        expect(owner.getSnapshot().searchKeybindings['search.input.focus']).toBe('Mod+9');
        expect(owner.getSnapshot().globalShortcut).toBe('Alt+Space');
    });

    it('user still gets settings when the ready broadcast is missed', async () => {
        bus.dropNotices = true;
        const effects = createEffects();
        const owner = createOwner(effects);
        await owner.initialize();
        await owner.mutate('output_scroll_behavior', 'stay_position');

        const window = createClient('win-a', effects);
        await window.initialize();

        expect(window.getSnapshot().outputScrollBehavior).toBe('stay_position');
    });

    it('user sees values converge when a change notice is missed and the window is focused', async () => {
        const effects = createEffects();
        const owner = createOwner(effects);
        await owner.initialize();
        const window = createClient('win-a', effects);
        await window.initialize();

        bus.dropNotices = true;
        await owner.mutate('output_scroll_behavior', 'stay_position');
        expect(window.getSnapshot().outputScrollBehavior).toBe('follow_output');

        bus.dropNotices = false;
        bus.focus('win-a');
        await flush();

        expect(window.getSnapshot().outputScrollBehavior).toBe('stay_position');
    });

    it('user gets a quick failure when the owner is gone', async () => {
        const effects = createEffects();
        const owner = createOwner(effects);
        await owner.initialize();
        const window = createClient('win-a', effects);
        await window.initialize();

        owner.dispose();

        await expect(
            window.mutate('output_scroll_behavior', 'stay_position')
        ).rejects.toMatchObject({
            code: SettingsErrorCode.OwnerUnavailable,
        });
    });

    it('user gets settings again after the owner is reopened', async () => {
        const effects = createEffects();
        const owner = createOwner(effects);
        await owner.initialize();
        const window = createClient('win-a', effects);
        await window.initialize();

        owner.dispose();
        const reopened = createOwner(effects);
        await reopened.initialize();
        bus.focus('win-a');
        await flush();

        const result = await window.mutate('output_scroll_behavior', 'stay_position');

        expect(result.status).toBe('committed');
        expect(reopened.getSnapshot().outputScrollBehavior).toBe('stay_position');
    });

    it('user sees an unknown result and never a double execution when a write times out', async () => {
        const effects = createEffects();
        const owner = createOwner(effects);
        await owner.initialize();
        const window = createClient('win-a', effects);
        await window.initialize();

        bus.dropRequests = true;
        const result = await window.mutate('output_scroll_behavior', 'stay_position');

        expect(result.status).toBe('unknown');
        const mutateRequests = bus.sent.filter(
            (record) => record.message.kind === 'mutate-request'
        );
        expect(mutateRequests).toHaveLength(1);
        expect(dbMock.values.get('output_scroll_behavior')).not.toBe('stay_position');
    });

    it('user still converges when a client starts before the owner is ready and the ready notice is lost', async () => {
        bus.dropNotices = true;
        const effects = createEffects();
        const owner = createOwner(effects);
        dbMock.holdReads = true;
        const ownerInit = owner.initialize();
        await flush();

        const window = createClient('win-a', effects);
        const clientInit = window.initialize();
        await flush();
        expect(window.isReady()).toBe(false);

        releaseHeldReads();
        await ownerInit;
        await clientInit;

        expect(window.isReady()).toBe(true);
        expect(window.getSnapshot().startMinimized).toBe(true);
    });

    it('user sees an unknown result when the write ran but its reply was lost, and never a second write', async () => {
        const effects = createEffects();
        const owner = createOwner(effects);
        await owner.initialize();
        const window = createClient('win-a', effects);
        await window.initialize();
        dbMock.setCalls.length = 0;

        // Drop both the reply and the change notice so the only way the client can learn
        // the outcome is a fresh read after the window is focused again.
        bus.dropReplies = true;
        bus.dropNotices = true;
        const result = await window.mutate('output_scroll_behavior', 'stay_position');
        bus.dropReplies = false;
        bus.dropNotices = false;

        expect(result.status).toBe('unknown');
        // The write did happen, but a lost reply means the client cannot know that.
        expect(dbMock.values.get('output_scroll_behavior')).toBe('stay_position');
        expect(
            dbMock.setCalls.filter((call) => call.key === 'output_scroll_behavior')
        ).toHaveLength(1);
        expect(bus.sent.filter((record) => record.message.kind === 'mutate-request')).toHaveLength(
            1
        );

        // A focus re-reads the authoritative state and converges without re-running the write.
        bus.focus('win-a');
        await flush();
        expect(window.getSnapshot().outputScrollBehavior).toBe('stay_position');
        expect(
            dbMock.setCalls.filter((call) => call.key === 'output_scroll_behavior')
        ).toHaveLength(1);
    });

    it('user runs a repeated request id once and is refused when an id is reused for another command', async () => {
        const effects = createEffects();
        const owner = createOwner(effects);
        await owner.initialize();
        dbMock.setCalls.length = 0;

        const ghost = bus.transport('win-a');
        const message = {
            kind: 'mutate-request' as const,
            requestId: 'req-dup',
            from: 'win-a',
            hostEpoch: owner.getHostEpoch(),
            key: 'output_scroll_behavior' as const,
            value: 'stay_position' as const,
        };
        await ghost.send('main', message);
        await ghost.send('main', message);
        await flush();

        expect(
            dbMock.setCalls.filter((call) => call.key === 'output_scroll_behavior')
        ).toHaveLength(1);

        await ghost.send('main', {
            ...message,
            key: 'start_minimized',
            value: false,
        });
        await flush();

        expect(dbMock.setCalls.filter((call) => call.key === 'start_minimized')).toHaveLength(0);
        const replies = bus.sent
            .filter((record) => record.message.kind === 'reply')
            .map((record) => record.message as { ok: boolean; requestId: string });
        expect(replies.some((reply) => reply.requestId === 'req-dup' && !reply.ok)).toBe(true);
    });

    it('user is blocked as recovery-required after an unconfirmed write, then recovers', async () => {
        const effects = createEffects();
        const owner = createOwner(effects);
        await owner.initialize();

        dbMock.failNextSet = true;
        dbMock.readBackThrows = true;
        const unconfirmed = await owner.mutate('start_on_boot', true);
        expect(unconfirmed.status).toBe('unknown');

        // Still cannot confirm the database, so the next change is refused rather than applied.
        const blocked = await owner.mutate('start_minimized', false);
        expect(blocked.status).toBe('recovery-required');

        dbMock.readBackThrows = false;
        const recovered = await owner.mutate('start_minimized', false);
        expect(recovered.status).toBe('committed');
    });

    it('user sees the owner materialize defaults and reconcile native settings at startup', async () => {
        const effects = createEffects();
        const owner = createOwner(effects);
        await owner.initialize();

        expect(effects.registerGlobalShortcut).toHaveBeenCalledWith('Alt+Space');
        expect(effects.setSearchWindowDefaults).toHaveBeenCalledTimes(1);
        expect(effects.applyLanguage).toHaveBeenCalled();
        expect(dbMock.setCalls.length).toBeGreaterThan(0);
    });

    it('user sees a client window follow the owner language after a change', async () => {
        const ownerEffects = createEffects();
        const clientEffects = createEffects();
        const owner = createOwner(ownerEffects);
        await owner.initialize();
        const window = createClient('win-a', clientEffects);
        await window.initialize();

        const result = await owner.mutate('language', 'en-US');
        expect(result.status).toBe('committed');

        bus.focus('win-a');
        await flush();

        expect(window.getSnapshot().language).toBe('en-US');
        expect(window.getSnapshot().language).toBe(owner.getSnapshot().language);
        expect(clientEffects.applyLanguage).toHaveBeenLastCalledWith('en-US');
    });

    it('user ignores a late notice and shutdown from a superseded owner epoch', async () => {
        const effects = createEffects();
        const owner = createOwner(effects);
        await owner.initialize();
        const firstEpoch = owner.getHostEpoch();
        const window = createClient('win-a', effects);
        await window.initialize();

        owner.dispose();
        const reopened = createOwner(effects);
        await reopened.initialize();
        const secondEpoch = reopened.getHostEpoch();
        bus.focus('win-a');
        await flush();

        expect(secondEpoch).not.toBe(firstEpoch);
        expect(window.getSnapshot().language).toBe(reopened.getSnapshot().language);

        // A late change notice and a late "gone" from the first owner must not disturb the
        // current one or make the client reject its requests.
        const ghost = bus.transport('ghost');
        await ghost.send('*', {
            kind: 'notice',
            hostEpoch: firstEpoch as string,
            revision: 99,
            type: 'change',
            changedKeys: [],
        });
        await ghost.send('*', {
            kind: 'notice',
            hostEpoch: firstEpoch as string,
            revision: 0,
            type: 'gone',
            changedKeys: [],
        });
        await flush();

        const result = await window.mutate('output_scroll_behavior', 'stay_position');
        expect(result.status).toBe('committed');
    });

    it('user cannot mutate with a null owner epoch, and nothing runs', async () => {
        const effects = createEffects();
        const owner = createOwner(effects);
        await owner.initialize();
        dbMock.setCalls.length = 0;

        const ghost = bus.transport('win-x');
        await ghost.send('main', {
            kind: 'mutate-request',
            requestId: 'req-null-epoch',
            from: 'win-x',
            hostEpoch: null,
            key: 'start_on_boot',
            value: true,
        });
        await flush();

        expect(dbMock.setCalls).toHaveLength(0);
        expect(effects.setAutostart).not.toHaveBeenCalled();
        expect(owner.getSnapshot().startOnBoot).toBe(false);
        const reply = bus.sent
            .filter((record) => record.message.kind === 'reply')
            .map((record) => record.message as { requestId: string; ok: boolean; code?: string })
            .find((message) => message.requestId === 'req-null-epoch');
        expect(reply).toMatchObject({ ok: false, code: SettingsErrorCode.StaleEpoch });
    });

    it('user is blocked as recovery-required when startup native reconcile failed, then recovers', async () => {
        let autostartReads = 0;
        const effects = createEffects();
        vi.mocked(effects.isAutostartEnabled).mockImplementation(async () => {
            autostartReads += 1;
            if (autostartReads <= 2) {
                throw new Error('os read failed');
            }
            return false;
        });
        const owner = createOwner(effects);
        await owner.initialize();

        const blocked = await owner.mutate('start_minimized', false);
        expect(blocked.status).toBe('recovery-required');

        const recovered = await owner.mutate('start_minimized', false);
        expect(recovered.status).toBe('committed');
    });

    it('user sees settings re-read from the authoritative database when the owner is focused', async () => {
        const owner = createOwner(createEffects());
        await owner.initialize();
        expect(owner.getSnapshot().outputScrollBehavior).toBe('follow_output');

        dbMock.values.set('output_scroll_behavior', 'stay_position');
        bus.focus('main');
        await flush();

        expect(owner.getSnapshot().outputScrollBehavior).toBe('stay_position');
    });

    it('user never sees a late success from a superseded owner epoch settle a write', async () => {
        const effects = createEffects();
        const owner = createOwner(effects);
        await owner.initialize();
        const firstEpoch = owner.getHostEpoch();
        const window = createClient('win-a', effects);
        await window.initialize();

        owner.dispose();
        const reopened = createOwner(effects);
        await reopened.initialize();
        bus.focus('win-a');
        await flush();
        expect(reopened.getHostEpoch()).not.toBe(firstEpoch);
        expect(window.getSnapshot().outputScrollBehavior).toBe('follow_output');

        // Withhold the real request so only the (stale-epoch) injected reply can answer it.
        bus.dropRequests = true;
        const pending = window.mutate('output_scroll_behavior', 'stay_position');
        await flush();
        bus.dropRequests = false;
        const mutateRequests = bus.sent
            .filter((record) => record.message.kind === 'mutate-request')
            .map((record) => record.message as { requestId: string });
        const requestId = mutateRequests[mutateRequests.length - 1]?.requestId;
        expect(requestId).toBeTruthy();

        const ghost = bus.transport('ghost');
        await ghost.send('win-a', {
            kind: 'reply',
            requestId: requestId as string,
            hostEpoch: firstEpoch,
            ok: true,
            result: {
                status: 'committed',
                key: 'output_scroll_behavior',
                value: 'stay_position',
                revision: 999,
            },
        });

        const result = await pending;
        expect(result.status).toBe('unknown');
        expect(window.getSnapshot().outputScrollBehavior).toBe('follow_output');
    });

    it('user never gets a database write when the owner is disposed mid-native-effect', async () => {
        const effects = createEffects();
        let releaseNative: () => void = () => undefined;
        let nativeStarted: () => void = () => undefined;
        const nativeEntered = new Promise<void>((resolve) => {
            nativeStarted = resolve;
        });
        vi.mocked(effects.registerGlobalShortcut).mockImplementation((shortcut: string) =>
            shortcut === 'Ctrl+Shift+K'
                ? new Promise<void>((resolve) => {
                      releaseNative = resolve;
                      nativeStarted();
                  })
                : Promise.resolve()
        );

        const owner = createOwner(effects);
        await owner.initialize();
        dbMock.setCalls.length = 0;
        const committedBefore = owner.getSnapshot().globalShortcut;

        const pending = owner.mutate('global_shortcut', 'Ctrl+Shift+K');
        await nativeEntered;

        owner.dispose();
        releaseNative();

        const result = await pending;
        expect(result.status).toBe('unknown');
        expect(result.status === 'unknown' ? result.code : undefined).toBe(
            SettingsErrorCode.OwnerDisposed
        );
        expect(dbMock.setCalls).toHaveLength(0);
        expect(dbMock.values.get('global_shortcut')).not.toBe('Ctrl+Shift+K');
        expect(owner.getSnapshot().globalShortcut).toBe(committedBefore);
    });

    it('user gets a not-ready reply whose text matches the code while the owner loads', async () => {
        const owner = createOwner(createEffects());
        dbMock.holdReads = true;
        const ownerInit = owner.initialize();
        await flush();

        const ghost = bus.transport('win-x');
        await ghost.send('main', {
            kind: 'snapshot-request',
            requestId: 'req-not-ready',
            from: 'win-x',
            hostEpoch: null,
        });
        await flush();

        const reply = bus.sent
            .filter((record) => record.message.kind === 'reply')
            .map(
                (record) =>
                    record.message as {
                        requestId: string;
                        ok: boolean;
                        code?: string;
                        message?: string;
                    }
            )
            .find((message) => message.requestId === 'req-not-ready');
        expect(reply).toMatchObject({ ok: false, code: SettingsErrorCode.NotReady });
        expect(reply?.message).toContain('设置尚未就绪');

        releaseHeldReads();
        await ownerInit;
    });
});
