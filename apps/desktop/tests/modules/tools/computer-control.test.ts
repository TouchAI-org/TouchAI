import {
    closeTestDatabases,
    openMigratedDatabase,
    routeQueriesTo,
} from '@tests/database/sqliteHarness';
import { getTauriInvokeCalls, mockTauriCommand } from '@tests/utils/tauri';
import { afterEach, describe, expect, it } from 'vitest';

import type { ToolTaskContext } from '@/modules/tools';
import {
    createBuiltinRegistrations,
    createComputerControl,
    createComputerUseTools,
    createTools,
} from '@/modules/tools';

afterEach(closeTestDatabases);

async function fixture() {
    const database = openMigratedDatabase();
    routeQueriesTo(database);
    mockTauriCommand('computer_use_list_tools', [
        {
            name: 'get_window_state',
            description: 'Fixture observation',
            inputSchema: { type: 'object', properties: {} },
            annotations: { readOnlyHint: true },
        },
    ]);
    mockTauriCommand('computer_use_invoke', (payload) => ({
        isError: false,
        content: [{ type: 'text', text: `Fixture ${String((payload as { tool?: string }).tool)}` }],
    }));
    const control = createComputerControl({
        locale: () => 'en-US',
        onStopped: async () => () => {},
        warn: () => {},
    });
    const catalog = createBuiltinRegistrations(
        createComputerUseTools({
            control,
            messages: { t: (key) => key, tt: (text) => text },
            images: { extract: async () => [] },
            warn: () => {},
        })
    );
    await catalog.synchronize();
    const tools = createTools({
        registrations: catalog.registrations,
        formatError: (code) => code,
    });
    return { database, control, tools };
}

describe('given computer control is an ordinary builtin with instance-scoped authority', () => {
    it('user keeps session approvals isolated between two assembled control instances', async () => {
        const { control, tools } = await fixture();
        const other = createComputerControl({
            locale: () => 'en-US',
            onStopped: async () => () => {},
            warn: () => {},
        });
        try {
            control.allowForSession('12:34');
            expect(control.isAllowedForSession('12:34')).toBe(true);
            expect(other.isAllowedForSession('12:34')).toBe(false);
        } finally {
            tools.dispose();
            await control.dispose();
            await other.dispose();
        }
    });

    it('user observes through the captured driver settings rather than edited settings in an advertised turn', async () => {
        const { database, control, tools } = await fixture();
        try {
            await control.saveSettings({ maxImageDimension: 900 });
            const snapshot = await tools.snapshot();
            database.exec(
                `UPDATE settings SET value = '{"maxImageDimension":1200}' WHERE key = 'computer_use.settings'`
            );
            const result = await snapshot.execute(
                {
                    id: 'call',
                    name: 'builtin__computer_use',
                    arguments: '{"action":"observe","pid":12,"window_id":34}',
                },
                { iteration: 0 }
            );
            expect(result).toMatchObject({ isError: false, status: 'success' });
            const effects = getTauriInvokeCalls('computer_use_invoke').map((call) => call.payload);
            expect(effects).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        tool: 'set_config',
                        arguments: expect.objectContaining({ max_image_dimension: 900 }),
                    }),
                    expect.objectContaining({ tool: 'get_window_state', driver: 'cua-driver' }),
                ])
            );
        } finally {
            tools.dispose();
            await control.dispose();
        }
    });

    it('user cannot execute an old driver binding after the selected driver changes', async () => {
        const { database, control, tools } = await fixture();
        try {
            const snapshot = await tools.snapshot();
            database.exec(
                `INSERT INTO settings (key, value) VALUES ('computer_use.driver', 'agent-desktop')`
            );
            const result = await snapshot.execute(
                {
                    id: 'call',
                    name: 'builtin__computer_use',
                    arguments:
                        '{"action":"call","tool":"get_window_state","arguments":{"pid":12,"window_id":34}}',
                },
                {
                    iteration: 0,
                    requestApproval: async () => true,
                }
            );
            expect(result.isError).toBe(true);
            expect(getTauriInvokeCalls('computer_use_invoke')).toEqual([]);
        } finally {
            tools.dispose();
            await control.dispose();
        }
    });

    it('user keeps the same task activity across effects and releases it only when the task ends', async () => {
        const { control, tools } = await fixture();
        const taskController = new AbortController();
        const task: ToolTaskContext = {
            taskId: 'task',
            attemptToken: 'attempt',
            attemptGeneration: 1,
            signal: taskController.signal,
            stop: () => taskController.abort(),
            historyTarget: { sessionId: 1, messageId: 1 },
            ask: async () => null,
            present: () => {},
            currentModel: {
                key: 'fixture',
                id: 1,
                provider_id: 1,
                provider_name: 'Fixture',
                model_id: 'fixture',
                name: 'Fixture',
                supportsImages: false,
            },
        };
        try {
            const snapshot = await tools.snapshot();
            const effect = new AbortController();
            const call = {
                id: 'first',
                name: 'builtin__computer_use',
                arguments: '{"action":"observe","pid":12,"window_id":34}',
            };
            expect(
                (await snapshot.execute(call, { iteration: 0, task, signal: effect.signal }))
                    .isError
            ).toBe(false);
            effect.abort();
            expect(
                (
                    await snapshot.execute(
                        { ...call, id: 'second' },
                        { iteration: 1, task, signal: new AbortController().signal }
                    )
                ).isError
            ).toBe(false);
            const observations = getTauriInvokeCalls('computer_use_invoke')
                .map((call) => call.payload as { tool: string; activityId: string })
                .filter((effect) => effect.tool === 'get_window_state');
            expect(observations.map((effect) => effect.activityId)).toEqual([
                observations[0]!.activityId,
                observations[0]!.activityId,
            ]);
            expect(
                getTauriInvokeCalls('computer_use_glow_set_active').map((call) => call.payload)
            ).not.toContainEqual(expect.objectContaining({ active: false }));
            await control.endActivity(taskController.signal);
            expect(
                getTauriInvokeCalls('computer_use_glow_set_active').map((call) => call.payload)
            ).toContainEqual(
                expect.objectContaining({ activityId: observations[0]!.activityId, active: false })
            );
        } finally {
            tools.dispose();
            await control.dispose();
        }
    });

    it('user cannot accept a late native success after disposing the instance that started it', async () => {
        const { control, tools } = await fixture();
        let finish!: (value: Record<string, unknown>) => void;
        let started!: () => void;
        const admitted = new Promise<void>((resolve) => {
            started = resolve;
        });
        mockTauriCommand('computer_use_invoke', (payload) => {
            if ((payload as { tool: string }).tool !== 'get_window_state')
                return { isError: false };
            started();
            return new Promise<Record<string, unknown>>((resolve) => {
                finish = resolve;
            });
        });
        try {
            const bound = await control.capture();
            const invocation = bound.execute('get_window_state', { pid: 12, window_id: 34 });
            const rejected = expect(invocation.result).rejects.toThrow('computer use cancelled');
            await admitted;
            await control.dispose();
            finish({ isError: false, content: [{ type: 'text', text: 'late success' }] });
            await rejected;
            expect(
                getTauriInvokeCalls('computer_use_cancel').map((call) => call.payload)
            ).toContainEqual({ executionId: invocation.executionId });
        } finally {
            tools.dispose();
            await control.dispose();
        }
    });
});
