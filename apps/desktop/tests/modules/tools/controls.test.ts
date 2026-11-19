import {
    closeTestDatabases,
    openMigratedDatabase,
    routeQueriesTo,
} from '@tests/database/sqliteHarness';
import { afterEach, describe, expect, it } from 'vitest';

import type { ToolInvocationScope, ToolMessages, ToolModelReference } from '@/modules/tools';
import {
    createAskUserTools,
    createBuiltinRegistrations,
    createTools,
    createUpgradeModelTools,
} from '@/modules/tools';

afterEach(closeTestDatabases);

const messages: ToolMessages = { t: (key) => key, tt: (text) => text };
const current: ToolModelReference = {
    key: 'original-current',
    id: 1,
    provider_id: 1,
    provider_name: 'Fixture',
    model_id: 'first',
    name: 'First',
    supportsImages: false,
};
const target: ToolModelReference = {
    ...current,
    key: 'original-target',
    id: 2,
    model_id: 'second',
    name: 'Second',
};
const taskScope = (): ToolInvocationScope['task'] => ({
    taskId: 'task',
    attemptToken: 'attempt',
    attemptGeneration: 1,
    signal: new AbortController().signal,
    stop: () => {},
    historyTarget: { sessionId: 1, messageId: 1 },
    currentModel: current,
    ask: async () => null,
    present: () => {},
});

describe('given instance-composed question and model-control builtins', () => {
    it('user switches only to the same captured connection shown in the approval even after profile edits', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        let resolved = target;
        const catalog = createBuiltinRegistrations(
            createUpgradeModelTools({
                messages,
                models: {
                    resolve: async (_taskId, reference) =>
                        reference.modelId === 'first' ? current : resolved,
                    isAvailable: async () => true,
                },
            })
        );
        await catalog.synchronize();
        database.exec(`UPDATE built_in_tools SET config_json = '{"chain":[{"providerId":1,"modelId":"first"},{"providerId":1,"modelId":"second"}]}'
            WHERE tool_id = 'upgrade_model'`);
        const tools = createTools({
            registrations: catalog.registrations,
            formatError: (code) => code,
        });
        try {
            const snapshot = await tools.snapshot({
                preparation: { taskId: 'task', currentModel: current },
            });
            const approvals: string[] = [];
            const result = await snapshot.execute(
                { id: 'call', name: 'builtin__upgrade_model', arguments: '{}' },
                {
                    iteration: 0,
                    task: taskScope(),
                    requestApproval: async (_id, approval) => {
                        approvals.push(approval.command);
                        resolved = { ...target, key: 'edited-connection', name: 'Edited' };
                        return true;
                    },
                }
            );
            expect(approvals).toEqual(['Fixture / First -> Fixture / Second']);
            expect(result).toMatchObject({
                isError: false,
                control: { type: 'upgrade_model', targetKey: 'original-target' },
            });
            expect(result.result).toContain('Fixture / Second');
            expect(result.result).not.toContain('Edited');
        } finally {
            tools.dispose();
        }
    });

    it('user cannot switch to a target revoked while its approval is pending', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        let available = true;
        const catalog = createBuiltinRegistrations(
            createUpgradeModelTools({
                messages,
                models: {
                    resolve: async () => target,
                    isAvailable: async () => available,
                },
            })
        );
        await catalog.synchronize();
        database.exec(
            `UPDATE built_in_tools SET config_json = '{"chain":[{"providerId":1,"modelId":"second"}]}' WHERE tool_id = 'upgrade_model'`
        );
        const tools = createTools({
            registrations: catalog.registrations,
            formatError: (code) => code,
        });
        try {
            const snapshot = await tools.snapshot({
                preparation: { taskId: 'task', currentModel: current },
            });
            const result = await snapshot.execute(
                { id: 'call', name: 'builtin__upgrade_model', arguments: '{}' },
                {
                    iteration: 0,
                    task: taskScope(),
                    requestApproval: async () => {
                        available = false;
                        return true;
                    },
                }
            );
            expect(result).toMatchObject({
                isError: true,
                result: 'tool_unavailable',
                sideEffect: 'none',
            });
            expect(result.control).toBeUndefined();
        } finally {
            tools.dispose();
        }
    });

    it('user answers concurrent questions through each task scope without another instance consuming a reply', async () => {
        const database = openMigratedDatabase();
        routeQueriesTo(database);
        const catalog = createBuiltinRegistrations(createAskUserTools(messages));
        await catalog.synchronize();
        const left = createTools({
            registrations: catalog.registrations,
            formatError: (code) => code,
        });
        const right = createTools({
            registrations: catalog.registrations,
            formatError: (code) => code,
        });
        const scope = (id: string, label: string): ToolInvocationScope => ({
            iteration: 0,
            task: {
                taskId: id,
                attemptToken: `${id}-attempt`,
                attemptGeneration: 1,
                currentModel: current,
                signal: new AbortController().signal,
                stop: () => {},
                historyTarget: { sessionId: 1, messageId: 1 },
                present: () => undefined,
                ask: async () => [{ questionIndex: 0, selectedLabels: [label], skipped: false }],
            },
        });
        const call = {
            id: 'call',
            name: 'builtin__ask_user_question',
            arguments: JSON.stringify({
                questions: [
                    {
                        question: 'Choose',
                        header: 'Choice',
                        options: [{ label: 'Left' }, { label: 'Right' }],
                        multiSelect: false,
                        allowOther: false,
                    },
                ],
            }),
        };
        try {
            const [a, b] = await Promise.all([
                (await left.snapshot()).execute(call, scope('left', 'Left')),
                (await right.snapshot()).execute(call, scope('right', 'Right')),
            ]);
            expect(a.result).toBe('Q1 [Choose] -> answered: Left');
            expect(b.result).toBe('Q1 [Choose] -> answered: Right');
        } finally {
            left.dispose();
            right.dispose();
        }
    });
});
