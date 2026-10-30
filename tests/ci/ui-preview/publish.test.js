import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { captureMode } from '../../../.github/ui-preview/lib/platform.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function writeManifest(root, platform, warnings) {
    const directory = path.join(root, platform);
    fs.mkdirSync(path.join(directory, 'evidence'), { recursive: true });
    fs.writeFileSync(
        path.join(directory, 'manifest.json'),
        `${JSON.stringify(
            {
                version: 1,
                sha: 'abcdef0',
                platform,
                captureMode: captureMode(platform),
                scenes: [{ title: 'Search', shots: [] }],
                warnings,
            },
            null,
            2
        )}\n`
    );
}

describe('user reads recorder warnings in the preview comment', () => {
    it('user sees a warning from the manifest in the dry-run comment', () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'touchai-ui-preview-publish-'));
        const warning = 'fixture data was not written: test warning';

        writeManifest(directory, 'linux', [warning]);

        try {
            const result = spawnSync(process.execPath, ['.github/ui-preview/publish.mjs'], {
                cwd: repoRoot,
                encoding: 'utf8',
                env: {
                    ...process.env,
                    GITHUB_REPOSITORY: 'TouchAI-org/TouchAI',
                    UI_PREVIEW_PR: '1',
                    UI_PREVIEW_OUT: directory,
                    UI_PREVIEW_PLATFORMS: 'linux',
                    UI_PREVIEW_DRY_RUN: '1',
                    UI_PREVIEW_SHA: 'abcdef0',
                    UI_PREVIEW_ARTIFACT_URL: 'https://example.test/artifact',
                },
            });

            expect(result.status, result.stderr).toBe(0);

            const comment = fs.readFileSync(path.join(directory, 'comment.md'), 'utf8');
            expect(comment).toContain(warning);
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
});
