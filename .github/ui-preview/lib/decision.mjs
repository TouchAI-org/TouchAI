/**
 * Pure decision and path-classification logic for the UI preview workflow.
 *
 * The caller resolves the facts (who wrote the pull request, whether they have
 * write access, which labels are present) and this module decides whether the
 * preview should run, wait for a maintainer, be skipped, or stay silent. It also
 * classifies changed files so the workflow only builds for interface changes.
 */

export const FORCE_LABEL = 'ui-preview';
export const APPROVED_LABEL = 'status:ui-preview-approved';
export const SKIP_LABEL = 'status:ui-preview-skip';

export const COMMAND = '/ui-preview';

export const DECISION = {
    run: 'run',
    awaitingApproval: 'awaiting-approval',
    skipped: 'skipped',
    none: 'none',
};

const UI_PATH_PATTERNS = [
    /^apps\/desktop\/src\/views\//,
    /^apps\/desktop\/src\/components\//,
    /^apps\/desktop\/src\/styles\//,
    /^apps\/desktop\/src\/i18n\//,
    /^apps\/desktop\/src\/assets\//,
    /^apps\/desktop\/src\/router\//,
    /^apps\/desktop\/index\.html$/,
    /^apps\/desktop\/src-tauri\/src\/core\/window\//,
    /^apps\/desktop\/src-tauri\/tauri\.conf\.json$/,
    /^apps\/desktop\/src-tauri\/tauri\.(linux|windows|macos)\.conf\.json$/,
];

const EXCLUDED_PATTERNS = [
    /^\.github\//,
    /^docs\//,
    /^apps\/desktop\/tests\//,
    /^apps\/desktop\/e2e-tests\//,
    /^apps\/desktop\/src-tauri\/tests\//,
    /\.(test|spec)\.[cm]?[jt]sx?$/,
    /\.md$/,
];

const I18N_PATTERN = /^apps\/desktop\/src\/i18n\//;
const WINDOW_PATTERN = /^apps\/desktop\/src-tauri\/(src\/core\/window\/|tauri[^/]*\.conf\.json$)/;
const SETTINGS_PATTERN = /^apps\/desktop\/src\/views\/SettingsView\//;
const SEARCH_PATTERN = /^apps\/desktop\/src\/views\/SearchView\//;

export function normalizePath(filePath) {
    return String(filePath ?? '')
        .replace(/\\/g, '/')
        .replace(/^\.\//, '');
}

export function isUiPath(filePath) {
    const normalized = normalizePath(filePath);

    if (!normalized) {
        return false;
    }

    if (EXCLUDED_PATTERNS.some((pattern) => pattern.test(normalized))) {
        return false;
    }

    return UI_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * @param {Array<string | { filename?: string }>} files
 */
export function classifyFiles(files) {
    const names = (files ?? [])
        .map((file) => normalizePath(typeof file === 'string' ? file : file?.filename))
        .filter(Boolean);
    const ui = names.filter((name) => isUiPath(name));

    return {
        files: names,
        ui,
        hasUiChange: ui.length > 0,
        touchedI18n: ui.some((name) => I18N_PATTERN.test(name)),
        touchedWindow: ui.some((name) => WINDOW_PATTERN.test(name)),
        touchedSettings: ui.some((name) => SETTINGS_PATTERN.test(name)),
        touchedSearch: ui.some((name) => SEARCH_PATTERN.test(name)),
    };
}

/**
 * A command is the whole comment, or its first line, starting with `/ui-preview`
 * as a separate word. Quoted text and mid-sentence mentions do not count.
 */
export function isPreviewCommand(body) {
    const firstLine = String(body ?? '')
        .replace(/\r\n/g, '\n')
        .split('\n')
        .find((line) => line.trim().length > 0);

    if (!firstLine) {
        return false;
    }

    const trimmed = firstLine.trim();
    return trimmed === COMMAND || trimmed.startsWith(`${COMMAND} `);
}

/**
 * @param {object} input
 * @param {'pull_request_target' | 'issue_comment' | 'workflow_dispatch'} input.eventName
 * @param {string} [input.action]
 * @param {string} [input.actor]
 * @param {string} [input.labelName]
 * @param {string[]} [input.labels]
 * @param {boolean} [input.draft]
 * @param {boolean} [input.maintainer]
 * @param {boolean} [input.hasUiChange]
 * @param {boolean} [input.isPullRequestComment]
 * @param {string} [input.commentBody]
 * @param {boolean} [input.commentAuthorMaintainer]
 * @param {boolean} [input.labelActorMaintainer]
 * @param {boolean} [input.manualForce]
 * @returns {{ decision: string, reason: string, addApprovedLabel: boolean }}
 */
export function decide(input) {
    const labels = (input.labels ?? []).map((label) =>
        typeof label === 'string' ? label : label?.name
    );
    const eventName = input.eventName;
    const action = input.action ?? '';
    // A label is only an approval when the event that added it came from a
    // maintainer. Triage can apply labels, so the label alone is not proof.
    const trustedLabelActor = input.labelActorMaintainer !== false;
    const forced = labels.includes(FORCE_LABEL) && trustedLabelActor;
    const approved = labels.includes(APPROVED_LABEL) && trustedLabelActor;

    if (labels.includes(SKIP_LABEL)) {
        return {
            decision: DECISION.skipped,
            reason: `\`${SKIP_LABEL}\` is set`,
            addApprovedLabel: false,
        };
    }

    if (eventName === 'issue_comment') {
        if (!input.isPullRequestComment) {
            return {
                decision: DECISION.none,
                reason: 'not a pull request',
                addApprovedLabel: false,
            };
        }

        if (!isPreviewCommand(input.commentBody)) {
            return {
                decision: DECISION.none,
                reason: 'not a preview command',
                addApprovedLabel: false,
            };
        }

        if (!input.commentAuthorMaintainer) {
            return {
                decision: DECISION.none,
                reason: 'only a maintainer can request a preview',
                addApprovedLabel: false,
            };
        }

        return {
            decision: DECISION.run,
            reason: 'a maintainer requested a preview',
            addApprovedLabel: true,
        };
    }

    if (eventName === 'workflow_dispatch') {
        if (!input.hasUiChange && !input.manualForce) {
            return {
                decision: DECISION.none,
                reason: 'no UI file changed; dispatch with force to override',
                addApprovedLabel: false,
            };
        }

        return { decision: DECISION.run, reason: 'manual run', addApprovedLabel: false };
    }

    // The command path adds the approval label itself, so the resulting label
    // event would start a duplicate run. Later commits still see the label.
    if (
        (action === 'labeled' || action === 'unlabeled') &&
        input.labelName === APPROVED_LABEL &&
        String(input.actor ?? '').endsWith('[bot]')
    ) {
        return {
            decision: DECISION.none,
            reason: 'the approval label was written by the preview app itself',
            addApprovedLabel: false,
        };
    }

    if (!input.hasUiChange && !forced) {
        return { decision: DECISION.none, reason: 'no UI file changed', addApprovedLabel: false };
    }

    if (input.maintainer || approved || forced) {
        // A draft waits for ready_for_review unless a maintainer explicitly
        // approved or forced it. An outside contributor still gets the waiting
        // comment below, so they know how to request the preview.
        if (input.draft && action !== 'ready_for_review' && !forced && !approved) {
            return {
                decision: DECISION.none,
                reason: 'draft pull request; waits for ready_for_review',
                addApprovedLabel: false,
            };
        }

        const reason = input.maintainer
            ? 'maintainer pull request'
            : approved
              ? `\`${APPROVED_LABEL}\` is set`
              : `\`${FORCE_LABEL}\` is set`;
        return { decision: DECISION.run, reason, addApprovedLabel: false };
    }

    return {
        decision: DECISION.awaitingApproval,
        reason: 'waiting for a maintainer',
        addApprovedLabel: false,
    };
}
