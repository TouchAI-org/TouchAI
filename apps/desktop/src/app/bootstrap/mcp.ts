import { z } from 'zod';

import { McpCommandError, type McpManagementApi, type McpStatus } from '@/app/api/tools/mcp';
import type { McpCatalog } from '@/modules/tools/public';
import { emitWindowEvent, listenWindowEvent } from '@/platform/windows/events';
import { awaitAbortable, combineAbortSignals } from '@/utils/abort';

const REQUEST_EVENT = 'tools:mcp:request';
const REPLY_EVENT = 'tools:mcp:reply';
const DEADLINES = { connect: 15_000, disconnect: 5_000, statuses: 5_000 } as const;
type Operation = keyof typeof DEADLINES;
const fields = { requestId: z.uuid(), from: z.literal('settings') };
const requestSchema = z.discriminatedUnion('operation', [
    z.strictObject({
        ...fields,
        operation: z.literal('connect'),
        serverId: z.number().int().positive(),
    }),
    z.strictObject({
        ...fields,
        operation: z.literal('disconnect'),
        serverId: z.number().int().positive(),
    }),
    z.strictObject({ ...fields, operation: z.literal('statuses') }),
]);
const statusesSchema = z.array(
    z.strictObject({
        serverId: z.number().int().positive(),
        status: z.enum(['disconnected', 'connecting', 'connected', 'error']),
        error: z.string().nullable(),
    })
);
const replySchema = z.discriminatedUnion('ok', [
    z.strictObject({ requestId: z.uuid(), ok: z.literal(true), statuses: statusesSchema }),
    z.strictObject({
        requestId: z.uuid(),
        ok: z.literal(false),
        code: z.enum(['MCP_COMMAND_UNCONFIRMED', 'MCP_COMMAND_FAILED', 'MCP_COMMAND_UNAVAILABLE']),
        outcome: z.enum(['none', 'unknown']),
    }),
]);

/** Connection management only. Tool effects are never exposed over this window channel. */
export function createMcpWindow(input: {
    label: string | null;
    signal: AbortSignal;
    catalog: McpCatalog;
    run?(
        operation: Operation,
        serverId: number | undefined,
        signal: AbortSignal
    ): Promise<McpStatus[]>;
    warn(code: string): void;
}) {
    const pending = new Map<
        string,
        { finish(result: { statuses: McpStatus[] } | { error: McpCommandError }): void }
    >();
    let disposed = input.signal.aborted;
    let stop: (() => void) | undefined;
    let running = 0;
    const warn = () => {
        try {
            input.warn('MCP_COMMAND_FAILED');
        } catch {
            /* Passive diagnostics. */
        }
    };
    const supported = input.label === 'main' || input.label === 'settings';

    async function run(operation: Operation, serverId?: number): Promise<McpStatus[]> {
        if (disposed || !input.run || running >= 16)
            throw new McpCommandError('MCP_COMMAND_UNAVAILABLE', 'none');
        running++;
        const deadline = new AbortController();
        const timer = setTimeout(
            () => deadline.abort(new McpCommandError('MCP_COMMAND_UNCONFIRMED', 'unknown')),
            DEADLINES[operation]
        );
        const combined = combineAbortSignals([input.signal, deadline.signal]);
        const { signal } = combined;
        try {
            return statusesSchema.parse(
                await awaitAbortable(() => input.run!(operation, serverId, signal), signal)
            );
        } catch (error) {
            if (error instanceof McpCommandError) throw error;
            // Local failure cannot prove that native connection/disconnection had no effect.
            throw new McpCommandError('MCP_COMMAND_FAILED', 'unknown');
        } finally {
            combined.dispose();
            clearTimeout(timer);
            running--;
        }
    }

    async function serve(payload: unknown): Promise<void> {
        const parsed = requestSchema.safeParse(payload);
        if (!parsed.success || disposed) return;
        const request = parsed.data;
        let reply: z.infer<typeof replySchema>;
        try {
            reply = {
                requestId: request.requestId,
                ok: true,
                statuses: await run(
                    request.operation,
                    'serverId' in request ? request.serverId : undefined
                ),
            };
        } catch (failure) {
            const error = failure as McpCommandError;
            reply = {
                requestId: request.requestId,
                ok: false,
                code: error.code,
                outcome: error.outcome,
            };
        }
        if (!disposed) await emitWindowEvent(request.from, REPLY_EVENT, reply).catch(warn);
    }

    const ready = supported
        ? listenWindowEvent(
              input.label!,
              input.label === 'main' ? REQUEST_EVENT : REPLY_EVENT,
              (payload) => {
                  if (input.label === 'main') {
                      void serve(payload).catch(warn);
                      return;
                  }
                  const parsed = replySchema.safeParse(payload);
                  if (!parsed.success) return;
                  const reply = parsed.data;
                  pending
                      .get(reply.requestId)
                      ?.finish(
                          reply.ok
                              ? { statuses: reply.statuses }
                              : { error: new McpCommandError(reply.code, reply.outcome) }
                      );
              }
          ).then((unlisten) => {
              if (disposed) unlisten();
              else stop = unlisten;
          })
        : Promise.resolve();
    void ready.catch(warn);

    async function request(operation: Operation, serverId?: number): Promise<McpStatus[]> {
        if (
            disposed ||
            !supported ||
            (serverId !== undefined && (!Number.isSafeInteger(serverId) || serverId <= 0))
        ) {
            throw new McpCommandError('MCP_COMMAND_UNAVAILABLE', 'none');
        }
        if (input.label === 'main') return run(operation, serverId);
        if (pending.size >= 16) throw new McpCommandError('MCP_COMMAND_UNAVAILABLE', 'none');
        const requestId = crypto.randomUUID();
        return new Promise<McpStatus[]>((resolve, reject) => {
            const finish = (result: { statuses: McpStatus[] } | { error: McpCommandError }) => {
                if (!pending.delete(requestId)) return;
                clearTimeout(timer);
                if ('statuses' in result) resolve(result.statuses);
                else reject(result.error);
            };
            const timer = setTimeout(
                () => finish({ error: new McpCommandError('MCP_COMMAND_UNCONFIRMED', 'unknown') }),
                DEADLINES[operation]
            );
            pending.set(requestId, { finish });
            void ready
                .then(async () => {
                    if (!pending.has(requestId)) return;
                    await emitWindowEvent('main', REQUEST_EVENT, {
                        operation,
                        requestId,
                        from: 'settings',
                        ...(serverId === undefined ? {} : { serverId }),
                    });
                })
                .catch(() =>
                    finish({ error: new McpCommandError('MCP_COMMAND_UNAVAILABLE', 'none') })
                );
        });
    }

    const api = Object.freeze<McpManagementApi>({
        async listServers() {
            if (disposed || !supported)
                throw new McpCommandError('MCP_COMMAND_UNAVAILABLE', 'none');
            return awaitAbortable(input.catalog.listServers, input.signal);
        },
        async listTools(serverId) {
            if (disposed || !supported || !Number.isSafeInteger(serverId) || serverId <= 0)
                throw new McpCommandError('MCP_COMMAND_UNAVAILABLE', 'none');
            return awaitAbortable(() => input.catalog.listTools(serverId), input.signal);
        },
        async connectServer(serverId) {
            await request('connect', serverId);
        },
        async disconnectServer(serverId) {
            await request('disconnect', serverId);
        },
        refreshAllServerStatuses: () => request('statuses'),
    });
    function dispose(): void {
        if (disposed) return;
        disposed = true;
        stop?.();
        stop = undefined;
        for (const entry of [...pending.values()])
            entry.finish({ error: new McpCommandError('MCP_COMMAND_UNCONFIRMED', 'unknown') });
        input.signal.removeEventListener('abort', dispose);
    }
    input.signal.addEventListener('abort', dispose, { once: true });
    return Object.freeze({ api, ready, dispose });
}
