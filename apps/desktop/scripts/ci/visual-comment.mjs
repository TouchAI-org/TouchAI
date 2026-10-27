/**
 * Upserts the one pull-request comment that holds both visual layers.
 *
 * Two layers, two workflows, one comment: the comment is found by its marker rather
 * than by author or position, and only the calling layer's block is rewritten, so the
 * component and app workflows can finish in either order and still leave exactly one
 * report. Appending a new comment on every push would bury the conversation, and a
 * stale report is worse than none: it would describe a run that no longer exists.
 *
 * Because the two workflows are independent, every write is a read-modify-write over
 * state the other one also writes. The merge function keeps the other layer's block, but
 * it can only do that for the body it was given; if the other layer landed in between,
 * the merge is computed from a body that is already stale and the write reverts it. So
 * each write is read back and the layers are compared, and a lost layer is retried.
 *
 * The REST API is called directly with `fetch`. This is two requests and a merge, so a
 * step in `actions/github-script` would buy nothing and would make the script impossible
 * to run by hand against a pull request.
 *
 * Usage:
 *   node scripts/ci/visual-comment.mjs --layer components [--section <path>]
 *
 * Env: GH_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, LAYER, SECTION_PATH, STATUS_LINE.
 * The flags win over the environment, which is how the workflow passes them.
 */

import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { COMMENT_MARKER, layersIn, lostLayers, mergeSection } from './visual-comment-merge.mjs';

const { values } = parseArgs({
    options: {
        layer: { type: 'string' },
        section: { type: 'string' },
    },
});

const token = process.env.GH_TOKEN ?? '';
const repository = process.env.GITHUB_REPOSITORY ?? '';
const prNumber = process.env.PR_NUMBER ?? '';
const layer = values.layer ?? process.env.LAYER ?? '';
const sectionPath = values.section ?? process.env.SECTION_PATH ?? '';
const statusLine = (process.env.STATUS_LINE ?? '').trim();

/**
 * Not being able to post is not a failed comparison. A fork pull request, a repository
 * without the App, or a run that produced no section all land here, and none of them is
 * a reason to turn a green visual job red.
 */
const skip = (reason) => {
    console.log(`Not posting the visual report: ${reason}`);
    process.exit(0);
};

if (!token) {
    skip('GH_TOKEN is not set');
}

if (!repository) {
    skip('GITHUB_REPOSITORY is not set');
}

if (!prNumber) {
    skip('PR_NUMBER is not set, so there is no pull request to comment on');
}

if (!layer) {
    // A missing layer would write a block nothing can ever find again.
    console.error('--layer or LAYER is required');
    process.exit(1);
}

let section = '';

if (sectionPath) {
    if (!existsSync(sectionPath)) {
        skip(`${sectionPath} does not exist`);
    }

    section = readFileSync(sectionPath, 'utf8');
}

// The status line is what the approval workflow contributes: the comparison sections
// describe pixels, and this describes what was done to the baselines.
const content = [statusLine, section.trim()].filter(Boolean).join('\n\n');

if (!content) {
    skip('there is no section and no status line to post');
}

const request = async (url, init = {}) => {
    const response = await fetch(url, {
        ...init,
        headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'User-Agent': 'touchai-visual-tests',
            'X-GitHub-Api-Version': '2022-11-28',
        },
    });

    const text = await response.text();

    if (!response.ok) {
        // A failed PATCH leaves the reviewer with the previous run's report, so it is
        // reported rather than swallowed.
        throw new Error(
            `${init.method ?? 'GET'} ${url} failed with ${response.status}: ${text.slice(0, 300)}`
        );
    }

    return text ? JSON.parse(text) : null;
};

const apiUrl = (suffix) => `https://api.github.com/repos/${repository}${suffix}`;

/**
 * Finds the report comment by its marker.
 *
 * The list endpoint is paginated, and a busy pull request can hold more than one page of
 * comments, so the walk stops at the first page that is not full rather than assuming
 * the comment is among the newest hundred.
 */
const findComment = async () => {
    for (let page = 1; ; page += 1) {
        const comments =
            (await request(apiUrl(`/issues/${prNumber}/comments?per_page=100&page=${page}`))) ?? [];
        const existing = comments.find((comment) => (comment.body ?? '').includes(COMMENT_MARKER));

        if (existing) {
            return existing;
        }

        if (comments.length < 100) {
            return null;
        }
    }
};

/**
 * How many read-merge-write cycles to attempt before giving up.
 *
 * Two workflows write this comment and they are not serialised against each other, so
 * each write is a read-modify-write over shared state. A collision needs the other layer
 * to land inside this run's few-hundred-millisecond window, which is rare and does not
 * repeat, so three attempts is generous; the alternative, serialising the two test jobs,
 * would make the Windows suite wait for the container suite for no reason.
 */
const WRITE_ATTEMPTS = 3;

const main = async () => {
    for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt += 1) {
        const existing = await findComment();
        const before = layersIn(existing?.body ?? '');
        const body = mergeSection(existing?.body ?? '', layer, content);

        if (existing) {
            await request(apiUrl(`/issues/comments/${existing.id}`), {
                method: 'PATCH',
                body: JSON.stringify({ body }),
            });
        } else {
            await request(apiUrl(`/issues/${prNumber}/comments`), {
                method: 'POST',
                body: JSON.stringify({ body }),
            });
        }

        // Read back rather than trusting the write. A layer that vanished here was
        // overwritten by the other workflow, and the reviewer would otherwise be shown a
        // report missing half its evidence with no indication that anything went wrong.
        const written = await findComment();
        const lost = lostLayers(before, layersIn(written?.body ?? ''), layer);

        if (lost.length === 0) {
            console.log(`Posted the ${layer} section as comment ${written?.id ?? '(new)'}.`);
            return;
        }

        console.warn(
            `The write dropped ${lost.join(', ')} from the report comment; retrying (${attempt}/${WRITE_ATTEMPTS}).`
        );
    }

    throw new Error(
        `Could not write the ${layer} section without losing another layer after ${WRITE_ATTEMPTS} attempts. The report comment is now missing part of its evidence; re-run the failed visual job.`
    );
};

try {
    await main();
} catch (error) {
    console.error(String(error?.message ?? error));
    process.exit(1);
}
