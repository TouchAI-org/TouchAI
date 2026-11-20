import {
    closeTestDatabases,
    openMigratedDatabase,
    routeQueriesTo,
} from '@tests/database/sqliteHarness';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ToolEvent, ToolInvocationScope } from '@/modules/tools';
import { createBashTools, createBuiltinRegistrations, createTools } from '@/modules/tools';

const boundary = vi.hoisted(() => ({
    requests: [] as Record<string, unknown>[],
    cancelled: [] as string[],
    run: null as
        | null
        | ((
              request: Record<string, unknown>,
              options: {
                  onOutputDelta?: (delta: Record<string, unknown>) => void;
              }
          ) => Promise<Record<string, unknown>>),
}));
vi.mock('@/platform/native', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/platform/native')>();
    return {
        ...original,
        native: {
            ...original.native,
            builtInTools: {
                executeBash: async (
                    request: Record<string, unknown>,
                    options: { onOutputDelta?: (delta: Record<string, unknown>) => void }
                ) => {
                    boundary.requests.push(request);
                    return boundary.run
                        ? boundary.run(request, options)
                        : {
                              command: request.command,
                              shell: 'powershell',
                              workingDirectory: request.workingDirectory,
                              exitCode: 0,
                              success: true,
                              timedOut: false,
                              cancelled: false,
                              durationMs: 10,
                              stdout: 'fixture output',
                              stderr: '',
                              combinedOutput: 'fixture output',
                          };
                },
                cancelBash: async (id: string) => {
                    boundary.cancelled.push(id);
                    return true;
                },
            },
        },
    };
});
vi.mock('@tauri-apps/api/path', () => ({ desktopDir: async () => 'C:/fixture' }));

afterEach(() => {
    closeTestDatabases();
    boundary.requests.length = 0;
    boundary.cancelled.length = 0;
    boundary.run = null;
});

async function fixture() {
    const database = openMigratedDatabase();
    routeQueriesTo(database);
    const catalog = createBuiltinRegistrations(
        createBashTools({ messages: { t: (key) => key, tt: (text) => text } })
    );
    await catalog.synchronize();
    database.exec(
        `UPDATE built_in_tools SET config_json = '{"approvalMode":"always","timeoutMs":120000}' WHERE tool_id = 'bash'`
    );
    const tools = createTools({
        registrations: catalog.registrations,
        formatError: (code) => code,
    });
    return { database, tools };
}

describe('given shell effects use frozen configuration and controlled cancellation', () => {
    it('user executes the advertised timeout and configuration rather than settings edited during the turn', async () => {
        const { database, tools } = await fixture();
        try {
            const snapshot = await tools.snapshot();
            database.exec(
                `UPDATE built_in_tools SET config_json = '{"approvalMode":"never","timeoutMs":1000}' WHERE tool_id = 'bash'`
            );
            const result = await snapshot.execute(
                {
                    id: 'call',
                    name: 'builtin__bash',
                    arguments:
                        '{"command":"Write-Output fixture","reason":"fixture request","_meta":{"timeoutMs":500000}}',
                },
                {
                    iteration: 0,
                    requestApproval: async () => true,
                }
            );
            expect(snapshot.declarations[0]?.input_schema.properties._meta).toMatchObject({
                properties: { timeoutMs: { maximum: 120000 } },
            });
            expect(boundary.requests).toEqual([
                expect.objectContaining({
                    command: 'Write-Output fixture',
                    workingDirectory: 'C:/fixture',
                    timeoutMs: 120000,
                }),
            ]);
            expect(result).toMatchObject({ isError: false, status: 'success' });
            expect(result.result).toContain('fixture output');
        } finally {
            tools.dispose();
        }
    });

    it('user stops a shell wait without late output updating the cancelled task', async () => {
        const { tools } = await fixture();
        let finish!: () => void;
        let enter!: () => void;
        const entered = new Promise<void>((resolve) => {
            enter = resolve;
        });
        boundary.run = async (_request, options) => {
            enter();
            await new Promise<void>((resolve) => {
                finish = resolve;
            });
            options.onOutputDelta?.({
                stdout: 'late output',
                stderr: '',
                combinedOutput: 'late output',
            });
            return {
                command: 'fixture',
                shell: 'powershell',
                workingDirectory: 'C:/fixture',
                exitCode: 0,
                success: true,
                timedOut: false,
                cancelled: false,
                durationMs: 10,
                stdout: 'late output',
                stderr: '',
                combinedOutput: 'late output',
            };
        };
        const controller = new AbortController();
        const events: ToolEvent[] = [];
        const scope: ToolInvocationScope = {
            iteration: 0,
            signal: controller.signal,
            requestApproval: async () => true,
            task: {
                taskId: 'task',
                attemptToken: 'attempt',
                attemptGeneration: 1,
                historyTarget: { sessionId: 1, messageId: 1 },
                signal: new AbortController().signal,
                stop: () => {},
                currentModel: {
                    key: 'model',
                    id: 1,
                    provider_id: 1,
                    provider_name: 'Fixture',
                    model_id: 'fixture',
                    name: 'Fixture',
                    supportsImages: false,
                },
                ask: async () => null,
                present: (event) => events.push(event),
            },
        };
        try {
            const result = (await tools.snapshot()).execute(
                {
                    id: 'call',
                    name: 'builtin__bash',
                    arguments: '{"command":"Write-Output fixture","reason":"fixture request"}',
                },
                scope
            );
            await entered;
            controller.abort();
            expect(await result).toMatchObject({
                result: 'request_cancelled',
                sideEffect: 'unknown',
            });
            expect(boundary.cancelled).toEqual([boundary.requests[0]?.executionId]);
            finish();
            await Promise.resolve();
            await Promise.resolve();
            expect(events.filter((event) => event.type === 'result_delta')).toEqual([]);
        } finally {
            finish?.();
            tools.dispose();
        }
    });
});
