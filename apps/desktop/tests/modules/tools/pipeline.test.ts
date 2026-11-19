import { describe, expect, it } from 'vitest';

import type { PreparedTool, ToolOutcome, ToolRegistration } from '@/modules/tools';
import { createTools } from '@/modules/tools';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((accept) => {
        resolve = accept;
    });
    return { promise, resolve };
}

function registration(prepared: PreparedTool): ToolRegistration {
    return { name: 'mcp__1__write', source: 'mcp', prepare: async () => prepared };
}

const declaration = {
    name: 'mcp__1__write',
    description: 'write',
    input_schema: { type: 'object' as const, properties: {} },
};
const call = { id: 'call', name: declaration.name, arguments: '{}' };
const approval = {
    title: 'fixture',
    description: '',
    command: 'write',
    riskLabel: 'high',
    reason: '',
    commandLabel: '',
    approveLabel: '',
    rejectLabel: '',
    enterHint: '',
    escHint: '',
};

describe('given asynchronous approvals, cancellation and durable tool observations', () => {
    it('user cannot start a revoked effect after approving an earlier declaration', async () => {
        let allowed = true;
        const decision = deferred<boolean>();
        const waiting = deferred<void>();
        const tools = createTools({
            registrations: [
                registration({
                    declaration,
                    authorize: async () => allowed,
                    approval: async () => approval,
                    execute: async () => ({ result: 'unexpected effect', isError: false }),
                }),
            ],
            formatError: (code) => code,
        });
        const snapshot = await tools.snapshot();
        const result = snapshot.execute(call, {
            iteration: 0,
            requestApproval: async () => {
                waiting.resolve();
                return decision.promise;
            },
        });
        await waiting.promise;
        allowed = false;
        decision.resolve(true);
        expect(await result).toMatchObject({
            result: 'tool_unavailable',
            isError: true,
            sideEffect: 'none',
        });
        tools.dispose();
    });

    it('user cancels a remote wait without claiming the remote side effect stopped or accepting its late success', async () => {
        const remote = deferred<{ result: string; isError: boolean }>();
        const running = deferred<void>();
        const stored: ToolOutcome[] = [];
        const controller = new AbortController();
        const tools = createTools({
            registrations: [
                registration({
                    declaration,
                    authorize: async () => true,
                    execute: async () => {
                        running.resolve();
                        return remote.promise;
                    },
                }),
            ],
            formatError: (code) => code,
            beginAudit: async () => ({
                finish: async (outcome) => {
                    stored.push(outcome);
                },
            }),
        });
        const snapshot = await tools.snapshot();
        const result = snapshot.execute(call, { iteration: 0, signal: controller.signal });
        await running.promise;
        controller.abort();
        expect(await result).toMatchObject({
            result: 'request_cancelled',
            isError: true,
            sideEffect: 'unknown',
        });
        remote.resolve({ result: 'late success', isError: false });
        await remote.promise;
        expect(stored.map((outcome) => outcome.result)).toEqual(['request_cancelled']);
        tools.dispose();
    });

    it('user disposal releases an approval wait and refuses subsequent snapshots', async () => {
        const waiting = deferred<void>();
        const tools = createTools({
            registrations: [
                registration({
                    declaration,
                    authorize: async () => true,
                    approval: async () => approval,
                    execute: async () => ({ result: 'unexpected effect', isError: false }),
                }),
            ],
            formatError: (code) => code,
        });
        const snapshot = await tools.snapshot();
        const result = snapshot.execute(call, {
            iteration: 0,
            requestApproval: async () => {
                waiting.resolve();
                return new Promise<boolean>(() => {});
            },
        });
        await waiting.promise;
        tools.dispose();
        expect(await result).toMatchObject({ result: 'request_cancelled', sideEffect: 'none' });
        await expect(tools.snapshot()).rejects.toThrow('disposed');
    });

    it('user does not receive durable success after a completed effect fails its save barrier', async () => {
        let storageAvailable = false;
        const stored: string[] = [];
        const tools = createTools({
            registrations: [
                registration({
                    declaration,
                    authorize: async () => true,
                    execute: async () => ({ result: 'effect completed', isError: false }),
                }),
            ],
            formatError: (code) => code,
            beginAudit: async () => ({
                finish: async (outcome) => {
                    if (!storageAvailable) throw new Error('fixture save failure');
                    stored.push(outcome.result);
                },
            }),
        });
        const snapshot = await tools.snapshot();
        await expect(snapshot.execute(call, { iteration: 0 })).rejects.toMatchObject({
            outcome: { result: 'execution_failed', sideEffect: 'unknown', isError: true },
        });
        expect(stored).toEqual([]);
        storageAvailable = true;
        expect(
            await snapshot.execute({ ...call, id: 'separate-explicit-call' }, { iteration: 1 })
        ).toMatchObject({ sideEffect: 'completed' });
        expect(stored).toEqual(['effect completed']);
        tools.dispose();
    });

    it('user retains rejected call results durably for invalid, revoked and excluded tools without starting effects', async () => {
        const stored: { id: string; result: string }[] = [];
        const tools = createTools({
            registrations: [
                registration({
                    declaration,
                    authorize: async () => false,
                    execute: async () => ({ result: 'unexpected effect', isError: false }),
                }),
            ],
            formatError: (code) => code,
            beginAudit: async (request) => ({
                receiptKey: `receipt-${request.id}`,
                finish: async (outcome) => {
                    stored.push({ id: request.id, result: outcome.result });
                },
            }),
        });
        const snapshot = await tools.snapshot();
        const invalid = await snapshot.execute(
            { ...call, id: 'invalid', arguments: '[]' },
            { iteration: 0 }
        );
        const revoked = await snapshot.execute({ ...call, id: 'revoked' }, { iteration: 0 });
        const excluded = await (
            await tools.snapshot({ excludedNames: [call.name] })
        ).execute({ ...call, id: 'excluded' }, { iteration: 0 });
        expect(stored).toEqual([
            { id: 'invalid', result: 'invalid_arguments' },
            { id: 'revoked', result: 'tool_unavailable' },
            { id: 'excluded', result: 'tool_unavailable' },
        ]);
        expect(invalid).toMatchObject({
            sideEffect: 'none',
            receiptKey: 'receipt-invalid',
            failureCode: 'invalid_arguments',
        });
        expect(revoked).toMatchObject({ sideEffect: 'none', receiptKey: 'receipt-revoked' });
        expect(excluded).toMatchObject({ sideEffect: 'none', receiptKey: 'receipt-excluded' });
        tools.dispose();
    });

    it('user sees malformed protocol input rejected before availability even when its tool is excluded', async () => {
        const stored: ToolOutcome[] = [];
        const tools = createTools({
            registrations: [],
            formatError: (code) => code,
            beginAudit: async () => ({
                finish: async (outcome) => {
                    stored.push(outcome);
                },
            }),
        });
        try {
            const snapshot = await tools.snapshot();
            expect(
                await snapshot.execute({ ...call, arguments: '[' }, { iteration: 0 })
            ).toMatchObject({
                result: 'invalid_arguments',
                sideEffect: 'none',
                argumentParseFailed: true,
            });
            expect(await snapshot.execute(call, { iteration: 0 })).toMatchObject({
                result: 'tool_unavailable',
                sideEffect: 'none',
            });
            expect(stored.map((outcome) => outcome.failureCode)).toEqual([
                'invalid_arguments',
                'tool_unavailable',
            ]);
        } finally {
            tools.dispose();
        }
    });
});
