import { describe, expect, it } from 'vitest';

import { classifyFiles, isUiPath } from '../lib/decision.mjs';

describe('user changes a desktop surface', () => {
    it('user gets a preview when a settings view changes', () => {
        expect(isUiPath('apps/desktop/src/views/SettingsView/components/General/index.vue')).toBe(
            true
        );
    });

    it('user gets a preview when a shared component changes', () => {
        expect(isUiPath('apps/desktop/src/components/TitleBar.vue')).toBe(true);
    });

    it('user gets a preview when a locale message changes', () => {
        expect(isUiPath('apps/desktop/src/i18n/messages.ts')).toBe(true);
    });

    it('user gets a preview when the window shell changes', () => {
        expect(isUiPath('apps/desktop/src-tauri/src/core/window/search/mod.rs')).toBe(true);
    });

    it('user gets a preview when the Tauri window config changes', () => {
        expect(isUiPath('apps/desktop/src-tauri/tauri.linux.conf.json')).toBe(true);
    });

    it('user gets a preview when a stylesheet changes', () => {
        expect(isUiPath('apps/desktop/src/styles/tailwind.css')).toBe(true);
    });
});

describe('user changes something that cannot alter the rendered interface', () => {
    it('user gets no preview for a unit test next to a view', () => {
        expect(isUiPath('apps/desktop/src/views/SettingsView/index.test.ts')).toBe(false);
    });

    it('user gets no preview for the desktop E2E suite', () => {
        expect(isUiPath('apps/desktop/e2e-tests/test/specs/settings-smoke.e2e.js')).toBe(false);
    });

    it('user gets no preview for documentation', () => {
        expect(isUiPath('docs/agents/delivery.md')).toBe(false);
    });

    it('user gets no preview for the official site', () => {
        expect(isUiPath('apps/site/src/pages/index.astro')).toBe(false);
    });

    it('user gets no preview for a store module', () => {
        expect(isUiPath('apps/desktop/src/stores/setting/index.ts')).toBe(false);
    });

    it('user gets no preview for workflow automation', () => {
        expect(isUiPath('.github/workflows/ui-preview.yml')).toBe(false);
    });
});

describe('user opens a pull request that mixes files', () => {
    it('user gets one preview when at least one file is a UI file', () => {
        const result = classifyFiles([
            'docs/agents/delivery.md',
            'apps/desktop/src/views/SearchView/index.vue',
        ]);

        expect(result.hasUiChange).toBe(true);
        expect(result.ui).toEqual(['apps/desktop/src/views/SearchView/index.vue']);
    });

    it('user sees the touched surfaces classified for the planner', () => {
        const result = classifyFiles([
            'apps/desktop/src/views/SettingsView/index.vue',
            'apps/desktop/src/i18n/messages.ts',
            'apps/desktop/src-tauri/tauri.conf.json',
        ]);

        expect(result.touchedSettings).toBe(true);
        expect(result.touchedI18n).toBe(true);
        expect(result.touchedWindow).toBe(true);
        expect(result.touchedSearch).toBe(false);
    });

    it('user gets no preview when every changed file is excluded', () => {
        const result = classifyFiles(['README.md', 'apps/desktop/tests/setup/vitest.ts']);

        expect(result.hasUiChange).toBe(false);
    });
});
