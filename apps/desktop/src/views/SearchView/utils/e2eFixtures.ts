// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3.

import type { QuickShortcutItem } from '@services/NativeService';

/**
 * Deterministic inputs for the E2E visual baselines.
 *
 * A visual baseline cannot depend on a model, a network call, a stream timing, or the
 * contents of the machine's disk. These helpers produce fixed values so a screenshot
 * shows the component's real rendering path driven by known data.
 */

/**
 * The query the E2E visual baseline searches for.
 *
 * Real file search depends on the machine: a contributor's disk returns thousands of
 * matches, a fresh CI runner returns none, and the pixels would differ for reasons that
 * have nothing to do with the code under test. The bridge answers only for a query that
 * appears in no real filename, so an ordinary search still exercises the real path.
 */
export const E2E_VISUAL_FIXTURE_QUERY = 'touchai-visual-fixture';

/** Fixed results for {@link E2E_VISUAL_FIXTURE_QUERY}, and nothing for any other query. */
export function getE2eQuickSearchFallbackResults(query: string): QuickShortcutItem[] {
    const normalizedQuery = query.trim().toLowerCase();
    if (normalizedQuery !== E2E_VISUAL_FIXTURE_QUERY) {
        return [];
    }

    return [
        { name: 'Design tokens', path: 'C:/TouchAI/src/styles/tokens', source: 'file' },
        {
            name: 'Design system guide',
            path: 'C:/TouchAI/docs/design-system.md',
            source: 'file',
        },
        {
            name: 'Settings window',
            path: 'C:/TouchAI/src/views/SettingsView.vue',
            source: 'file',
        },
        { name: 'Search window', path: 'C:/TouchAI/src/views/SearchView.vue', source: 'file' },
        {
            name: 'Visual baselines',
            path: 'C:/TouchAI/e2e-tests/__snapshots__',
            source: 'file',
        },
        { name: 'Lint rules', path: 'C:/TouchAI/eslint.config.js', source: 'file' },
    ];
}

/**
 * Minimal shape the bridge accepts for a conversation fixture.
 *
 * `parts` is deliberately loose: a transcript carries text, tool-call and other part
 * kinds, and the clone below must preserve whichever it receives rather than narrow it.
 */
export interface E2eConversationMessage {
    id: string;
    role: string;
    parts: ReadonlyArray<object>;
}

/**
 * Copies a transcript so the caller cannot mutate what the panel is showing.
 *
 * The messages are cloned rather than aliased: a spec that reuses its fixture object
 * after seeding would otherwise change the rendered conversation mid-capture. The clone
 * has to reach the payloads nested inside a part, not just the part objects, because a
 * part carries its own `data` and spreading the part would still share that. The
 * platform primitive does exactly this, and it accepts everything the bridge could have
 * serialised in the first place.
 */
export function copyE2eConversationFixture<T extends E2eConversationMessage>(
    messages: readonly T[]
): T[] {
    return structuredClone(messages) as T[];
}

/** A confirm dialog the bridge can enqueue without running a tool. */
export interface E2eConfirmFixture {
    kind: 'confirm';
    title: string;
    message: string;
    confirmText: string;
    cancelText: string;
    type?: 'info' | 'warning' | 'danger';
}

/** An approval prompt the bridge can enqueue without running a tool. */
export interface E2eApprovalFixture {
    kind: 'approval';
    title: string;
    description: string;
    command: string;
    riskLabel: string;
    reason: string;
    commandLabel: string;
    approveLabel: string;
    rejectLabel: string;
    enterHint: string;
    escHint: string;
}

export type E2eAskUserFixture = E2eConfirmFixture | E2eApprovalFixture;

/** The fields a confirm fixture contributes to the store. */
export function describeE2eConfirmFixture(fixture: E2eConfirmFixture) {
    return {
        title: fixture.title,
        message: fixture.message,
        confirmText: fixture.confirmText,
        cancelText: fixture.cancelText,
        type: fixture.type,
    };
}

/**
 * The fields an approval fixture contributes to the store.
 *
 * `callId` is fixed so a repeated capture cannot produce a different render: the panel
 * keys its dismissal state by it.
 */
export function describeE2eApprovalFixture(fixture: E2eApprovalFixture) {
    return {
        title: fixture.title,
        description: fixture.description,
        command: fixture.command,
        riskLabel: fixture.riskLabel,
        reason: fixture.reason,
        commandLabel: fixture.commandLabel,
        approveLabel: fixture.approveLabel,
        rejectLabel: fixture.rejectLabel,
        enterHint: fixture.enterHint,
        escHint: fixture.escHint,
        callId: 'e2e-ask-user-fixture',
    };
}
