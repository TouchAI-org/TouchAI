// Copyright (c) 2026. 千诚. Licensed under GPL v3

/**
 * Patch coverage: the share of the lines this change touched that the suite exercises.
 *
 * The global floor in `vitest.config.ts` stops the whole repository from slipping, but it
 * cannot see a PR that adds 400 uncovered lines while covering 400 old ones. This check
 * looks only at the lines the change itself added or changed, so new code has to arrive
 * with tests for its own behaviour.
 *
 * Lines are counted from the diff (`--unified=0`) against the base commit, then looked up
 * in the v8 coverage report. A file the report does not mention at all counts as fully
 * uncovered, because nothing loaded it.
 */

/** Lines of a file that the change added, keyed by repo-relative path. */
export function parseChangedLines(diffText) {
    const changed = new Map();
    let currentPath = null;
    let nextLine = null;

    for (const rawLine of diffText.split('\n')) {
        const line = rawLine.replace(/\r$/, '');

        if (line.startsWith('+++ ')) {
            const target = line.slice(4).trim();
            currentPath = target === '/dev/null' ? null : target.replace(/^b\//, '');
            continue;
        }

        if (line.startsWith('@@')) {
            // @@ -a,b +c,d @@ — the new file's hunk starts at line c.
            const match = /\+(\d+)(?:,(\d+))?/.exec(line);
            nextLine = match ? Number(match[1]) : null;
            continue;
        }

        if (currentPath === null || nextLine === null) {
            continue;
        }

        if (line.startsWith('+')) {
            const lines = changed.get(currentPath) ?? new Set();
            lines.add(nextLine);
            changed.set(currentPath, lines);
            nextLine += 1;
        } else if (!line.startsWith('-')) {
            // A context line advances the new file's line counter.
            nextLine += 1;
        }
    }

    return changed;
}

/**
 * Coverage of one file's changed lines.
 *
 * `statementMap`/`s` and `branchMap`/`b` are v8's shape: every statement and branch knows
 * the line it starts on, and how many times it ran.
 */
function measureFile(fileCoverage, lines) {
    let total = 0;
    let covered = 0;

    for (const line of lines) {
        let hits = 0;

        for (const [id, count] of Object.entries(fileCoverage.s ?? {})) {
            const start = fileCoverage.statementMap?.[id]?.start?.line;
            if (start === line && count > 0) {
                hits += 1;
            }
        }

        for (const [id, counts] of Object.entries(fileCoverage.b ?? {})) {
            const start = fileCoverage.branchMap?.[id]?.line;
            if (start === line && counts.some((count) => count > 0)) {
                hits += 1;
            }
        }

        // A changed line with no statement or branch is a blank line, a comment, or a
        // closing brace: nothing to cover, so it is not counted either way.
        if (hits > 0 || hasStatementOn(fileCoverage, line)) {
            total += 1;
            if (hits > 0) {
                covered += 1;
            }
        }
    }

    return { total, covered };
}

function hasStatementOn(fileCoverage, line) {
    return Object.keys(fileCoverage.s ?? {}).some(
        (id) => fileCoverage.statementMap?.[id]?.start?.line === line
    );
}

/**
 * Patch coverage over the whole diff.
 *
 * @param {Map<string, Set<number>>} changedLines from `parseChangedLines`
 * @param {Record<string, object>} coverageReport v8 `coverage-final.json`, keyed by absolute path
 * @param {{ repoRoot?: string, ignore?: (path: string) => boolean }} options
 */
export function measurePatchCoverage(changedLines, coverageReport, options = {}) {
    const { repoRoot = '', ignore = () => false } = options;
    const normalise = (path) => path.replace(/\\/g, '/');

    // The report keys are absolute paths; the diff keys are repo-relative. Index the report by
    // its repo-relative suffix so the two can be matched regardless of where the checkout lives.
    // With `root: '.'` the keys are already relative, so no prefix is stripped.
    const trimmedRoot = normalise(repoRoot).replace(/^\.\//, '').replace(/^\.$/, '').replace(/\/$/, '');
    const prefix = trimmedRoot ? `/${trimmedRoot}/` : null;
    const byRelativePath = new Map();
    const normalisedEntries = [];
    for (const [absolute, fileCoverage] of Object.entries(coverageReport)) {
        const normalisedAbsolute = normalise(absolute);
        const index = prefix ? normalisedAbsolute.lastIndexOf(prefix) : -1;
        const relative =
            index >= 0 ? normalisedAbsolute.slice(index + prefix.length) : normalisedAbsolute;
        byRelativePath.set(relative, fileCoverage);
        normalisedEntries.push([normalisedAbsolute, fileCoverage]);
    }

    /**
     * Finds a changed file's entry in the report.
     *
     * `repoRoot` alone cannot bridge the two shapes. The diff keys are repository-relative
     * (`apps/desktop/src/x.ts`) while the report keys are absolute, so the only prefix that
     * strips exactly is the absolute checkout path — which differs per machine and per
     * runner. Passing anything else (`apps/desktop`, or `.`) leaves the two sides keyed
     * differently, every lookup misses, and every changed line is counted as uncovered.
     *
     * Matching the absolute key's tail removes that dependency on the caller: a key ending
     * in `/<changed path>` is the same file whatever directory the checkout sits in.
     */
    const findCoverage = (path) => {
        const relative = normalise(path);
        const indexed = byRelativePath.get(relative);

        if (indexed) {
            return indexed;
        }

        const suffix = `/${relative}`;

        for (const [absolute, fileCoverage] of normalisedEntries) {
            if (absolute.endsWith(suffix)) {
                return fileCoverage;
            }
        }

        return undefined;
    };

    let total = 0;
    let covered = 0;
    const files = [];

    for (const [path, lines] of changedLines) {
        if (ignore(path)) {
            continue;
        }

        const fileCoverage = findCoverage(path);
        // A changed source file that never appears in the report was never loaded by a test.
        const measured = fileCoverage
            ? measureFile(fileCoverage, lines)
            : { total: lines.size, covered: 0 };

        if (measured.total === 0) {
            continue;
        }

        total += measured.total;
        covered += measured.covered;
        files.push({
            path,
            total: measured.total,
            covered: measured.covered,
            percent: (measured.covered / measured.total) * 100,
        });
    }

    files.sort((left, right) => left.percent - right.percent || left.path.localeCompare(right.path));

    return {
        total,
        covered,
        percent: total === 0 ? 100 : (covered / total) * 100,
        files,
    };
}

/** Failures for a patch that is below the floor, or empty when it passes. */
export function checkPatchCoverage(result, floor) {
    if (typeof floor !== 'number' || Number.isNaN(floor)) {
        throw new Error('Patch coverage floor is missing a numeric value.');
    }

    if (result.total === 0) {
        return [];
    }

    if (result.percent + 1e-9 < floor) {
        const worst = result.files
            .filter((file) => file.percent < floor)
            .slice(0, 5)
            .map((file) => `${file.path} ${file.percent.toFixed(1)}%`)
            .join(', ');
        return [
            `patch coverage: ${result.percent.toFixed(2)}% of the changed lines is covered, ` +
                `below the floor of ${floor}% (${result.covered}/${result.total})` +
                (worst ? `; worst files: ${worst}` : ''),
        ];
    }

    return [];
}

/** Markdown for the CI step summary. */
export function formatPatchCoverage(result, floor) {
    const rows = result.files.map(
        (file) => `| ${file.path} | ${file.covered}/${file.total} | ${file.percent.toFixed(1)}% |`
    );

    return [
        '### Patch coverage',
        '',
        `${result.covered}/${result.total} changed lines covered (${result.percent.toFixed(2)}%), ` +
            `floor ${floor}%.`,
        '',
        '| File | Lines | Covered |',
        '| --- | ---: | ---: |',
        ...rows,
        '',
    ].join('\n');
}
