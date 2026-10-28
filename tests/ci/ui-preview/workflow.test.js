import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, '../../..');
const workflowPath = path.join(repositoryRoot, '.github/workflows/ui-preview.yml');
const workflow = fs.readFileSync(workflowPath, 'utf8');

function jobBlock(name) {
    const start = workflow.indexOf(`\n    ${name}:`);
    const next = workflow.slice(start + 1).search(/\n {4}[a-z][a-z-]*:/);

    return next === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
}

function installedPackages(job) {
    const lines = job.split('\n');
    const start = lines.findIndex((line) => line.includes('apt-get install'));
    const packages = [];

    for (let index = start + 1; index < lines.length; index += 1) {
        const line = lines[index].trim();
        const name = line.replace(/\\$/, '').trim();

        if (!name) {
            break;
        }

        packages.push(name);

        if (!line.endsWith('\\')) {
            break;
        }
    }

    return new Set(packages);
}

describe('user opens a pull request that runs the preview', () => {
    it('user gets a preview trigger that never uses the default write token', () => {
        expect(workflow).toContain('pull_request_target');
        expect(workflow).toContain('permissions: {}');
    });

    it('user gets a superseded run cancelled instead of queued', () => {
        expect(workflow).toContain('cancel-in-progress: true');
        expect(workflow).toContain('ui-preview-${{');
    });

    it('user gets the preview run preserved when the App adds its approval label', () => {
        expect(workflow).toContain("endsWith(github.actor, '[bot]')");
        expect(workflow).toContain("'approval' || 'run'");
    });

    it('user can check credentials from the same workflow without a pull request', () => {
        expect(workflow).toContain('mode:');
        expect(workflow).toContain("inputs.mode == 'doctor'");
        expect(workflow).toContain('doctor-model');
        expect(workflow).toContain('doctor-publish');
    });

    it('user gets the pull request code built only in a job without secrets', () => {
        const explore = jobBlock('explore');

        expect(explore).toContain('repository: ${{ needs.detect.outputs.head_repo }}');
        expect(explore).not.toContain('secrets.');
        expect(explore).not.toContain('environment:');
        expect(explore).toContain('contents: read');
    });

    it('user gets a recording job that never checks out the pull request', () => {
        const record = jobBlock('record');

        expect(record).not.toContain('needs.detect.outputs.head_repo');
        expect(record).not.toContain('secrets.');
        expect(record).not.toContain('environment:');
    });

    it('user gets the recording job installed with every library the build job needs', () => {
        const explorePackages = installedPackages(jobBlock('explore'));
        const recordPackages = installedPackages(jobBlock('record'));

        // Both jobs drive the same binary through tauri-driver, so a package the
        // build job needs to reach a session is needed by the recorder too.
        expect([...explorePackages].filter((name) => !recordPackages.has(name))).toEqual([]);
        expect(recordPackages.has('libwebkit2gtk-4.1-dev')).toBe(true);
    });

    it('user gets the model key only in a job that does not run pull-request code', () => {
        const plan = jobBlock('plan');

        expect(plan).toContain('environment: ui-preview');
        expect(plan).toContain('secrets.UI_PREVIEW_MODEL_API_KEY');
        expect(plan).not.toContain('head_repo');
    });

    it('user gets both publishing credentials only in the publish job', () => {
        const publish = jobBlock('publish');

        expect(publish).toContain('environment: ui-preview-publish');
        expect(publish).toContain('secrets.ATTACHMENT_TOKEN');
        expect(publish).toContain('secrets.BOT_APP_ID');
        expect(publish).toContain('secrets.BOT_APP_PRIVATE_KEY');
        expect(publish).toContain('UI_PREVIEW_BOT_LOGIN: ${{ steps.app.outputs.app-slug }}[bot]');
        expect(publish).not.toContain('head_repo');
    });

    it('user gets the comment edited in place rather than appended', () => {
        const publishScript = fs.readFileSync(
            path.join(repositoryRoot, '.github/ui-preview/publish.mjs'),
            'utf8'
        );

        expect(publishScript).toContain('findOwnPreviewComment');
        expect(publishScript).toContain('updateComment');
        expect(publishScript).not.toContain('edit-last');
    });

    it('user gets no credential written into the workflow or the scripts', () => {
        const directory = path.join(repositoryRoot, '.github/ui-preview');
        const files = [];
        const queue = [directory];

        while (queue.length > 0) {
            const current = queue.shift();

            for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
                const full = path.join(current, entry.name);

                if (entry.isDirectory() && full === path.join(directory, 'tests')) {
                    continue;
                }

                if (entry.isDirectory()) {
                    queue.push(full);
                } else {
                    files.push(full);
                }
            }
        }

        for (const file of [...files, workflowPath]) {
            const text = fs.readFileSync(file, 'utf8');

            expect(text).not.toMatch(/sk-[A-Za-z0-9]{16,}/);
            expect(text).not.toMatch(/gh[opsu]_[A-Za-z0-9]{20,}/);
            expect(text).not.toMatch(/BEGIN (RSA )?PRIVATE KEY/);
        }
    });
});
