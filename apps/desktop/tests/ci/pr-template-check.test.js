import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { validatePrTemplateBody } from '../../scripts/ci/pr-template-check.js';

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
        const body = [
            '## Summary',
            'Adds the thing.',
            '## Related issue or RFC',
            'N/A',
            '## AI assistance disclosure',
            'No AI assistance.',
            '## Testing evidence',
            'pnpm test',
            '## Risk notes',
            'Low.',
            '## Screenshots or recordings',
            'N/A',
            '## Checklist',
            '- [x] Tests pass',
        ].join('\n');

        expect(validatePrTemplateBody(body, { headRef: 'feature/regular-pr' })).toBe(
            '"## Related issue or RFC" must include an issue, RFC, or repository link.'
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
