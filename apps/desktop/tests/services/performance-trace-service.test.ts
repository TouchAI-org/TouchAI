import { beforeEach, describe, expect, it } from 'vitest';

import {
    clearPerformanceTrace,
    getPerformanceTraceSnapshot,
    markPerformanceTrace,
    setPerformanceTraceEnabled,
} from '@/services/PerformanceTraceService';

describe('PerformanceTraceService', () => {
    beforeEach(() => {
        clearPerformanceTrace();
        setPerformanceTraceEnabled(false);
    });

    it('does nothing while disabled', () => {
        markPerformanceTrace('search.resize.observed', { height: 180 });

        expect(getPerformanceTraceSnapshot()).toEqual([]);
    });

    it('stores bounded trace events while enabled', () => {
        setPerformanceTraceEnabled(true, { capacity: 3, now: () => 10 });

        markPerformanceTrace('search.resize.observed', { height: 180 });
        markPerformanceTrace('search.resize.requested', { height: 200 });
        markPerformanceTrace('search.resize.committed', { height: 200 });
        markPerformanceTrace('search.resize.settled', { height: 200 });

        expect(getPerformanceTraceSnapshot()).toEqual([
            {
                name: 'search.resize.requested',
                at: 10,
                fields: { height: 200 },
            },
            {
                name: 'search.resize.committed',
                at: 10,
                fields: { height: 200 },
            },
            {
                name: 'search.resize.settled',
                at: 10,
                fields: { height: 200 },
            },
        ]);
    });

    it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
        'normalizes invalid capacity %s to an empty bounded buffer',
        (capacity) => {
            setPerformanceTraceEnabled(true, { capacity, now: () => 10 });

            markPerformanceTrace('search.resize.observed', { height: 180 });

            expect(getPerformanceTraceSnapshot()).toEqual([]);
        }
    );

    it('trims existing trace events when capacity is lowered', () => {
        setPerformanceTraceEnabled(true, { capacity: 3, now: () => 10 });

        markPerformanceTrace('search.resize.observed', { height: 180 });
        markPerformanceTrace('search.resize.requested', { height: 200 });
        markPerformanceTrace('search.resize.committed', { height: 200 });

        setPerformanceTraceEnabled(true, { capacity: 2 });

        expect(getPerformanceTraceSnapshot()).toEqual([
            {
                name: 'search.resize.requested',
                at: 10,
                fields: { height: 200 },
            },
            {
                name: 'search.resize.committed',
                at: 10,
                fields: { height: 200 },
            },
        ]);
    });
});
