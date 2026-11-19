import { routeQueriesTo } from '@tests/database/sqliteHarness';
import { createAuditedToolsFixture } from '@tests/utils/auditedTools';
import { getTauriInvokeCalls, mockTauriCommand } from '@tests/utils/tauri';
import { describe, expect, it } from 'vitest';

const navigate = (url = 'https://example.test/docs') => ({
    id: 'browser-call',
    name: 'builtin__browser',
    arguments: JSON.stringify({ operation: 'navigate', url, description: 'Open documentation' }),
});
const session = {
    id: '127.0.0.1:9222',
    label: 'Chrome - example.test',
    endpoint: 'http://127.0.0.1:9222',
    browserName: 'Chrome',
    currentUrl: 'https://example.test',
    title: 'Example',
    tabs: [],
};

describe('given browser calls use production descriptors and durable tool receipts', () => {
    it('user receives a recorded invalid operation without approval or native browser access', async () => {
        const input = await createAuditedToolsFixture();
        const approvals: unknown[] = [];
        const outcome = await (
            await input.snapshot()
        ).execute(
            {
                id: 'invalid',
                name: 'builtin__browser',
                arguments: '{"ref":"submit-button","navigationToken":"obs-1"}',
            },
            {
                ...input.scope,
                requestApproval: async (_id, approval) => {
                    approvals.push(approval);
                    return true;
                },
            }
        );
        expect(outcome).toMatchObject({
            isError: true,
            sideEffect: 'none',
            failureCode: 'invalid_arguments',
        });
        expect(approvals).toEqual([]);
        expect(getTauriInvokeCalls('browser_act')).toEqual([]);
        expect(input.saved()).toEqual([expect.objectContaining({ status: 'error' })]);
    });

    it('user approves once and sees one native navigation and one committed success', async () => {
        const input = await createAuditedToolsFixture();
        const approvals: string[] = [];
        const questions: unknown[] = [];
        input.scope.task!.ask = async (_id, value) => {
            questions.push(value);
            return null;
        };
        mockTauriCommand('browser_navigate', { ok: true });
        const outcome = await (
            await input.snapshot()
        ).execute(navigate(), {
            ...input.scope,
            requestApproval: async (_id, approval) => {
                approvals.push(approval.command);
                return true;
            },
        });
        expect(outcome.isError).toBe(false);
        expect(approvals).toEqual(['Open documentation']);
        expect(questions).toEqual([]);
        expect(getTauriInvokeCalls('browser_navigate').map(({ payload }) => payload)).toEqual([
            { request: { url: 'https://example.test/docs' } },
        ]);
        expect(input.saved()).toEqual([
            expect.objectContaining({ status: 'success', approval_state: 'approved' }),
        ]);
        expect(input.events.filter((event) => event.type === 'approval_required')).toHaveLength(1);
    });

    it('user rejects once and receives a committed rejection without a native effect', async () => {
        const input = await createAuditedToolsFixture();
        const approvals: string[] = [];
        const outcome = await (
            await input.snapshot()
        ).execute(navigate(), {
            ...input.scope,
            requestApproval: async (_id, approval) => {
                approvals.push(approval.command);
                return false;
            },
        });
        expect(outcome).toMatchObject({
            isError: true,
            failureCode: 'approval_rejected',
            sideEffect: 'none',
        });
        expect(approvals).toHaveLength(1);
        expect(getTauriInvokeCalls('browser_navigate')).toEqual([]);
        expect(input.saved()).toEqual([
            expect.objectContaining({ status: 'rejected', approval_state: 'rejected' }),
        ]);
    });

    it('user cancels while approval is saved and the recorded cancellation precedes any browser effect', async () => {
        const input = await createAuditedToolsFixture();
        routeQueriesTo(input.database, {
            afterQuery: ({ sql }) => {
                if (
                    sql.startsWith('update "message_parts"') &&
                    input.saved().some((part) => part.status === 'approved')
                )
                    input.controller.abort();
            },
        });
        const outcome = await (
            await input.snapshot()
        ).execute(navigate(), { ...input.scope, requestApproval: async () => true });
        expect(outcome).toMatchObject({ failureCode: 'request_cancelled', sideEffect: 'none' });
        expect(getTauriInvokeCalls('browser_navigate')).toEqual([]);
        expect(input.saved()).toEqual([expect.objectContaining({ status: 'cancelled' })]);
    });

    it('user cancels while live browser permissions load and no navigation begins afterwards', async () => {
        const input = await createAuditedToolsFixture();
        let approved = false;
        routeQueriesTo(input.database, {
            afterQuery: ({ sql, params }) => {
                if (
                    approved &&
                    sql.startsWith('select') &&
                    sql.includes('from "settings"') &&
                    params.includes('browser_settings')
                )
                    input.controller.abort();
            },
        });
        const outcome = await (
            await input.snapshot()
        ).execute(navigate(), {
            ...input.scope,
            requestApproval: async () => {
                approved = true;
                return true;
            },
        });
        expect(outcome).toMatchObject({ failureCode: 'request_cancelled' });
        expect(getTauriInvokeCalls('browser_navigate')).toEqual([]);
    });

    it('user performs a permitted navigation without an approval or duplicate question', async () => {
        const input = await createAuditedToolsFixture();
        input.database
            .prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
            .run('browser_settings', JSON.stringify({ permissions: { navigate: 'allow' } }));
        mockTauriCommand('browser_navigate', { ok: true });
        const approvals: unknown[] = [];
        expect(
            await (
                await input.snapshot()
            ).execute(navigate(), {
                ...input.scope,
                requestApproval: async (_id, approval) => {
                    approvals.push(approval);
                    return true;
                },
            })
        ).toMatchObject({ isError: false });
        expect(approvals).toEqual([]);
        expect(getTauriInvokeCalls('browser_navigate')).toHaveLength(1);
    });

    it('user chooses an existing browser once without a separate approval', async () => {
        const input = await createAuditedToolsFixture();
        mockTauriCommand('browser_discover_existing', [session]);
        mockTauriCommand('browser_connect_existing', { status: { status: 'connected' } });
        const questions: unknown[] = [];
        const approvals: unknown[] = [];
        input.scope.task!.ask = async (_id, value) => {
            questions.push(value);
            return [
                { questionIndex: 0, selectedLabels: ['1. Chrome - example.test'], skipped: false },
            ];
        };
        expect(
            await (
                await input.snapshot()
            ).execute(
                {
                    id: 'connect',
                    name: 'builtin__browser',
                    arguments:
                        '{"operation":"connect_existing","description":"Connect existing browser"}',
                },
                {
                    ...input.scope,
                    requestApproval: async (_id, approval) => {
                        approvals.push(approval);
                        return true;
                    },
                }
            )
        ).toMatchObject({ isError: false });
        expect(questions).toHaveLength(1);
        expect(approvals).toEqual([]);
        expect(
            getTauriInvokeCalls('browser_connect_existing').map(({ payload }) => payload)
        ).toEqual([{ request: { endpoint: session.endpoint } }]);
    });

    it('user cancels the existing-session chooser and no late native connection or error completion appears', async () => {
        const input = await createAuditedToolsFixture();
        mockTauriCommand('browser_discover_existing', [session]);
        input.scope.task!.ask = async () => {
            input.controller.abort();
            return null;
        };
        expect(
            await (
                await input.snapshot()
            ).execute(
                {
                    id: 'connect',
                    name: 'builtin__browser',
                    arguments:
                        '{"operation":"connect_existing","description":"Connect existing browser"}',
                },
                input.scope
            )
        ).toMatchObject({ failureCode: 'request_cancelled' });
        expect(getTauriInvokeCalls('browser_connect_existing')).toEqual([]);
        expect(input.saved()).toEqual([expect.objectContaining({ status: 'cancelled' })]);
    });
});
