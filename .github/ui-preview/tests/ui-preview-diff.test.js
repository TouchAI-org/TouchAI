import { describe, expect, it } from 'vitest';

import { MAX_FILE_CHARS, selectUiDiff, splitDiff } from '../lib/model.mjs';

const diff = [
    'diff --git a/apps/desktop/src/views/SettingsView/index.vue b/apps/desktop/src/views/SettingsView/index.vue',
    'index 1111111..2222222 100644',
    '--- a/apps/desktop/src/views/SettingsView/index.vue',
    '+++ b/apps/desktop/src/views/SettingsView/index.vue',
    '@@ -1,3 +1,4 @@',
    ' <template>',
    '+  <div data-testid="settings-new-section">New</div>',
    ' </template>',
    'diff --git a/docs/agents/delivery.md b/docs/agents/delivery.md',
    'index 3333333..4444444 100644',
    '--- a/docs/agents/delivery.md',
    '+++ b/docs/agents/delivery.md',
    '@@ -1,2 +1,3 @@',
    ' # UI Preview',
    '+More words.',
    'diff --git a/apps/desktop/tests/ci/ui-preview-comment.test.js b/apps/desktop/tests/ci/ui-preview-comment.test.js',
    'index 5555555..6666666 100644',
    '--- a/apps/desktop/tests/ci/ui-preview-comment.test.js',
    '+++ b/apps/desktop/tests/ci/ui-preview-comment.test.js',
    '@@ -1,2 +1,3 @@',
    ' import x from "y";',
    '+expect(true).toBe(true);',
    '',
].join('\n');

describe('user reads a pull request diff', () => {
    it('user gets one entry per changed file', () => {
        expect(splitDiff(diff).map((file) => file.path)).toEqual([
            'apps/desktop/src/views/SettingsView/index.vue',
            'docs/agents/delivery.md',
            'apps/desktop/tests/ci/ui-preview-comment.test.js',
        ]);
    });

    it('user gets only the interface files, each with its own header', () => {
        const selected = selectUiDiff(diff);

        expect(selected.files).toEqual(['apps/desktop/src/views/SettingsView/index.vue']);
        expect(selected.dropped).toEqual([
            'docs/agents/delivery.md',
            'apps/desktop/tests/ci/ui-preview-comment.test.js',
        ]);
        expect(selected.text).toContain(
            'diff --git a/apps/desktop/src/views/SettingsView/index.vue'
        );
        expect(selected.text).toContain('settings-new-section');
        expect(selected.text).not.toContain('More words.');
        expect(selected.text).not.toContain('expect(true)');
    });

    it('user still sees the interface file when a huge non-interface file comes first', () => {
        const noisy = [
            'diff --git a/apps/desktop/src/services/AgentService/big.ts b/apps/desktop/src/services/AgentService/big.ts',
            'index 1111111..2222222 100644',
            '--- a/apps/desktop/src/services/AgentService/big.ts',
            '+++ b/apps/desktop/src/services/AgentService/big.ts',
            '@@ -1,1 +1,1 @@',
            `+${'x'.repeat(60000)}`,
            ...diff.split('\n'),
        ].join('\n');
        const selected = selectUiDiff(noisy);

        expect(selected.files).toEqual(['apps/desktop/src/views/SettingsView/index.vue']);
        expect(selected.text).toContain('settings-new-section');
    });

    it('user sees a cut marker when one interface file is longer than its share', () => {
        const long = [
            'diff --git a/apps/desktop/src/views/SettingsView/index.vue b/apps/desktop/src/views/SettingsView/index.vue',
            'index 1111111..2222222 100644',
            '--- a/apps/desktop/src/views/SettingsView/index.vue',
            '+++ b/apps/desktop/src/views/SettingsView/index.vue',
            '@@ -1,1 +1,1 @@',
            `+${'y'.repeat(MAX_FILE_CHARS + 2000)}`,
            '',
        ].join('\n');
        const selected = selectUiDiff(long);

        expect(selected.truncated).toBe(true);
        expect(selected.text).toContain('(cut,');
        expect(selected.text.length).toBeLessThan(long.length);
    });
});
