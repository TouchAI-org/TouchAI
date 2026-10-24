import { describe, expect, it } from 'vitest';

import {
    applyFloor,
    decideNextFloor,
    readConfiguredFloor,
} from '../../scripts/raise-coverage-floor.mjs';

const CONFIG = [
    '      thresholds: {',
    '        statements: 75,',
    '        branches: 65,',
    '        functions: 74,',
    '        lines: 75,',
    "        'src/x/**/*.ts': { lines: 90 },",
    '      },',
].join('\n');

function measured(statements: number, branches: number, functions: number, lines: number) {
    return {
        statements: { pct: statements },
        branches: { pct: branches },
        functions: { pct: functions },
        lines: { pct: lines },
    };
}

describe('user raises the frontend coverage floor', () => {
    it('user sees the configured floor read from the config', () => {
        expect(readConfiguredFloor(CONFIG)).toEqual({
            statements: 75,
            branches: 65,
            functions: 74,
            lines: 75,
        });
    });

    it('user gets a raised floor just under what the suite reaches', () => {
        const { next, raised } = decideNextFloor(
            readConfiguredFloor(CONFIG),
            measured(80.9, 70.2, 79.5, 81.1)
        );

        expect(next).toEqual({ statements: 79, branches: 69, functions: 78, lines: 80 });
        expect(raised.map((entry) => entry.metric)).toEqual([
            'statements',
            'branches',
            'functions',
            'lines',
        ]);
    });

    it('user never sees the floor lowered when coverage drops', () => {
        const { next, raised } = decideNextFloor(
            readConfiguredFloor(CONFIG),
            measured(40, 30, 20, 10)
        );

        expect(next).toEqual({ statements: 75, branches: 65, functions: 74, lines: 75 });
        expect(raised).toEqual([]);
    });

    it('user keeps a metric at its committed floor when only some metrics improved', () => {
        const { next, raised } = decideNextFloor(
            readConfiguredFloor(CONFIG),
            measured(90.5, 30, 74.1, 75.2)
        );

        expect(next).toEqual({ statements: 89, branches: 65, functions: 74, lines: 75 });
        expect(raised.map((entry) => entry.metric)).toEqual(['statements']);
    });

    it('user sees only the global floor rewritten, leaving per-file floors alone', () => {
        const rewritten = applyFloor(CONFIG, {
            statements: 79,
            branches: 69,
            functions: 78,
            lines: 80,
        });

        expect(rewritten).toContain('        statements: 79,');
        expect(rewritten).toContain('        branches: 69,');
        expect(rewritten).toContain('        lines: 80,');
        expect(rewritten).toContain("'src/x/**/*.ts': { lines: 90 },");
    });

    it('user gets a clear failure when the config has no global floor', () => {
        expect(() => readConfiguredFloor('export default {}')).toThrow(
            'vitest.config.ts has no "thresholds:" block.'
        );
    });
});
