import { createMcpHostFixture } from '@tests/utils/mcpHost';
import { getTauriInvokeCalls, mockTauriCommand } from '@tests/utils/tauri';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { setLocale } from '@/i18n';
import { ToolExecutionError } from '@/modules/tools';
import { MCP_TIMEOUT_GUARD_GRACE_MS } from '@/modules/tools/mcp/formatting';
import { TOOL_TIMEOUT_MAX_MS } from '@/utils/timeouts';

afterEach(() => {
    vi.useRealTimers();
    setLocale('zh-CN');
});

async function prepared(timeout = 30000) {
    const input = createMcpHostFixture({ timeout });
    await input.connections.connect(1);
    return { ...input, snapshot: await input.tools.snapshot() };
}
const call = (requested?: number) => ({
    id: 'call',
    name: 'mcp__1__read_file',
    arguments: JSON.stringify(requested === undefined ? {} : { _meta: { timeoutMs: requested } }),
});

describe('given a captured server timeout and model execution metadata', () => {
    it.each([
        [undefined, 30000],
        [5000, 5000],
        [TOOL_TIMEOUT_MAX_MS * 10, 30000],
        [-1, 30000],
    ] as const)(
        'user requests %s milliseconds and waits exactly for the effective %s millisecond native guard',
        async (requested, effective) => {
            const input = await prepared();
            vi.useFakeTimers();
            mockTauriCommand('mcp_call_tool', () => new Promise(() => undefined));
            const pending = input.snapshot
                .execute(call(requested), { iteration: 0 })
                .catch((error: unknown) => {
                    expect(error).toBeInstanceOf(ToolExecutionError);
                    return (error as ToolExecutionError).outcome;
                });
            let finished = false;
            void pending.then(() => {
                finished = true;
            });
            await vi.advanceTimersByTimeAsync(0);
            expect(getTauriInvokeCalls('mcp_call_tool').map(({ payload }) => payload)).toEqual([
                { serverId: 1, toolName: 'read_file', arguments: {}, timeoutMs: effective },
            ]);
            await vi.advanceTimersByTimeAsync(effective + MCP_TIMEOUT_GUARD_GRACE_MS - 1);
            expect(finished).toBe(false);
            await vi.advanceTimersByTimeAsync(1);
            expect(await pending).toMatchObject({ isError: true, sideEffect: 'unknown' });
            expect((await pending).result).toContain(`${effective}ms`);
        }
    );

    it.each([undefined, 5000])(
        'user receives a completed result when the %s millisecond request finishes before its deadline',
        async (requested) => {
            const input = await prepared();
            expect(await input.snapshot.execute(call(requested), { iteration: 0 })).toMatchObject({
                isError: false,
                result: 'ok',
            });
            expect(getTauriInvokeCalls('mcp_call_tool').map(({ payload }) => payload)).toEqual([
                {
                    serverId: 1,
                    toolName: 'read_file',
                    arguments: {},
                    timeoutMs: requested ?? 30000,
                },
            ]);
        }
    );

    it.each([0, -1])(
        'user sees the configured %s timeout disabled without a native deadline',
        async (timeout) => {
            const input = await prepared(timeout);
            expect(input.snapshot.declarations[0]?.adaptiveTimeoutCeilingMs).toBeUndefined();
            expect(await input.snapshot.execute(call(), { iteration: 0 })).toMatchObject({
                isError: false,
            });
            expect(getTauriInvokeCalls('mcp_call_tool').map(({ payload }) => payload)).toEqual([
                { serverId: 1, toolName: 'read_file', arguments: {}, timeoutMs: undefined },
            ]);
        }
    );

    it('user reads a native timeout in the current language with the captured deadline', async () => {
        setLocale('zh-CN');
        const input = await prepared();
        mockTauriCommand('mcp_call_tool', () => {
            throw new Error('Tool execution timed out (5000ms)');
        });
        const outcome = await input.snapshot
            .execute(call(5000), { iteration: 0 })
            .catch((error: unknown) => {
                expect(error).toBeInstanceOf(ToolExecutionError);
                return (error as ToolExecutionError).outcome;
            });
        expect(outcome.isError).toBe(true);
        expect(outcome.result).toContain('工具执行超时（5000ms）');
    });

    it('user receives an invalid timeout failure before any native effect and can use the next valid binding', async () => {
        const input = await prepared(1e20);
        const outcome = await input.snapshot
            .execute(call(), { iteration: 0 })
            .catch((error: unknown) => {
                expect(error).toBeInstanceOf(ToolExecutionError);
                return (error as ToolExecutionError).outcome;
            });
        expect(outcome.isError).toBe(true);
        expect(outcome.result).toContain('服务器工具超时配置无效');
        expect(getTauriInvokeCalls('mcp_call_tool')).toEqual([]);
        input.database.exec('UPDATE mcp_servers SET tool_timeout = 30000');
        expect(
            await (await input.tools.snapshot()).execute(call(), { iteration: 0 })
        ).toMatchObject({ isError: false });
    });

    it('user is not cut off by a timer overflow for a long native deadline', async () => {
        const input = await prepared(2147483648);
        vi.useFakeTimers();
        mockTauriCommand('mcp_call_tool', () => new Promise(() => undefined));
        const cancellation = new AbortController();
        const pending = input.snapshot.execute(call(), {
            iteration: 0,
            signal: cancellation.signal,
        });
        let finished = false;
        void pending.then(() => {
            finished = true;
        });
        await vi.advanceTimersByTimeAsync(2147483647);
        expect(finished).toBe(false);
        cancellation.abort();
        expect(await pending).toMatchObject({
            failureCode: 'request_cancelled',
            sideEffect: 'unknown',
        });
    });

    it.each([
        [30000, 30000],
        [0, undefined],
        [500, undefined],
    ] as const)(
        'user sees the saved %s millisecond server limit advertised as %s when preparing a turn',
        async (timeout, ceiling) => {
            expect(
                (await prepared(timeout)).snapshot.declarations[0]?.adaptiveTimeoutCeilingMs
            ).toBe(ceiling);
        }
    );
});
