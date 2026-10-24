// Copyright (c) 2026. 千诚. Licensed under GPL v3

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIRECTORY, '../../../..');
const SCAN_ROOT = join(REPOSITORY_ROOT, 'apps/desktop/src');
const BASELINE_PATH = join(REPOSITORY_ROOT, 'design-system-baseline.json');
const SCAN_EXTENSIONS = ['.vue', '.ts'];

/**
 * Each rule counts one class of design-system drift.
 *
 * `pattern` must carry the `g` flag: counts are taken from `matchAll`, so a
 * stateful `lastIndex` would leak between files.
 *
 * Adding a rule is a design-system decision, not a cleanup: it must ship with a
 * baseline entry measured on the commit that introduces it, otherwise the
 * ratchet treats the whole backlog as new drift and fails on an unrelated PR.
 */
export const DRIFT_RULES = [
    {
        id: 'arbitraryHexColor',
        description: 'Arbitrary hex colour in a utility class.',
        pattern:
            /(?:bg|text|border|ring|fill|stroke|from|to|via|divide|outline|decoration|accent|caret|placeholder|shadow|inset-ring)-\[#[0-9a-fA-F]{3,8}\]/g,
    },
    {
        id: 'arbitraryPixelValue',
        description: 'Arbitrary pixel value in a utility class.',
        pattern:
            /(?:leading|tracking|gap|gap-x|gap-y|p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|w|h|size|rounded|rounded-t|rounded-b|rounded-l|rounded-r|top|left|right|bottom|inset|min-w|min-h|max-w|max-h|space-x|space-y|translate-x|translate-y|indent|basis|shrink|grow)-\[\d+(?:\.\d+)?px\]/g,
    },
    {
        id: 'arbitraryTextSize',
        description: 'Arbitrary font size in a utility class.',
        pattern: /text-\[\d+(?:\.\d+)?px\]/g,
    },
    {
        id: 'bgWhite',
        description: 'bg-white bypasses the surface tokens.',
        pattern: /(?<![\w:-])bg-white(?![\w-])/g,
    },
    {
        id: 'textBlack',
        description: 'text-black bypasses the text tokens.',
        pattern: /(?<![\w:-])text-black(?![\w-])/g,
    },
    {
        id: 'neutralUtility',
        description: 'Direct neutral-palette utility instead of a semantic token.',
        pattern:
            /(?:bg|text|border|ring|divide|from|to|via|placeholder|fill|stroke|outline|shadow|accent|caret|decoration)-neutral-\d{2,3}(?![\w-])/g,
    },
    {
        id: 'grayUtility',
        description: 'Direct gray-palette utility instead of a semantic token.',
        pattern:
            /(?:bg|text|border|ring|divide|from|to|via|placeholder|fill|stroke|outline|shadow|accent|caret|decoration)-gray-\d{2,3}(?![\w-])/g,
    },
    {
        id: 'stoneUtility',
        description: 'Direct stone-palette utility instead of a semantic token.',
        pattern:
            /(?:bg|text|border|ring|divide|from|to|via|placeholder|fill|stroke|outline|shadow|accent|caret|decoration)-stone-\d{2,3}(?![\w-])/g,
    },
    {
        id: 'rawButton',
        description: 'Raw <button> instead of the Button primitive.',
        /*
         * A tag name ends at whitespace, `>`, or `/>`. Requiring one of those
         * avoids matching longer custom elements such as `<button-group>`, which
         * are distinct components rather than raw tags.
         */
        pattern: /<button(?=[\s/>])/g,
    },
    {
        id: 'rawInput',
        description: 'Raw <input> instead of the Input primitive.',
        pattern: /<input(?=[\s/>])/g,
    },
    {
        id: 'rawLabel',
        description: 'Raw <label> instead of the Field pattern.',
        pattern: /<label(?=[\s/>])/g,
    },
    {
        id: 'hardcodedMonoStack',
        description: 'Hardcoded monospace stack instead of the --font-mono token.',
        pattern: /'JetBrains Mono'/g,
    },
];

function listSourceFiles(directory) {
    const files = [];

    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const absolutePath = join(directory, entry.name);

        if (entry.isDirectory()) {
            files.push(...listSourceFiles(absolutePath));
            continue;
        }

        if (SCAN_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
            files.push(absolutePath);
        }
    }

    return files;
}

/**
 * Counts every rule across the desktop source tree.
 *
 * @param {string} [rootDirectory] Absolute directory to scan.
 * @returns {{ counts: Record<string, number>, files: Record<string, Record<string, number>> }}
 */
export function collectDrift(rootDirectory = SCAN_ROOT) {
    const counts = Object.fromEntries(DRIFT_RULES.map((rule) => [rule.id, 0]));
    const files = {};

    for (const absolutePath of listSourceFiles(rootDirectory)) {
        const source = readFileSync(absolutePath, 'utf8');
        const relativePath = relative(REPOSITORY_ROOT, absolutePath).replace(/\\/g, '/');
        const fileCounts = {};

        for (const rule of DRIFT_RULES) {
            const matches = source.match(rule.pattern);
            if (!matches || matches.length === 0) {
                continue;
            }

            fileCounts[rule.id] = matches.length;
            counts[rule.id] += matches.length;
        }

        if (Object.keys(fileCounts).length > 0) {
            files[relativePath] = fileCounts;
        }
    }

    return { counts, files };
}

/**
 * Compares current drift against the recorded baseline.
 *
 * The budget is a ratchet: counts may drop freely, and may never rise. Lowering
 * a number in `design-system-baseline.json` in the same PR that removes the
 * occurrences is the only supported way to change it.
 *
 * @param {{ counts: Record<string, number> }} current
 * @param {{ budget: Record<string, number> }} baseline
 * @returns {string[]}
 */
export function evaluateBudget(current, baseline) {
    const errors = [];

    for (const rule of DRIFT_RULES) {
        const budget = baseline.budget?.[rule.id];

        if (typeof budget !== 'number') {
            errors.push(
                `Baseline is missing a budget entry for "${rule.id}". Add it to design-system-baseline.json; do not delete rules to pass.`
            );
            continue;
        }

        const actual = current.counts[rule.id] ?? 0;

        if (actual > budget) {
            errors.push(
                `${rule.id}: ${actual} occurrences exceeds the budget of ${budget} (${rule.description})`
            );
        }
    }

    return errors;
}

/**
 * Rejects drift introduced by newly added lines, independent of the total.
 *
 * This is the half of the ratchet that works without paying down the backlog:
 * existing occurrences are tolerated, new ones are not.
 *
 * Net semantics matter here. A line rewritten to adopt a token often keeps some
 * unrelated utility that was already there — tokenising `bg-[#f0f0ef]` on a line
 * that also carries `text-neutral-900` removes one occurrence of drift and
 * re-adds another. Counting that as new drift would block exactly the cleanup the
 * guard exists to encourage, so removed lines are netted out per rule.
 *
 * @param {string[]} addedLines
 * @param {string[]} [removedLines]
 * @returns {string[]}
 */
export function evaluateAddedLines(addedLines, removedLines = []) {
    const errors = [];

    for (const rule of DRIFT_RULES) {
        const added = addedLines.reduce(
            (total, line) => total + (line.match(rule.pattern)?.length ?? 0),
            0
        );

        if (added === 0) {
            continue;
        }

        const removed = removedLines.reduce(
            (total, line) => total + (line.match(rule.pattern)?.length ?? 0),
            0
        );

        if (added <= removed) {
            continue;
        }

        const sample = addedLines.find((line) => rule.pattern.test(line))?.trim() ?? '';

        errors.push(
            `${rule.id}: ${added - removed} net new occurrence(s) in added lines (${rule.description})\n    ${sample}`
        );
    }

    return errors;
}

/**
 * Reads the added and removed lines of a diff.
 *
 * The pathspec is limited to the same extensions the count scan reads, and uses
 * Git's `:(glob)` magic so `**` matches zero or more directories — a plain
 * `apps/desktop/src/**\/*.vue` pathspec would silently skip files that sit
 * directly in `apps/desktop/src`, such as `App.vue`.
 *
 * @param {string} revisionRange
 * @param {boolean} staged Only inspect the staged diff.
 * @returns {{ added: string[], removed: string[] }}
 */
export function collectDiffLines(revisionRange, staged = false) {
    const args = staged
        ? ['diff', '--cached', '--unified=0']
        : ['diff', '--unified=0', revisionRange];

    const pathspecs = SCAN_EXTENSIONS.map(
        (extension) => `:(glob)apps/desktop/src/**/*${extension}`
    );
    const output = execFileSync('git', [...args, '--', ...pathspecs], {
        cwd: REPOSITORY_ROOT,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
    });

    const added = [];
    const removed = [];

    for (const line of output.split('\n')) {
        if (line.startsWith('+') && !line.startsWith('+++')) {
            added.push(line.slice(1));
        } else if (line.startsWith('-') && !line.startsWith('---')) {
            removed.push(line.slice(1));
        }
    }

    return { added, removed };
}

/**
 * @deprecated Use collectDiffLines, which also returns the removed lines the
 * net calculation needs.
 * @param {string} revisionRange
 * @param {boolean} staged
 * @returns {string[]}
 */
export function collectAddedLines(revisionRange, staged = false) {
    return collectDiffLines(revisionRange, staged).added;
}

function writeBaseline(current, revision) {
    const baseline = {
        $comment:
            'Design-system drift ratchet. Counts may only go DOWN. Lower a number in the same PR that removes the occurrences. Never raise one without an approved RFC.',
        measuredAt: revision,
        measuredOn: new Date().toISOString().slice(0, 10),
        budget: current.counts,
    };

    return baseline;
}

/**
 * Resolves the revision to diff against.
 *
 * Ordering matters and was learned the hard way. On a pull request CI checks out
 * a synthetic merge commit whose first parent is the base branch, and the
 * checkout is detached with no local branch refs, so `origin/main`, `main` and
 * even the base SHA that the workflow passes can all be unreachable. `HEAD^1`
 * is the one revision that is guaranteed to exist and to mean "the base", so it
 * comes first.
 *
 * `HEAD^2` is deliberately not used: it is the pull request's own head, which
 * would make the diff empty and silently disable the check.
 *
 * @returns {string[]} Candidate revisions, most reliable first.
 */
export function resolveBaseRevisions() {
    const candidates = ['HEAD^1'];

    const explicit = process.env.DESIGN_BUDGET_BASE_SHA?.trim();
    if (explicit) {
        candidates.push(explicit);
    }

    candidates.push('origin/main', 'main');

    return candidates;
}

function reportErrors(title, errors) {
    console.error(`\n${title}`);
    for (const error of errors) {
        console.error(`  - ${error}`);
    }
}

function main() {
    const argv = process.argv.slice(2);
    const staged = argv.includes('--changed');
    const wantsBaseline = argv.includes('--write-baseline');
    const current = collectDrift();

    if (wantsBaseline) {
        const revision = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
            cwd: REPOSITORY_ROOT,
            encoding: 'utf8',
        }).trim();
        const baseline = writeBaseline(current, revision);
        const relativeTarget = relative(REPOSITORY_ROOT, BASELINE_PATH);

        // JSON on stdout only, so `> design-system-baseline.json` stays valid.
        console.log(JSON.stringify(baseline, null, 4));
        console.error(
            `\nMeasured at ${revision}. Review the JSON above, then save it to ${relativeTarget} yourself.`
        );
        return;
    }

    const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
    const errors = [];

    const budgetErrors = evaluateBudget(current, baseline);
    errors.push(...budgetErrors);

    /*
     * Try each candidate revision until one is reachable. The last-resort
     * behaviour differs by environment: locally a missing base is a convenience
     * worth tolerating, but in CI silently skipping the added-line check would
     * let every new arbitrary value through while still printing "passed".
     */
    const candidates = staged ? [null] : resolveBaseRevisions();
    let diffLines = { added: [], removed: [] };
    let diffSource = null;

    for (const candidate of candidates) {
        try {
            diffLines = collectDiffLines(candidate, staged);
            diffSource = candidate;
            break;
        } catch (error) {
            if (candidate === candidates[candidates.length - 1]) {
                const label = staged ? 'the index' : String(candidate);
                const hint =
                    ' If every candidate is unreachable, the checkout is shallow: set fetch-depth: 0 on the job.';
                if (process.env.CI) {
                    errors.push(
                        `Could not read the diff against ${label}: ${error.message}. Refusing to skip the added-line check in CI.${hint}`
                    );
                } else {
                    console.warn(
                        `Could not read the diff against ${label}: ${error.message}. Only the totals were checked.${hint}`
                    );
                }
            }
        }
    }

    // Surfaced on failure so a reviewer knows which baseline the diff was taken
    // against; when the explicit base SHA is unreachable this may be a fallback.
    const diffLabel = staged ? 'the index' : (diffSource ?? 'an unresolved base');

    const addedLineErrors = evaluateAddedLines(diffLines.added, diffLines.removed);
    if (addedLineErrors.length > 0) {
        const exemption = process.env.DESIGN_DRIFT_EXEMPT?.trim();
        if (exemption) {
            console.warn(
                `\nDESIGN_DRIFT_EXEMPT is set, so new drift is reported but not blocking.\nReason: ${exemption}`
            );
            reportErrors('New drift introduced by added lines:', addedLineErrors);
        } else {
            errors.push(...addedLineErrors);
        }
    }

    if (errors.length > 0) {
        reportErrors(`Design-system drift check failed (diff against ${diffLabel}):`, errors);
        console.error(
            '\nUse an existing token or primitive. If a token is genuinely missing, add it to apps/desktop/src/styles/tokens/ in the same PR and lower the matching baseline entry.'
        );
        process.exit(1);
    }

    const summary = Object.entries(current.counts)
        .map(([id, count]) => `${id}=${count}/${baseline.budget[id]}`)
        .join(' ');
    console.log(`Design-system drift check passed (diff against ${diffLabel}). ${summary}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main();
}
