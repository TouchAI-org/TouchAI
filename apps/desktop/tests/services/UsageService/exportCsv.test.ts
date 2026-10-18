// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

import type { UsageCallRow } from '@database/queries/usageStats';
import { __testing } from '@services/UsageService/exportCsv';
import { describe, expect, it } from 'vitest';

const { escapeCsvField, toCsvLine, toCsvRow, HEADERS } = __testing;

function row(partial: Partial<UsageCallRow> = {}): UsageCallRow {
    return {
        partId: 1,
        messageId: 1,
        sessionId: 1,
        sessionTitle: 'Session',
        createdAt: '2026-05-01 10:00:00',
        modelName: 'Model',
        providerName: 'Provider',
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 900,
        cacheWriteTokens: 0,
        reasoningTokens: 5,
        costMicros: 1_234_567,
        priced: true,
        ttftMs: 800,
        durationMs: 2000,
        finishReason: 'stop',
        errorMessage: null,
        ...partial,
    };
}

describe('escapeCsvField', () => {
    it('leaves plain values alone', () => {
        expect(escapeCsvField('claude')).toBe('claude');
        expect(escapeCsvField(42)).toBe('42');
    });

    it('renders null and undefined as empty cells', () => {
        expect(escapeCsvField(null)).toBe('');
        expect(escapeCsvField(undefined)).toBe('');
    });

    it('quotes values containing a comma', () => {
        expect(escapeCsvField('a,b')).toBe('"a,b"');
    });

    it('doubles inner quotes', () => {
        expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""');
    });

    it('quotes values containing a newline', () => {
        expect(escapeCsvField('line1\nline2')).toBe('"line1\nline2"');
    });
});

describe('toCsvLine', () => {
    it('joins fields with commas', () => {
        expect(toCsvLine(['a', 1, true])).toBe('a,1,true');
    });
});

describe('toCsvRow', () => {
    it('emits one cell per header', () => {
        const cells = toCsvRow(row()).split(',');

        // 会话名与错误信息为空时不会多出列，列数必须与表头一致
        expect(cells).toHaveLength(HEADERS.length);
    });

    it('converts micro units to a six-decimal currency amount', () => {
        expect(toCsvRow(row({ costMicros: 1_234_567 })).split(',')[8]).toBe('1.234567');
    });

    it('keeps tiny costs visible instead of rounding to zero', () => {
        // 一次很便宜的调用可能是 30 微元 = 0.00003
        expect(toCsvRow(row({ costMicros: 30 })).split(',')[8]).toBe('0.000030');
    });

    it('marks unpriced calls so they can be excluded downstream', () => {
        const cells = toCsvRow(row({ costMicros: 0, priced: false })).split(',');

        expect(cells[8]).toBe('0.000000');
        expect(cells[9]).toBe('0');
    });

    it('marks priced calls', () => {
        expect(toCsvRow(row({ priced: true })).split(',')[9]).toBe('1');
    });

    it('escapes a model name containing a comma', () => {
        const line = toCsvRow(row({ modelName: 'vendor, model' }));

        expect(line).toContain('"vendor, model"');
    });

    it('keeps empty optional cells empty rather than writing null', () => {
        const cells = toCsvRow(row({ ttftMs: null, durationMs: null, finishReason: null })).split(
            ','
        );

        expect(cells[10]).toBe('');
        expect(cells[11]).toBe('');
        expect(cells[12]).toBe('');
    });
});

describe('HEADERS', () => {
    it('documents the exported column order', () => {
        expect(HEADERS[0]).toBe('created_at');
        expect(HEADERS).toContain('cost_usd');
        expect(HEADERS).toContain('priced');
    });
});
