import { getLastTauriInvokeCall, interceptTauriInvoke, mockTauriCommand } from '@tests/utils/tauri';
import { describe, expect, it } from 'vitest';

import { databaseRuntime } from '@/services/DatabaseRuntimeService';

describe('DatabaseRuntimeService', () => {
    it('forwards query requests through the native database runtime contract', async () => {
        mockTauriCommand('database_query', {
            rows: [{ id: 1, title: 'TouchAI' }],
            rowsAffected: 0,
            lastInsertId: null,
        });

        await expect(
            databaseRuntime.query({
                sql: 'select id, title from sessions where id = ?',
                params: [1],
                method: 'get',
            })
        ).resolves.toEqual({
            rows: [{ id: 1, title: 'TouchAI' }],
            rowsAffected: 0,
            lastInsertId: null,
        });

        expect(getLastTauriInvokeCall('database_query')).toEqual({
            cmd: 'database_query',
            payload: {
                request: {
                    sql: 'select id, title from sessions where id = ?',
                    params: [1],
                    method: 'get',
                },
            },
        });
    });

    it('keeps transaction commands on the same runtime boundary', async () => {
        mockTauriCommand('database_tx_begin', 'tx-runtime-1');
        mockTauriCommand('database_tx_batch', [
            { rows: [], rowsAffected: 1, lastInsertId: 7 },
            { rows: [{ count: 1 }], rowsAffected: 0, lastInsertId: null },
        ]);
        mockTauriCommand('database_tx_commit', undefined);

        const txId = await databaseRuntime.txBegin('immediate');
        const batchResult = await databaseRuntime.txBatch(txId, [
            {
                sql: 'insert into sessions(title) values (?)',
                params: ['TouchAI'],
                method: 'run',
            },
            {
                sql: 'select count(*) as count from sessions',
                method: 'get',
            },
        ]);
        await databaseRuntime.txCommit(txId);

        expect(txId).toBe('tx-runtime-1');
        expect(batchResult).toEqual([
            { rows: [], rowsAffected: 1, lastInsertId: 7 },
            { rows: [{ count: 1 }], rowsAffected: 0, lastInsertId: null },
        ]);
        expect(getLastTauriInvokeCall('database_tx_begin')).toEqual({
            cmd: 'database_tx_begin',
            payload: { behavior: 'immediate' },
        });
        expect(getLastTauriInvokeCall('database_tx_batch')).toEqual({
            cmd: 'database_tx_batch',
            payload: {
                txId: 'tx-runtime-1',
                requests: [
                    {
                        sql: 'insert into sessions(title) values (?)',
                        params: ['TouchAI'],
                        method: 'run',
                    },
                    {
                        sql: 'select count(*) as count from sessions',
                        method: 'get',
                    },
                ],
            },
        });
        expect(getLastTauriInvokeCall('database_tx_commit')).toEqual({
            cmd: 'database_tx_commit',
            payload: { txId: 'tx-runtime-1' },
        });
    });

    it('does not swallow native database failures', async () => {
        const backendError = new Error('database runtime unavailable');
        interceptTauriInvoke((call, next) => {
            if (call.cmd === 'database_batch') {
                throw backendError;
            }

            return next();
        });

        await expect(
            databaseRuntime.batch([
                {
                    sql: 'select 1',
                    method: 'get',
                },
            ])
        ).rejects.toThrow(backendError);
    });
});
