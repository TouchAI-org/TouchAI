import { pathToFileURL } from 'node:url';

const REQUIRED_HEADERS = [
    '## Summary',
    '## Related issue or RFC',
    '## AI assistance disclosure',
    '## Testing evidence',
    '## Risk notes',
    '## Design system',
    '## Screenshots or recordings',
    '## Checklist',
];

const DESIGN_SYSTEM_HEADER = '## Design system';

/**
 * Files that make a pull request a design-system change.
 *
 * `.vue` is included because a view-layer change is where drift actually enters:
 * the audit found arbitrary values introduced by ordinary feature PRs, not by
 * changes to the token files.
 */
const DESIGN_SYSTEM_PATH_PATTERNS = [
    /^apps\/desktop\/src\/styles\//,
    /^apps\/desktop\/src\/components\/ui\//,
    /^apps\/desktop\/src\/components\/[^/]+\.vue$/,
    /^apps\/desktop\/src\/views\/.+\.vue$/,
    /^apps\/desktop\/eslint-suppressions\.json$/,
];

const NOT_APPLICABLE_PATTERN = /^n\/?a\.?$/i;

const ISSUE_REFERENCE_PATTERN =
    /(?:\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|related to)\s+#\d+\b|(?:^|\s)#\d+\b|TouchAI-org\/TouchAI#\d+\b|https:\/\/github\.com\/[^/\s]+\/[^/\s]+(?:\/(?:issues|pull|discussions)\/\d+)?\b)/im;
const RELEASE_PLEASE_HEAD_PREFIX = 'release-please--branches--';

function normalizeBody(body) {
    return body.replace(/\r\n/g, '\n');
}

function isReleasePleaseGeneratedBody(body) {
    const normalizedBody = normalizeBody(body).trim();

    return (
        normalizedBody.startsWith(':robot: I have created a release *beep* *boop*\n---') &&
        normalizedBody.includes(
            'This PR was generated with [Release Please](https://github.com/googleapis/release-please)'
        )
    );
}

function isReleasePleasePr(body, options) {
    return (
        options?.headRepoFullName &&
        options?.baseRepository &&
        options.headRepoFullName === options.baseRepository &&
        options?.headRef?.startsWith(RELEASE_PLEASE_HEAD_PREFIX) &&
        isReleasePleaseGeneratedBody(body)
    );
}

/**
 * Extracts the body of a markdown section.
 *
 * The header is matched at the start of a line, not anywhere in the text: a PR
 * description that mentions a section name in prose ("the template's
 * `## Design system` block") must not be mistaken for the section itself. That
 * mistake is easy to make and silently validates the wrong part of the body.
 */
export function extractMarkdownSection(body, header) {
    const normalizedBody = normalizeBody(body);
    const headerIndex = normalizedBody.search(
        new RegExp(`^${header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm')
    );
    if (headerIndex < 0) {
        return null;
    }

    const sectionStart = headerIndex + header.length;
    const remainder = normalizedBody.slice(sectionStart);
    const nextHeaderIndex = remainder.search(/\n## /);
    const section = nextHeaderIndex < 0 ? remainder : remainder.slice(0, nextHeaderIndex);

    return section.trim();
}

/**
 * Reports whether a pull request touches the design system.
 *
 * @param {string[]} changedFiles Repository-relative paths.
 * @returns {boolean}
 */
export function touchesDesignSystem(changedFiles) {
    return changedFiles.some((file) =>
        DESIGN_SYSTEM_PATH_PATTERNS.some((pattern) => pattern.test(file))
    );
}

/**
 * Requires a filled `## Design system` section whenever the diff touches UI files.
 *
 * A blanket `N/A` is rejected for UI changes because the section exists to force
 * the author to state which primitives they used and how many arbitrary values
 * they introduced. Leaving it empty is allowed for non-UI changes, and omitting
 * the changed-file list skips the UI-specific rules so local runs stay usable.
 *
 * @param {string} body
 * @param {string[]} changedFiles
 * @returns {string | null}
 */
/**
 * The template's own boilerplate, verbatim.
 *
 * The section ships pre-filled with an instruction and four prompts. Leaving them
 * all untouched looks like a filled section to a naive non-empty check, so each
 * line here counts as unanswered. The instruction line matters as much as the
 * prompts: without it, an author who submitted the section completely untouched
 * would pass, because the instruction is a non-empty line that matches no prompt.
 *
 * `tests/ci/pr-template-check.test.js` asserts this list stays in sync with the
 * template, so editing one without the other fails.
 */
const DESIGN_SYSTEM_TEMPLATE_BOILERPLATE = [
    'Fill this section when the diff touches `apps/desktop/src/components/ui/`, `apps/desktop/src/styles/`, `apps/desktop/src/components/*.vue`, or any `views/**/*.vue`. Write `N/A` otherwise.',
    '- Primitives used or extended (`components/ui/*`), or why none apply:',
    '- New arbitrary values introduced — count of `bg-[#…]`, `text-[Npx]`, `bg-white`: `0`',
    '- If a token is missing, which `@theme` entry should be added, and why not in this PR:',
    '- Visual change scope: `none` / `additive` / `breaking`. For `breaking`, list every affected call site:',
];

/** Exposed so the template-sync test can compare against the real file. */
export { DESIGN_SYSTEM_TEMPLATE_BOILERPLATE };

const VISUAL_CHANGE_SCOPE_PROMPT =
    '- Visual change scope: `none` / `additive` / `breaking`. For `breaking`, list every affected call site:';
const VISUAL_CHANGE_SCOPES = ['none', 'additive', 'breaking'];

/**
 * Literal patterns, one per scope word.
 *
 * `new RegExp(`\\b${scope}\\b`)` would be a non-literal regexp built from a
 * variable; the values are a fixed allowlist today, but the literal map makes
 * that obvious to a reader and to static analysis.
 */
const VISUAL_CHANGE_SCOPE_PATTERNS = {
    none: /\bnone\b/,
    additive: /\badditive\b/,
    breaking: /\bbreaking\b/,
};

/**
 * Reads the visual change scope and the text the author wrote after it.
 *
 * The scope is the one answer this section cannot skip: it is what tells a
 * reviewer whether to look at the rendered result at all, and it is the field the
 * visual baselines are interpreted against. Answering only "primitives used" is
 * not enough for a UI change, because the interesting question is whether the
 * pixels moved.
 *
 * Two things a naive match gets wrong, and this avoids:
 *   - The untouched template prompt lists all three scopes. Skipping only lines
 *     that are byte-identical to the prompt is not enough, because an author may
 *     leave several choices in place; the line is accepted only when exactly one
 *     scope word remains.
 *   - The `breaking` answer requires call sites, so the check must read what the
 *     author wrote after the prompt, not keywords anywhere in the section. The
 *     prompt itself contains the words "call site". A list may continue on the
 *     lines below the scope line, so those are part of the answer too.
 *
 * @param {string} section
 * @returns {{ scope: string, answer: string } | null}
 */
function readVisualChangeScope(section) {
    const lines = section
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    const scopeIndex = lines.findIndex(
        (line) => line !== VISUAL_CHANGE_SCOPE_PROMPT && /visual change scope/i.test(line)
    );

    if (scopeIndex < 0) {
        return null;
    }

    const scopeLine = lines[scopeIndex];
    const declared = scopeLine.toLowerCase();
    const matches = VISUAL_CHANGE_SCOPES.filter((scope) =>
        VISUAL_CHANGE_SCOPE_PATTERNS[scope].test(declared)
    );

    if (matches.length !== 1) {
        return null;
    }

    const scope = matches[0];
    const promptStart = scopeLine.indexOf('list every affected call site:');
    const sameLineAnswer =
        promptStart >= 0
            ? scopeLine.slice(promptStart + 'list every affected call site:'.length).trim()
            : scopeLine.slice(scopeLine.toLowerCase().indexOf(scope) + scope.length).trim();

    // Continuation lines (list items or wrapped text) belong to the same answer.
    // Stop at the next template prompt so an unrelated answer is never counted.
    const continuation = [];
    for (const line of lines.slice(scopeIndex + 1)) {
        if (line.startsWith('- ')) {
            break;
        }
        continuation.push(line);
    }

    return {
        scope,
        answer: [sameLineAnswer, ...continuation].filter(Boolean).join('\n').trim(),
    };
}

/**
 * Reports whether the author answered the design-system section.
 *
 * A line counts as unanswered while it still matches a template boilerplate line
 * verbatim — once the author appends an answer, or rewrites the line, it no
 * longer matches.
 *
 * Comparing whole lines rather than parsing after the colon avoids the trap that
 * the prompts themselves contain colons and backticks (`...: `0``), which makes
 * "text after the last colon" meaningless.
 *
 * Any single answered line is enough: this check exists to stop a blank template
 * being submitted, not to police completeness.
 *
 * @param {string} section
 * @returns {boolean}
 */
function isDesignSystemSectionAnswered(section) {
    const lines = section
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

    if (lines.length === 0) {
        return false;
    }

    const untouched = new Set(DESIGN_SYSTEM_TEMPLATE_BOILERPLATE.map((line) => line.trim()));
    const answered = lines.filter((line) => !untouched.has(line));

    return answered.length > 0;
}

export function validateDesignSystemSection(body, changedFiles) {
    const section = extractMarkdownSection(body, DESIGN_SYSTEM_HEADER);

    if (section === null) {
        return `Missing required PR template section: ${DESIGN_SYSTEM_HEADER}`;
    }

    if (!section) {
        return `"${DESIGN_SYSTEM_HEADER}" must not be empty. Write \`N/A\` for changes that do not touch the interface.`;
    }

    if (changedFiles.length === 0 || !touchesDesignSystem(changedFiles)) {
        return null;
    }

    if (NOT_APPLICABLE_PATTERN.test(section)) {
        return `"${DESIGN_SYSTEM_HEADER}" cannot be \`N/A\` because this pull request changes UI files. Name the primitives used and the number of arbitrary values introduced.`;
    }

    if (!isDesignSystemSectionAnswered(section)) {
        return `"${DESIGN_SYSTEM_HEADER}" still contains the template prompts. Replace them with real answers because this pull request changes UI files.`;
    }

    // The scope answers "how big", not "what". A section that only ticks the scope
    // leaves the questions that catch token drift unanswered. The scope words are
    // stripped before measuring the line, so a reworded sentence that mentions the
    // scope alongside real content still counts as an answer.
    const answeredLines = section
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !DESIGN_SYSTEM_TEMPLATE_BOILERPLATE.includes(line))
        .map((line) =>
            line
                .replace(/visual change scope/gi, '')
                .replace(/\bnone\b|\badditive\b|\bbreaking\b/gi, '')
                // Strip whitespace and punctuation only: the answer may be written
                // in Chinese, so letters must not be filtered by ASCII ranges.
                .replace(/[\s`'"(),.;:!?\-—–/\\]/g, '')
        )
        .filter((line) => line.length >= 3);

    if (answeredLines.length === 0) {
        return `"${DESIGN_SYSTEM_HEADER}" must answer the primitives or arbitrary-value prompt, not only the visual change scope, because this pull request changes UI files.`;
    }

    const scope = readVisualChangeScope(section);
    if (!scope) {
        return `"${DESIGN_SYSTEM_HEADER}" must declare exactly one visual change scope of \`none\`, \`additive\` or \`breaking\` because this pull request changes UI files.`;
    }

    if (scope.scope === 'breaking' && scope.answer.length < 3) {
        return `"${DESIGN_SYSTEM_HEADER}" declares a \`breaking\` visual change, so it must list the affected call sites after the prompt.`;
    }

    return null;
}

export function validatePrTemplateBody(body, options = {}) {
    const normalizedBody = normalizeBody(body);

    if (isReleasePleasePr(normalizedBody, options)) {
        return null;
    }

    for (const header of REQUIRED_HEADERS) {
        if (!normalizedBody.includes(header)) {
            return `Missing required PR template section: ${header}`;
        }
    }

    const relatedSection = extractMarkdownSection(normalizedBody, '## Related issue or RFC');
    if (relatedSection === null) {
        return 'Missing body for "## Related issue or RFC".';
    }

    if (!relatedSection) {
        return '"## Related issue or RFC" must not be empty.';
    }

    if (!ISSUE_REFERENCE_PATTERN.test(relatedSection)) {
        return '"## Related issue or RFC" must include an issue, RFC, or repository link.';
    }

    return validateDesignSystemSection(normalizedBody, options.changedFiles ?? []);
}

function parseChangedFiles(raw) {
    if (!raw) {
        return [];
    }

    return raw
        .split(',')
        .map((file) => file.trim())
        .filter(Boolean);
}

function main() {
    const body = process.env.PR_BODY ?? '';
    const error = validatePrTemplateBody(body, {
        headRef: process.env.PR_HEAD_REF ?? '',
        headRepoFullName: process.env.PR_HEAD_REPO_FULL_NAME ?? '',
        baseRepository: process.env.GITHUB_REPOSITORY ?? '',
        changedFiles: parseChangedFiles(process.env.PR_FILES),
    });

    if (error) {
        console.error(error);
        process.exit(1);
    }

    console.log('PR template structure and linkage checks passed.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main();
}
