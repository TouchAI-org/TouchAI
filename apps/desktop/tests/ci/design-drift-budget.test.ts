import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    DRIFT_RULES,
    evaluateAddedLines,
    evaluateBudget,
    resolveBaseRevisions,
} from '../../scripts/ci/design-drift-budget.mjs';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDirectory, '../../../..');

function budgetFor(overrides: Record<string, number> = {}) {
    return {
        budget: Object.fromEntries(
            DRIFT_RULES.map((rule) => [rule.id, overrides[rule.id] ?? 100])
        ) as Record<string, number>,
    };
}

function countsFor(overrides: Record<string, number> = {}) {
    return {
        counts: Object.fromEntries(
            DRIFT_RULES.map((rule) => [rule.id, overrides[rule.id] ?? 0])
        ) as Record<string, number>,
    };
}

describe('evaluateBudget', () => {
    it('passes when every count sits at or below the budget', () => {
        expect(evaluateBudget(countsFor({ arbitraryHexColor: 44 }), budgetFor())).toEqual([]);
    });

    it('fails when a count rises above the budget', () => {
        const errors = evaluateBudget(
            countsFor({ arbitraryHexColor: 45 }),
            budgetFor({ arbitraryHexColor: 44 })
        );

        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain('arbitraryHexColor: 45 occurrences exceeds the budget of 44');
    });

    it('allows counts to fall below the budget so the ratchet can tighten', () => {
        expect(
            evaluateBudget(
                countsFor({ arbitraryHexColor: 10 }),
                budgetFor({ arbitraryHexColor: 44 })
            )
        ).toEqual([]);
    });

    it('rejects a baseline that omits a rule, so rules cannot be disabled by deletion', () => {
        const baseline = budgetFor();
        delete baseline.budget.arbitraryHexColor;

        const errors = evaluateBudget(countsFor(), baseline);

        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain('missing a budget entry for "arbitraryHexColor"');
    });
});

describe('evaluateAddedLines', () => {
    it('rejects a newly added arbitrary hex colour even when totals are unchanged', () => {
        const errors = evaluateAddedLines(['const tone = "bg-[#f0f0ef]";']);

        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain('arbitraryHexColor');
    });

    it('rejects a newly added arbitrary font size', () => {
        const errors = evaluateAddedLines(['<div class="text-[13px]">x</div>']);

        expect(errors.some((error) => error.includes('arbitraryTextSize'))).toBe(true);
    });

    it('rejects a newly added raw button', () => {
        const errors = evaluateAddedLines(['<button type="button">Go</button>']);

        expect(errors.some((error) => error.includes('rawButton'))).toBe(true);
    });

    it('accepts added lines that only use tokens and primitives', () => {
        const errors = evaluateAddedLines([
            '<div class="bg-surface text-text-primary rounded-lg">x</div>',
            '<Button variant="primary">Go</Button>',
        ]);

        expect(errors).toEqual([]);
    });

    it('reports the offending line as a sample so the failure is actionable', () => {
        const errors = evaluateAddedLines(['  class="bg-[#e9e9e7]"']);

        expect(errors[0]).toContain('bg-[#e9e9e7]');
    });

    it('allows a rewrite that keeps drift the diff also removes', () => {
        // Tokenising one utility on a line that carries another pre-existing
        // arbitrary value must not be blocked: net drift is zero.
        const errors = evaluateAddedLines(
            ['<div class="bg-surface text-[13px]">x</div>'],
            ['<div class="bg-[#f0f0ef] text-[13px]">x</div>']
        );

        expect(errors).toEqual([]);
    });

    it('still blocks a rewrite that keeps drift and adds more', () => {
        const errors = evaluateAddedLines(
            ['<div class="bg-surface text-[13px] text-[11px]">x</div>'],
            ['<div class="bg-[#f0f0ef] text-[13px]">x</div>']
        );

        expect(errors.some((error) => error.includes('arbitraryTextSize'))).toBe(true);
    });

    it('nets each rule independently', () => {
        // The hex is removed but a new arbitrary font size appears, so the font-size
        // rule must still fail even though the hex rule is satisfied.
        const errors = evaluateAddedLines(
            ['<div class="bg-surface text-[9px]">x</div>'],
            ['<div class="bg-[#f0f0ef]">x</div>']
        );

        expect(errors.some((error) => error.includes('arbitraryHexColor'))).toBe(false);
        expect(errors.some((error) => error.includes('arbitraryTextSize'))).toBe(true);
    });
});

describe('baseline file', () => {
    it('records a budget entry for every rule', () => {
        const baseline = JSON.parse(
            readFileSync(resolve(repositoryRoot, 'design-system-baseline.json'), 'utf8')
        );

        for (const rule of DRIFT_RULES) {
            expect(baseline.budget, `missing budget for ${rule.id}`).toHaveProperty(rule.id);
            expect(typeof baseline.budget[rule.id]).toBe('number');
        }
    });

    it('does not contain budget entries for rules that no longer exist', () => {
        const baseline = JSON.parse(
            readFileSync(resolve(repositoryRoot, 'design-system-baseline.json'), 'utf8')
        );
        const knownRules = new Set(DRIFT_RULES.map((rule) => rule.id));

        for (const key of Object.keys(baseline.budget)) {
            expect(knownRules.has(key), `stale budget entry: ${key}`).toBe(true);
        }
    });

    it('declares the commit the numbers were measured on', () => {
        const baseline = JSON.parse(
            readFileSync(resolve(repositoryRoot, 'design-system-baseline.json'), 'utf8')
        );

        expect(baseline.measuredAt).toMatch(/^[0-9a-f]{7,40}$/);
    });
});

describe('DRIFT_RULES', () => {
    it('uses globally flagged patterns so counts do not leak state between files', () => {
        for (const rule of DRIFT_RULES) {
            expect(rule.pattern.global, `${rule.id} must use the g flag`).toBe(true);
        }
    });

    it('uses unique ids', () => {
        const ids = DRIFT_RULES.map((rule) => rule.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('matches raw tags by name boundary, not by prefix', () => {
        const rule = (id: string) => DRIFT_RULES.find((candidate) => candidate.id === id);

        for (const id of ['rawButton', 'rawInput', 'rawLabel']) {
            const pattern = rule(id)?.pattern;
            expect(pattern, `${id} missing`).toBeDefined();

            const tag = id.replace('raw', '').toLowerCase();
            expect(`<${tag}>`.match(pattern!)?.length, `${id} missed a bare tag`).toBe(1);
            expect(`<${tag} />`.match(pattern!)?.length, `${id} missed a self-closing tag`).toBe(1);
            expect(
                `<${tag} class="x">`.match(pattern!)?.length,
                `${id} missed a tag with attrs`
            ).toBe(1);

            // A longer custom element is a distinct component, not a raw tag.
            expect(
                `<${tag}-group>`.match(pattern!)?.length ?? 0,
                `${id} matched a longer element name`
            ).toBe(0);
        }
    });
});

describe('diff scan', () => {
    let fixtureRoot: string;

    beforeEach(() => {
        fixtureRoot = mkdtempSync(join(tmpdir(), 'design-drift-diff-'));
    });

    afterEach(() => {
        rmSync(fixtureRoot, { recursive: true, force: true });
    });

    it('includes files at the src root as well as nested ones', () => {
        /*
         * Git's default pathspec treats `**` as a single path segment, so
         * `apps/desktop/src/**\/*.vue` silently skips `apps/desktop/src/App.vue`.
         * The `:(glob)` magic restores recursive matching.
         *
         * Exercised against a real repository so the assertion is about git's
         * behaviour rather than about the string the script happens to contain.
         */
        const run = (...args: string[]) =>
            execFileSync('git', args, { cwd: fixtureRoot, encoding: 'utf8' });

        run('init', '--quiet');
        run('config', 'user.email', 'test@example.com');
        run('config', 'user.name', 'Test');

        const srcRoot = join(fixtureRoot, 'apps/desktop/src');
        const nested = join(srcRoot, 'views/SettingsView');
        mkdirSync(nested, { recursive: true });

        writeFileSync(join(srcRoot, 'App.vue'), '<template><div>one</div></template>\n');
        writeFileSync(join(nested, 'index.vue'), '<template><div>one</div></template>\n');
        run('add', '.');
        run('commit', '--quiet', '-m', 'base');

        writeFileSync(join(srcRoot, 'App.vue'), '<template><div>two</div></template>\n');
        writeFileSync(join(nested, 'index.vue'), '<template><div>two</div></template>\n');
        run('add', '.');
        run('commit', '--quiet', '-m', 'change');

        const diff = run(
            'diff',
            '--unified=0',
            'HEAD^1',
            '--',
            ':(glob)apps/desktop/src/**/*.vue',
            ':(glob)apps/desktop/src/**/*.ts'
        );

        expect(diff).toContain('apps/desktop/src/App.vue');
        expect(diff).toContain('apps/desktop/src/views/SettingsView/index.vue');
    });

    it('resolves the base to the first parent of the CI merge commit', () => {
        /*
         * Pull request CI checks out a synthetic merge commit and leaves the
         * checkout detached with no local branch refs. In that state `origin/main`,
         * `main` and the workflow-provided base SHA were all unreachable, which
         * made the job fail for a reason unrelated to the diff.
         *
         * `HEAD^1` is the base in that situation, so it has to come first. `HEAD^2`
         * is the pull request's own head and would produce an empty diff, which
         * would disable the check silently.
         */
        const previous = process.env.DESIGN_BUDGET_BASE_SHA;
        delete process.env.DESIGN_BUDGET_BASE_SHA;

        try {
            const candidates = resolveBaseRevisions();

            expect(candidates[0]).toBe('HEAD^1');
            expect(candidates).not.toContain('HEAD^2');
        } finally {
            if (previous === undefined) {
                delete process.env.DESIGN_BUDGET_BASE_SHA;
            } else {
                process.env.DESIGN_BUDGET_BASE_SHA = previous;
            }
        }
    });

    it('prefers the workflow-provided base over a guessed branch name', () => {
        const previous = process.env.DESIGN_BUDGET_BASE_SHA;
        process.env.DESIGN_BUDGET_BASE_SHA = 'deadbeef';

        try {
            const candidates = resolveBaseRevisions();

            expect(candidates[0]).toBe('HEAD^1');
            expect(candidates).toContain('deadbeef');
            expect(candidates.indexOf('deadbeef')).toBeLessThan(candidates.indexOf('origin/main'));
        } finally {
            if (previous === undefined) {
                delete process.env.DESIGN_BUDGET_BASE_SHA;
            } else {
                process.env.DESIGN_BUDGET_BASE_SHA = previous;
            }
        }
    });
});
