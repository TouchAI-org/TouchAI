import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPerfTrace, getPerfSamples, resetPerfSamples } from '@/utils/perfTrace';

describe('perfTrace', () => {
    beforeEach(() => {
        resetPerfSamples();
        vi.restoreAllMocks();
    });

    afterEach(() => {
        resetPerfSamples();
        vi.restoreAllMocks();
    });

    it('records a sample with the measured duration', () => {
        let now = 1000;
        vi.spyOn(performance, 'now').mockImplementation(() => now);

        const trace = createPerfTrace('search.query');
        now = 1012.5;
        trace.end();

        const samples = getPerfSamples();
        expect(samples).toHaveLength(1);
        expect(samples[0]).toMatchObject({
            label: 'search.query',
            durationMs: 12.5,
        });
        expect(typeof samples[0]!.at).toBe('number');
    });

    it('attaches optional details and ignores double end() calls', () => {
        const trace = createPerfTrace('task.publish');
        trace.end({ messages: 42 });
        trace.end({ messages: 99 });

        const samples = getPerfSamples();
        expect(samples).toHaveLength(1);
        expect(samples[0]!.details).toEqual({ messages: 42 });
    });

    it('keeps a bounded ring buffer', () => {
        for (let index = 0; index < 220; index += 1) {
            createPerfTrace(`sample.${index}`).end();
        }

        const samples = getPerfSamples();
        expect(samples.length).toBeLessThanOrEqual(200);
        expect(samples[samples.length - 1]!.label).toBe('sample.219');
    });

    it('can be disabled without recording anything', () => {
        const trace = createPerfTrace('disabled.sample', { enabled: false });
        trace.end();

        expect(getPerfSamples()).toHaveLength(0);
    });
});
