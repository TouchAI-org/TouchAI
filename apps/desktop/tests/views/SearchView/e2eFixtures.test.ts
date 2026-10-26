import { describe, expect, it } from 'vitest';

import {
    copyE2eConversationFixture,
    describeE2eApprovalFixture,
    describeE2eConfirmFixture,
    E2E_VISUAL_FIXTURE_QUERY,
    type E2eApprovalFixture,
    type E2eConfirmFixture,
    getE2eQuickSearchFallbackResults,
} from '@/views/SearchView/utils/e2eFixtures';

/**
 * These fixtures feed the visual baselines, so the property that matters is determinism:
 * the same input must always produce the same rendered result, and no input from the
 * machine (the disk, a model, a locale) may leak in. The tests assert the observable
 * output of each helper rather than how it builds it.
 */

describe('user reviews a visual baseline of the search results', () => {
    it('user gets a fixed list only for the fixture query', () => {
        const results = getE2eQuickSearchFallbackResults(E2E_VISUAL_FIXTURE_QUERY);

        expect(results).toHaveLength(6);
        expect(results[0]).toMatchObject({ name: 'Design tokens', source: 'file' });
        // Every entry must be a file result, because the panel renders the file layout.
        expect(results.every((result) => result.source === 'file')).toBe(true);
    });

    it('user gets no fixture results for an ordinary search', () => {
        // An ordinary query must fall through to the real search path, otherwise the
        // baseline would stop proving anything about it.
        expect(getE2eQuickSearchFallbackResults('touchai')).toHaveLength(0);
        expect(getE2eQuickSearchFallbackResults('')).toHaveLength(0);
        expect(getE2eQuickSearchFallbackResults('touchai-visual')).toHaveLength(0);
    });

    it('user gets the fixture results regardless of how the query is typed', () => {
        // The bridge trims and lowercases so a spec cannot accidentally depend on the
        // exact casing it typed.
        expect(getE2eQuickSearchFallbackResults(`  ${E2E_VISUAL_FIXTURE_QUERY}  `)).toHaveLength(6);
        expect(
            getE2eQuickSearchFallbackResults(E2E_VISUAL_FIXTURE_QUERY.toUpperCase())
        ).toHaveLength(6);
    });
});

describe('user reviews a visual baseline of a conversation', () => {
    it('user sees the seeded transcript detached from the fixture object', () => {
        const fixture = [
            {
                id: 'm1',
                role: 'user',
                parts: [{ id: 'p1', type: 'text', content: 'Summarize the migration.' }],
            },
            {
                id: 'm2',
                role: 'assistant',
                parts: [{ id: 'p2', type: 'text', content: 'It replaced bespoke scanners.' }],
            },
        ];

        const copy = copyE2eConversationFixture(fixture);

        expect(copy).toHaveLength(2);
        expect(copy[1]?.parts[0]).toMatchObject({ content: 'It replaced bespoke scanners.' });

        // Mutating the fixture afterwards must not reach the panel. A shallow spread
        // alone would fail this, because the part objects would still be shared.
        const fixturePart = fixture[1]?.parts[0] as { content: string };
        fixturePart.content = 'mutated after seeding';

        expect(copy[1]?.parts[0]).toMatchObject({ content: 'It replaced bespoke scanners.' });
        expect(copy[1]?.parts[0]).not.toBe(fixturePart);
    });

    it('user sees an empty transcript when the fixture is empty', () => {
        expect(copyE2eConversationFixture([])).toEqual([]);
    });

    it('user keeps tool-call parts intact, since the panel renders them too', () => {
        // Parts are a union in the product; the clone must pass through whichever kind
        // it receives instead of assuming text.
        const fixture = [
            {
                id: 'm1',
                role: 'assistant',
                parts: [{ id: 'p1', type: 'tool_call', toolKind: 'bash', data: { command: 'ls' } }],
            },
        ];

        const copy = copyE2eConversationFixture(fixture);

        expect(copy[0]?.parts[0]).toMatchObject({ type: 'tool_call', toolKind: 'bash' });
    });
});

describe('user reviews a visual baseline of the ask-user panel', () => {
    it('user sees the confirm dialog with the text the fixture supplied', () => {
        const fixture: E2eConfirmFixture = {
            kind: 'confirm',
            title: 'Delete this session?',
            message: 'The conversation is removed from this device.',
            confirmText: 'Delete',
            cancelText: 'Cancel',
            type: 'danger',
        };

        expect(describeE2eConfirmFixture(fixture)).toEqual({
            title: 'Delete this session?',
            message: 'The conversation is removed from this device.',
            confirmText: 'Delete',
            cancelText: 'Cancel',
            type: 'danger',
        });
    });

    it('user sees the approval prompt with a stable call id', () => {
        const fixture: E2eApprovalFixture = {
            kind: 'approval',
            title: 'Run this command?',
            description: 'Lists the working directory.',
            command: 'ls -la',
            riskLabel: 'Low risk',
            reason: 'Read-only inspection.',
            commandLabel: 'Command',
            approveLabel: 'Run',
            rejectLabel: 'Cancel',
            enterHint: 'Enter to run',
            escHint: 'Esc to cancel',
        };

        const described = describeE2eApprovalFixture(fixture);

        expect(described).toMatchObject({
            title: 'Run this command?',
            command: 'ls -la',
            approveLabel: 'Run',
        });
        // A fixed call id is what keeps repeated captures identical: the panel keys its
        // dismissal state by it, so a random value would render differently each run.
        expect(described.callId).toBe('e2e-ask-user-fixture');
        expect(describeE2eApprovalFixture(fixture).callId).toBe(described.callId);
    });
});
