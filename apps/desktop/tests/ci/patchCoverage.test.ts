import { describe, expect, it } from 'vitest';

const { checkPatchCoverage, formatPatchCoverage, measurePatchCoverage, parseChangedLines } =
    await import('../../scripts/ci/coverage/patch-coverage.mjs');

/**
 * The global floor protects the repository as a whole, so a change that adds 400 uncovered
 * lines while covering 400 old ones slips through it. These cases pin the narrower rule: the
 * lines this change touched have to be exercised.
 */

const DIFF = `diff --git a/apps/desktop/src/feature.ts b/apps/desktop/src/feature.ts
index 111..222 100644
--- a/apps/desktop/src/feature.ts
+++ b/apps/desktop/src/feature.ts
@@ -10,2 +10,4 @@ export function feature() {
 const a = 1;
 const b = 2;
+const added = 3;
+const more = 4;
diff --git a/apps/desktop/src/deleted.ts b/apps/desktop/src/deleted.ts
deleted file mode 100644
--- a/apps/desktop/src/deleted.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-const gone = 1;
-const alsoGone = 2;
`;

describe('when the change adds lines to a file', () => {
    it('user gets the new line numbers counted, not the old ones', () => {
        const changed = parseChangedLines(DIFF);

        // The hunk starts at line 10; the two context lines advance to 12 and 13.
        const lines = changed.get('apps/desktop/src/feature.ts') ?? new Set<number>();
        expect([...lines].sort((a, b) => a - b)).toEqual([12, 13]);
    });

    it('user gets a deleted file left out entirely', () => {
        const changed = parseChangedLines(DIFF);

        // Removing code is not something a test can cover.
        expect(changed.has('apps/desktop/src/deleted.ts')).toBe(false);
    });

    it('user gets nothing counted for a diff with no additions', () => {
        expect(parseChangedLines('').size).toBe(0);
    });
});

function coverageFor(lines: number[], { covered = [] }: { covered?: number[] } = {}) {
    const statementMap: Record<
        number,
        { start: { line: number; column: number }; end: { line: number; column: number } }
    > = {};
    const s: Record<number, number> = {};
    lines.forEach((line, index) => {
        statementMap[index] = { start: { line, column: 0 }, end: { line, column: 1 } };
        s[index] = covered.includes(line) ? 1 : 0;
    });
    return { statementMap, s, branchMap: {}, b: {}, fnMap: {}, f: {} };
}

describe('user gets the changed lines measured against the report', () => {
    it('user gets full patch coverage when every changed line ran', () => {
        const changed = new Map([['apps/desktop/src/feature.ts', new Set([12, 13])]]);
        const report = {
            '/checkout/repo/apps/desktop/src/feature.ts': coverageFor([12, 13], {
                covered: [12, 13],
            }),
        };

        const result = measurePatchCoverage(changed, report, { repoRoot: 'repo' });

        expect(result.percent).toBe(100);
        expect(result.total).toBe(2);
    });

    it('user gets half the patch covered when only one changed line ran', () => {
        const changed = new Map([['apps/desktop/src/feature.ts', new Set([12, 13])]]);
        const report = {
            '/checkout/repo/apps/desktop/src/feature.ts': coverageFor([12, 13], { covered: [12] }),
        };

        const result = measurePatchCoverage(changed, report, { repoRoot: 'repo' });

        expect(result.percent).toBe(50);
        expect(result.files[0]).toMatchObject({ path: 'apps/desktop/src/feature.ts' });
    });

    it('user gets a changed file that no test loaded counted as uncovered', () => {
        const changed = new Map([['apps/desktop/src/brand-new.ts', new Set([1, 2, 3])]]);

        const result = measurePatchCoverage(changed, {}, { repoRoot: 'repo' });

        // Nothing imported it, so none of it ran.
        expect(result).toMatchObject({ total: 3, covered: 0, percent: 0 });
    });

    it('user gets test files ignored rather than dragging the number down', () => {
        const changed = new Map([['apps/desktop/tests/x.test.ts', new Set([1, 2])]]);

        const result = measurePatchCoverage(
            changed,
            {},
            {
                repoRoot: '.',
                ignore: (path) => path.startsWith('apps/desktop/tests/'),
            }
        );

        expect(result.total).toBe(0);
        expect(result.percent).toBe(100);
    });

    it('user gets blank and comment lines skipped rather than counted as failures', () => {
        const changed = new Map([['apps/desktop/src/feature.ts', new Set([10, 11, 12])]]);
        // Only line 12 carries a statement; 10 and 11 are blank or a comment.
        const report = {
            '/checkout/repo/apps/desktop/src/feature.ts': coverageFor([12], { covered: [12] }),
        };

        const result = measurePatchCoverage(changed, report, { repoRoot: 'repo' });

        expect(result.total).toBe(1);
        expect(result.percent).toBe(100);
    });

    it('user gets the worst files listed first so the fix is obvious', () => {
        const changed = new Map([
            ['apps/desktop/src/good.ts', new Set([1])],
            ['apps/desktop/src/bad.ts', new Set([1])],
        ]);
        const report = {
            '/checkout/repo/apps/desktop/src/good.ts': coverageFor([1], { covered: [1] }),
            'D:/repo/apps/desktop/src/bad.ts': coverageFor([1]),
        };

        const result = measurePatchCoverage(changed, report, { repoRoot: 'repo' });

        expect(result.files[0]!.path).toBe('apps/desktop/src/bad.ts');
    });
});

describe('user gets the patch gated on the floor', () => {
    it('user gets no failure when the patch meets the floor', () => {
        expect(checkPatchCoverage({ total: 10, covered: 9, percent: 90, files: [] }, 85)).toEqual(
            []
        );
    });

    it('user gets a failure naming the shortfall when the patch misses the floor', () => {
        const failures = checkPatchCoverage(
            {
                total: 10,
                covered: 4,
                percent: 40,
                files: [{ path: 'apps/desktop/src/x.ts', total: 10, covered: 4, percent: 40 }],
            },
            85
        );

        expect(failures).toHaveLength(1);
        expect(failures[0]).toContain('40.00%');
        expect(failures[0]).toContain('apps/desktop/src/x.ts');
    });

    it('user gets no failure for a change that touches no coverable line', () => {
        // A docs-only or comment-only change has nothing to cover.
        expect(checkPatchCoverage({ total: 0, covered: 0, percent: 100, files: [] }, 85)).toEqual(
            []
        );
    });

    it('user gets the summary table listing every measured file', () => {
        const markdown = formatPatchCoverage(
            {
                total: 4,
                covered: 3,
                percent: 75,
                files: [{ path: 'apps/desktop/src/x.ts', total: 4, covered: 3, percent: 75 }],
            },
            85
        );

        expect(markdown).toContain('### Patch coverage');
        expect(markdown).toContain('3/4 changed lines covered');
        expect(markdown).toContain('apps/desktop/src/x.ts');
    });
});

describe('when the diff base is not available', () => {
    it('user gets a clear failure instead of a silently empty diff', async () => {
        const { runPatchCoverage } =
            await import('../../scripts/ci/coverage/patch-coverage-cli.mjs');
        const { mkdtempSync, writeFileSync } = await import('node:fs');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');

        // A real report file, so the case is about the diff rather than a missing input.
        const dir = mkdtempSync(join(tmpdir(), 'patch-cov-'));
        const reportPath = join(dir, 'coverage-final.json');
        writeFileSync(reportPath, '{}', 'utf8');

        // A missing ref must not be reported as "nothing changed", which would pass the gate.
        expect(() =>
            runPatchCoverage(
                { coveragePath: reportPath, base: 'missing', root: '.', floor: 85 },
                {
                    readDiff: () => {
                        throw new Error('Cannot diff against "missing"');
                    },
                }
            )
        ).toThrow(/Cannot diff against/);
    });
});

describe('when main has moved on since the branch started', () => {
    it('user gets only their own commits measured, not everything merged since', async () => {
        const { runPatchCoverage } =
            await import('../../scripts/ci/coverage/patch-coverage-cli.mjs');
        const { mkdtempSync, writeFileSync } = await import('node:fs');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');

        const dir = mkdtempSync(join(tmpdir(), 'patch-cov-'));
        const reportPath = join(dir, 'coverage-final.json');
        writeFileSync(reportPath, '{}', 'utf8');

        const seen: string[] = [];
        runPatchCoverage(
            { coveragePath: reportPath, base: 'main-tip', root: '.', floor: 85 },
            {
                // The base ref is resolved before diffing, so the diff target is the merge
                // base rather than whatever main happens to point at now.
                resolveBase: (ref) => {
                    expect(ref).toBe('main-tip');
                    return 'merge-base-sha';
                },
                readDiff: (base) => {
                    seen.push(base);
                    return '';
                },
            }
        );

        expect(seen).toEqual(['merge-base-sha']);
    });
});

describe('when the base is empty', () => {
    it('user gets a clear configuration error rather than a git failure', async () => {
        const { parseArgs } = await import('../../scripts/ci/coverage/patch-coverage-cli.mjs');

        // A push event has no base; failing here explains why instead of surfacing git noise.
        expect(() =>
            parseArgs(['--coverage', 'report.json', '--base', ''], {} as NodeJS.ProcessEnv)
        ).toThrow(/Missing --base/);
    });
});
