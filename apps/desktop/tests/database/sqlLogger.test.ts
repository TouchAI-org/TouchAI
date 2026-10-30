import { beforeEach, describe, expect, it, vi } from 'vitest';

const { debugMock } = vi.hoisted(() => ({ debugMock: vi.fn() }));

vi.mock('@services/ObservabilityService', () => ({
    log: { debug: debugMock, info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn() },
}));

import { createSqlLogger } from '@/database/sqlLogger';

interface SqlLogWindow {
    __TOUCHAI_SQL_LOG__?: boolean;
}

function setParamLogging(enabled: boolean | undefined) {
    const target = window as Window & SqlLogWindow;
    if (enabled === undefined) {
        delete target.__TOUCHAI_SQL_LOG__;
        return;
    }

    target.__TOUCHAI_SQL_LOG__ = enabled;
}

describe('when the dev build logs sql statements', () => {
    beforeEach(() => {
        debugMock.mockReset();
        setParamLogging(undefined);
    });

    it('user only sees the statement shape and the parameter count by default', () => {
        const logger = createSqlLogger();

        logger.logQuery('select * from "messages" where "session_id" = ?', [7, 8]);

        expect(debugMock).toHaveBeenCalledWith(
            'Query: select * from "messages" where "session_id" = ? -- params: 2'
        );
    });

    it('user does not get a megabyte of tool output in the log', () => {
        const logger = createSqlLogger();

        logger.logQuery('insert into "message_parts" values (?)', ['x'.repeat(500_000)]);

        const message = String(debugMock.mock.calls[0]?.[0] ?? '');
        expect(message).toContain('-- params: 1');
        expect(message.length).toBeLessThan(200);
    });

    it('drops the statement tail once it is too long to read', () => {
        const logger = createSqlLogger();

        logger.logQuery(`select ${'a'.repeat(600)}`, []);

        const message = String(debugMock.mock.calls[0]?.[0] ?? '');
        expect(message.length).toBeLessThan(500);
        expect(message).toContain('…');
    });

    it('user gets the real parameters when they opt in from the console', () => {
        setParamLogging(true);
        const logger = createSqlLogger();

        logger.logQuery('select 1', ['alpha']);

        expect(debugMock).toHaveBeenCalledWith('Query: select 1 -- params: ["alpha"]');
    });

    it('user gets a truncated preview for very large parameters even after opting in', () => {
        setParamLogging(true);
        const logger = createSqlLogger();

        logger.logQuery('insert into "message_parts" values (?)', ['x'.repeat(5000)]);

        const message = String(debugMock.mock.calls[0]?.[0] ?? '');
        expect(message).toContain('…(5004 chars)');
    });
});
