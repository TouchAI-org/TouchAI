import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
    DESIGN_SYSTEM_TEMPLATE_BOILERPLATE,
    touchesDesignSystem,
    validateDesignSystemSection,
    validatePrTemplateBody,
} from '../../scripts/ci/pr-template-check.js';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDirectory, '../../../..');

const releasePleaseBody = [
    ':robot: I have created a release *beep* *boop*',
    '---',
    '',
    '',
    '## [1.1.2](https://github.com/TouchAI-org/TouchAI/compare/v1.1.1...v1.1.2) (2026-06-09)',
    '',
    '',
    '### Bug Fixes',
    '',
    '* **agent-service:** preserve request errors during auth cleanup ([#448](https://github.com/TouchAI-org/TouchAI/issues/448)) ([ee1f698](https://github.com/TouchAI-org/TouchAI/commit/ee1f698ff76fbc7bd09104439087b5fc114d032f))',
    '',
    '---',
    'This PR was generated with [Release Please](https://github.com/googleapis/release-please). See [documentation](https://github.com/googleapis/release-please#release-please).',
].join('\n');

function buildBody(overrides = {}) {
    const sections = {
        '## Summary': 'Adds the thing.',
        '## Related issue or RFC': 'Closes #592',
        '## AI assistance disclosure': 'No AI assistance.',
        '## Testing evidence': 'pnpm test',
        '## Risk notes': 'Low.',
        '## Design system': 'N/A',
        '## Screenshots or recordings': 'N/A',
        '## Checklist': '- [x] Tests pass',
        ...overrides,
    };

    return Object.entries(sections)
        .filter(([, value]) => value !== null)
        .map(([header, value]) => `${header}\n\n${value}`)
        .join('\n\n');
}

describe('validatePrTemplateBody', () => {
    it('allows Release Please generated release PR bodies on the release branch', () => {
        expect(
            validatePrTemplateBody(releasePleaseBody, {
                headRef: 'release-please--branches--main--components--TouchAI',
                headRepoFullName: 'TouchAI-org/TouchAI',
                baseRepository: 'TouchAI-org/TouchAI',
            })
        ).toBeNull();
    });

    it('does not allow arbitrary branches to bypass the PR template with release text', () => {
        expect(
            validatePrTemplateBody(releasePleaseBody, {
                headRef: 'feature/release-text',
            })
        ).toBe('Missing required PR template section: ## Summary');
    });

    it('does not allow fork branches to spoof Release Please PRs', () => {
        expect(
            validatePrTemplateBody(releasePleaseBody, {
                headRef: 'release-please--branches--main--components--TouchAI',
                headRepoFullName: 'attacker/TouchAI',
                baseRepository: 'TouchAI-org/TouchAI',
            })
        ).toBe('Missing required PR template section: ## Summary');
    });

    it('continues to require related issue linkage for regular PR templates', () => {
        const body = buildBody({ '## Related issue or RFC': 'N/A' });

        expect(validatePrTemplateBody(body, { headRef: 'feature/regular-pr' })).toBe(
            '"## Related issue or RFC" must include an issue, RFC, or repository link.'
        );
    });

    it('accepts a regular PR that fills the design system section', () => {
        const body = buildBody({
            '## Design system': [
                '- Primitives used: `button`',
                '- New arbitrary values: `0`',
                '- Missing token: none',
                '- Visual change scope: `none`',
            ].join('\n'),
        });

        expect(
            validatePrTemplateBody(body, {
                headRef: 'feature/regular-pr',
                changedFiles: ['apps/desktop/src/views/SearchView/index.vue'],
            })
        ).toBeNull();
    });
});

describe('touchesDesignSystem', () => {
    it('detects token and primitive changes', () => {
        expect(touchesDesignSystem(['apps/desktop/src/styles/tailwind.css'])).toBe(true);
        expect(touchesDesignSystem(['apps/desktop/src/components/ui/button/Button.vue'])).toBe(
            true
        );
        expect(touchesDesignSystem(['design-system-baseline.json'])).toBe(true);
    });

    it('detects view-layer changes, where drift actually enters', () => {
        expect(touchesDesignSystem(['apps/desktop/src/views/SettingsView/index.vue'])).toBe(true);
        expect(touchesDesignSystem(['apps/desktop/src/components/SettingsRow.vue'])).toBe(true);
    });

    it('ignores non-UI changes', () => {
        expect(touchesDesignSystem(['apps/desktop/src-tauri/src/main.rs'])).toBe(false);
        expect(touchesDesignSystem(['docs/agents/architecture.md'])).toBe(false);
        expect(touchesDesignSystem(['apps/desktop/src/services/ai/index.ts'])).toBe(false);
    });
});

describe('validateDesignSystemSection', () => {
    const uiFiles = ['apps/desktop/src/views/SearchView/index.vue'];

    it('rejects a UI pull request that marks the section N/A', () => {
        const body = buildBody({ '## Design system': 'N/A' });

        expect(validateDesignSystemSection(body, uiFiles)).toBe(
            '"## Design system" cannot be `N/A` because this pull request changes UI files. Name the primitives used and the number of arbitrary values introduced.'
        );
    });

    it('rejects a UI pull request that leaves the section empty', () => {
        const body = buildBody({ '## Design system': '' });

        expect(validateDesignSystemSection(body, uiFiles)).toBe(
            '"## Design system" must not be empty. Write `N/A` for changes that do not touch the interface.'
        );
    });

    it('rejects a UI pull request that submitted the untouched template prompts', () => {
        // This is the failure mode a non-empty check misses: the section looks
        // filled because the template ships with prompts.
        const body = buildBody({
            '## Design system': [
                '- Primitives used or extended (`components/ui/*`), or why none apply:',
                '- New arbitrary values introduced — count of `bg-[#…]`, `text-[Npx]`, `bg-white`: `0`',
                '- If a token is missing, which `@theme` entry should be added, and why not in this PR:',
                '- Visual change scope: `none` / `additive` / `breaking`. For `breaking`, list every affected call site:',
            ].join('\n'),
        });

        expect(validateDesignSystemSection(body, uiFiles)).toBe(
            '"## Design system" still contains the template prompts. Replace them with real answers because this pull request changes UI files.'
        );
    });

    it('accepts a UI pull request that answered even one prompt', () => {
        const body = buildBody({
            '## Design system': [
                '- Primitives used or extended (`components/ui/*`), or why none apply: `button`',
                '- New arbitrary values introduced — count of `bg-[#…]`, `text-[Npx]`, `bg-white`: `0`',
            ].join('\n'),
        });

        expect(validateDesignSystemSection(body, uiFiles)).toBeNull();
    });

    it('accepts reworded answers instead of the template prompts', () => {
        const body = buildBody({
            '## Design system':
                'Reused the existing Button and Badge variants; no new tokens needed.',
        });

        expect(validateDesignSystemSection(body, uiFiles)).toBeNull();
    });

    it('accepts N/A when no UI file changed', () => {
        const body = buildBody({ '## Design system': 'N/A' });

        expect(validateDesignSystemSection(body, ['docs/agents/architecture.md'])).toBeNull();
    });

    it('skips UI-specific rules when the changed-file list is unavailable', () => {
        const body = buildBody({ '## Design system': 'N/A' });

        expect(validateDesignSystemSection(body, [])).toBeNull();
    });

    it('reports a missing section', () => {
        const body = buildBody({ '## Design system': null });

        expect(validateDesignSystemSection(body, uiFiles)).toBe(
            'Missing required PR template section: ## Design system'
        );
    });
});

describe('PR template check workflow', () => {
    it('passes the pull request head ref to the validator', async () => {
        const workflow = await readFile(
            resolve(repositoryRoot, '.github/workflows/pr-template-check.yml'),
            'utf8'
        );

        expect(workflow).toContain('PR_HEAD_REF: ${{ github.event.pull_request.head.ref }}');
        expect(workflow).toContain(
            'PR_HEAD_REPO_FULL_NAME: ${{ github.event.pull_request.head.repo.full_name }}'
        );
    });
});

describe('template sync', () => {
    /*
     * The validator decides "answered" by comparing whole lines against a list of
     * boilerplate. If the template gains a line the list does not know about, that
     * line counts as an answer and a completely untouched section passes. These
     * tests fail in that case, so the two cannot drift apart.
     */
    it('lists exactly the lines the template ships under the design system section', async () => {
        const template = await readFile(
            resolve(repositoryRoot, '.github/pull_request_template.md'),
            'utf8'
        );

        const headerIndex = template.indexOf('## Design system');
        expect(headerIndex, 'template has no ## Design system section').toBeGreaterThan(-1);

        const rest = template.slice(headerIndex + '## Design system'.length);
        const nextHeader = rest.search(/\n## /);
        const section = nextHeader < 0 ? rest : rest.slice(0, nextHeader);

        const sectionLines = section
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.length > 0);

        expect(sectionLines).toEqual(DESIGN_SYSTEM_TEMPLATE_BOILERPLATE.map((line) => line.trim()));
    });

    it('treats a completely untouched template section as unanswered', async () => {
        const template = await readFile(
            resolve(repositoryRoot, '.github/pull_request_template.md'),
            'utf8'
        );

        // Reuse the real template body so this covers the instruction line too,
        // which is the line most likely to be mistaken for an answer.
        const headerIndex = template.indexOf('## Design system');
        const rest = template.slice(headerIndex + '## Design system'.length);
        const nextHeader = rest.search(/\n## /);
        const section = (nextHeader < 0 ? rest : rest.slice(0, nextHeader)).trim();

        const body = buildBody({ '## Design system': section });

        expect(
            validateDesignSystemSection(body, ['apps/desktop/src/views/SearchView/index.vue'])
        ).toBe(
            '"## Design system" still contains the template prompts. Replace them with real answers because this pull request changes UI files.'
        );
    });
});
