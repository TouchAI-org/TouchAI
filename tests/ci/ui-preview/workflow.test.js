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

function stepBlock(job, name) {
    const start = job.indexOf(`- name: ${name}`);
    const next = job.slice(start + 1).search(/\n {12}- /);

    return next === -1 ? job.slice(start) : job.slice(start, start + 1 + next);
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

    it('user gets no separate credential check that can be run and forgotten', () => {
        // Credential state is reported by the run that uses it, so there is no
        // second dispatch mode that can drift from the real pipeline.
        expect(workflow).not.toContain('doctor');
        expect(workflow).not.toContain('inputs.mode');
    });

    it('user gets a decision for a fork pull request without an environment gate', () => {
        const detect = jobBlock('detect');

        // Fork pull_request_target runs deploy a head branch ref, which a
        // protected environment rejects before any step starts.
        expect(detect).not.toContain('environment:');
        expect(detect).toContain('secrets.BOT_APP_ID');
        expect(detect).toContain('secrets.BOT_APP_PRIVATE_KEY');
        expect(detect).toContain('node .github/ui-preview/detect.mjs');
        expect(detect).toContain('id: decide');
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

    it('user gets the runtime library the embedded driver needs', () => {
        const recordPackages = installedPackages(jobBlock('record'));

        expect(recordPackages.has('libwebkit2gtk-4.1-0')).toBe(true);
        expect(recordPackages.has('libwebkit2gtk-4.1-dev')).toBe(false);
        expect(recordPackages.has('webkit2gtk-driver')).toBe(false);
    });

    it('user gets the app state printed when the recording session never starts', () => {
        const record = jobBlock('record');
        const report = stepBlock(record, 'Report the app state');

        // A session that never registers looks the same whether the app crashed
        // or stalled, so the job has to print what it can observe.
        expect(report).toContain("if: failure() && matrix.platform == 'linux'");
        expect(report).toContain('TouchAI|WebKit');
        expect(report).toContain('tail -n 40');

        // The report reads the app root, so it must come from the job env rather
        // than the recording step's own env.
        expect(report).not.toContain('env:');
        expect(record).toContain('TOUCHAI_APP_ROOT: ${{ runner.temp }}/ui-preview-app-root');
        expect(record).toContain('echo "TOUCHAI_APP_ROOT=$TOUCHAI_APP_ROOT" >> "$GITHUB_ENV"');
    });

    it('user gets the database contract the debug build reads from disk', () => {
        const record = jobBlock('record');

        // `tauri build --debug` resolves the contract from
        // `CARGO_MANIFEST_DIR/../src/database`, so a sparse checkout without it
        // starts the app into a blocking failure dialog and no session appears.
        expect(record).toContain('apps/desktop/src/database');
    });

    it('user gets the same stable centered frame in production and validation', () => {
        const record = jobBlock('record');

        expect(record.match(/TOUCHAI_UI_PREVIEW: '1'/g)).toHaveLength(3);
    });

    it('user gets native builds on Linux, macOS, and Windows', () => {
        const explore = jobBlock('explore');
        const record = jobBlock('record');

        for (const platform of ['linux', 'macos', 'windows']) {
            expect(explore).toContain(`platform: ${platform}`);
            expect(record).toContain(`platform: ${platform}`);
        }

        expect(explore).toContain('os: ubuntu-24.04');
        expect(explore).toContain('os: macos-15');
        expect(explore).toContain('os: windows-latest');
        expect(record).toContain('os: ubuntu-24.04');
        expect(record).toContain('os: macos-15');
        expect(record).toContain('os: windows-latest');
    });

    it('user gets the embedded WebDriver build instead of an external driver', () => {
        expect(workflow).toContain(
            'pnpm tauri build --debug --no-bundle --features ui-preview-webdriver'
        );
        expect(workflow).not.toContain('cargo install tauri-driver');
        expect(workflow).not.toContain('webkit2gtk-driver');
    });

    it('user gets the hosted display configured before each native run', () => {
        expect(workflow).toContain('macos-display.swift --configure-hosted');
        expect(workflow).toContain('configure-display.ps1');
        expect(workflow).toContain("UI_PREVIEW_DISPLAY_WIDTH: '1920'");
        expect(workflow).toContain("UI_PREVIEW_DISPLAY_HEIGHT: '1080'");
        expect(workflow).toContain("UI_PREVIEW_STAGE_WIDTH: '1920'");
        expect(workflow).toContain("UI_PREVIEW_STAGE_HEIGHT: '1080'");
        expect(workflow).toContain("UI_PREVIEW_SCALE_FACTOR: '1'");
        expect(workflow).toContain('-screen 0 1920x1080x24');
    });

    it('user gets every platform evidence artifact merged into one publish job', () => {
        const publish = jobBlock('publish');

        expect(publish).toContain('pattern: ui-preview-evidence-*');
        expect(publish).toContain('merge-multiple: false');
        expect(publish).toContain('UI_PREVIEW_PLATFORMS: linux,macos,windows');
    });

    it('user gets the model key only in a job that does not run pull-request code', () => {
        const plan = jobBlock('plan');

        expect(plan).not.toContain('environment:');
        expect(plan).toContain('secrets.UI_PREVIEW_MODEL_API_KEY');
        expect(plan).not.toContain('head_repo');
    });

    it('user gets the attachment and App credentials only in the publish job', () => {
        const publish = jobBlock('publish');

        expect(publish).not.toContain('environment:');
        expect(publish).toContain('secrets.ATTACHMENT_TOKEN');
        expect(publish).toContain('secrets.BOT_APP_ID');
        expect(publish).toContain('secrets.BOT_APP_PRIVATE_KEY');
        expect(publish).not.toContain('head_repo');
    });

    it('user gets the App identity without asking an installation token for /user', () => {
        const detect = jobBlock('detect');
        const publish = jobBlock('publish');

        expect(detect).toContain('UI_PREVIEW_BOT_LOGIN: ${{ steps.app.outputs.app-slug }}[bot]');
        expect(publish).toContain('UI_PREVIEW_BOT_LOGIN: ${{ steps.app.outputs.app-slug }}[bot]');
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

describe('user validates recorder changes through the preview workflow', () => {
    const trustedRef = 'ref: ${{ inputs.scripts_ref || github.event.repository.default_branch }}';

    it('user gets one workflow with an explicit branch-script validation input', () => {
        expect(workflow).toContain('scripts_ref:');
        expect(workflow).toContain('Use scripts from this ref for maintainer validation');
        expect(
            fs.existsSync(
                path.join(repositoryRoot, '.github/workflows/ui-preview-native-validation.yml')
            )
        ).toBe(false);
    });

    it('user gets the selected validation scripts in every trusted checkout', () => {
        for (const name of ['detect', 'explore', 'plan', 'record', 'publish']) {
            expect(jobBlock(name)).toContain(trustedRef);
        }
    });

    it('user gets native-validation comment wording only from a branch-script run', () => {
        const detect = jobBlock('detect');

        expect(detect).toContain('INPUT_SCRIPTS_REF: ${{ inputs.scripts_ref }}');
        expect(detect).toContain('node .github/ui-preview/detect.mjs');
    });
});
