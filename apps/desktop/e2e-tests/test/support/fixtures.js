// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3.

/**
 * Deterministic inputs for the application visual baselines.
 *
 * A visual baseline cannot depend on a model, a network call, a stream timing, or the
 * contents of the machine's disk: the pixels would differ between two runs of the same
 * code, and a diff would stop meaning "this changed". Everything the specs need to pin
 * is here, on the test side, so none of it ships in the application bundle. The app only
 * offers the seam that accepts it.
 */

/**
 * The query the search-results baseline looks for.
 *
 * Real file search reads the disk: a contributor's machine returns thousands of matches
 * and a fresh CI runner returns none, so the screenshot would differ for reasons that
 * have nothing to do with the code under test. The bridge answers only for this query,
 * which appears in no real filename, so an ordinary search still exercises the real path
 * and simply finds nothing.
 */
export const SEARCH_FIXTURE_QUERY = 'touchai-visual-fixture';

/**
 * The rows the results panel renders for {@link SEARCH_FIXTURE_QUERY}.
 *
 * The paths are deliberately plausible rather than random: the panel renders shortened
 * paths and a source label, so the fixture has to look like what a user would see for the
 * baseline to be worth comparing against.
 */
export const SEARCH_FIXTURE_RESULTS = [
    { name: 'Design tokens', path: 'C:/TouchAI/src/styles/tokens', source: 'file' },
    { name: 'Design system guide', path: 'C:/TouchAI/docs/design-system.md', source: 'file' },
    { name: 'Settings window', path: 'C:/TouchAI/src/views/SettingsView.vue', source: 'file' },
    { name: 'Search window', path: 'C:/TouchAI/src/views/SearchView.vue', source: 'file' },
    { name: 'Visual baselines', path: 'C:/TouchAI/e2e-tests/__snapshots__', source: 'file' },
    { name: 'Lint rules', path: 'C:/TouchAI/eslint.config.js', source: 'file' },
];

/**
 * A pending tool approval, shaped exactly like `ToolApprovalDecisionRequest`.
 *
 * The panel renders every one of these strings, so they are written as real copy rather
 * than as placeholders: a baseline full of `lorem ipsum` would not show the overflow and
 * stacking problems this screen exists to catch.
 */
export const APPROVAL_REQUEST = {
    kind: 'approval',
    payload: {
        callId: 'e2e-ask-user-approval',
        title: 'Run a shell command',
        description: 'The agent wants to list the files in the current directory.',
        command: 'ls -la',
        riskLabel: 'Low risk',
        reason: 'Read-only command that only prints file names.',
        commandLabel: 'Command',
        approveLabel: 'Run',
        rejectLabel: 'Cancel',
        enterHint: 'Enter to run',
        escHint: 'Esc to cancel',
    },
};

/**
 * A confirmation prompt, shaped exactly like `AskUserConfirmOptions`.
 *
 * Kept next to the approval so a spec that wants the other branch of the panel does not
 * have to guess the shape.
 */
export const CONFIRM_REQUEST = {
    kind: 'confirm',
    options: {
        title: 'Delete this conversation?',
        message: 'The transcript will be removed from this device. This cannot be undone.',
        confirmText: 'Delete',
        cancelText: 'Keep',
        type: 'danger',
    },
};
