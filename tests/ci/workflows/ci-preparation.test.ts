import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
    readWorkflow,
    type Workflow,
    type WorkflowJob,
    type WorkflowStep,
} from './workflow-test-helpers';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function getJob(workflow: Workflow, id: string): WorkflowJob {
    const job = workflow.jobs[id];
    expect(job).toBeDefined();
    return job as WorkflowJob;
}

function getNamedStep(job: WorkflowJob, name: string): WorkflowStep {
    const matches = job.steps.filter((step) => step.name === name);
    expect(matches).toHaveLength(1);
    return matches[0] as WorkflowStep;
}

function getActionStep(job: WorkflowJob, action: string): WorkflowStep {
    const matches = job.steps.filter((step) => step.uses?.startsWith(`${action}@`) ?? false);
    expect(matches).toHaveLength(1);
    return matches[0] as WorkflowStep;
}

function getStepIndex(job: WorkflowJob, name: string): number {
    const index = job.steps.findIndex((step) => step.name === name);
    expect(index).toBeGreaterThanOrEqual(0);
    return index;
}

function getActionIndex(job: WorkflowJob, action: string): number {
    const index = job.steps.findIndex((step) => step.uses?.startsWith(`${action}@`) ?? false);
    expect(index).toBeGreaterThanOrEqual(0);
    return index;
}

function getRun(step: WorkflowStep): string {
    expect(typeof step.run).toBe('string');
    return step.run ?? '';
}

function getRunLines(step: WorkflowStep): string[] {
    return getRun(step)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
}

function normalizeShellContinuations(value: string): string {
    return value.replace(/\\[ \t]*\r?\n/g, ' ');
}

function jobRuns(job: WorkflowJob): string {
    return job.steps
        .map((step) => step.run ?? '')
        .join('\n')
        .trim();
}

function expectMatrixEntries(
    job: WorkflowJob,
    keys: string[],
    expected: Array<Record<string, string>>
): void {
    const strategy = job.strategy as {
        matrix?: {
            include?: unknown;
        };
    };
    const include = strategy.matrix?.include;

    expect(Array.isArray(include)).toBe(true);
    const entries = (include as unknown[]).map((entry, index) => {
        expect(entry, `matrix include[${index}]`).not.toBeNull();
        expect(typeof entry, `matrix include[${index}]`).toBe('object');
        expect(Array.isArray(entry), `matrix include[${index}]`).toBe(false);

        const record = entry as Record<string, unknown>;
        return Object.fromEntries(
            keys.map((key) => {
                const value = record[key];
                expect(typeof value, `matrix include[${index}].${key}`).toBe('string');
                expect(value, `matrix include[${index}].${key}`).not.toBe('');
                return [key, value as string];
            })
        ) as Record<string, string>;
    });

    expect(entries).toHaveLength(expected.length);
    for (const entry of expected) {
        expect(entries).toContainEqual(entry);
    }
}

describe('user prepares Rust coverage from a verified prebuilt tool', () => {
    it('user sees cargo-llvm-cov installed from one checksum-verified Linux archive', () => {
        const job = getJob(readWorkflow('ci.yml'), 'rust-coverage');
        const step = getNamedStep(job, 'Install cargo-llvm-cov');
        const run = getRun(step);

        expect(step.if).toBe("needs.changes.outputs.docs_only != 'true'");
        expect(step.env).toMatchObject({
            LLVM_COV_VERSION: '0.9.1',
            LLVM_COV_SHA256: 'b3f68e625481fed9b16444174f3fa5ebcdbde4a1878803a35eabe2dcefcdc41a',
        });
        expect(run.match(/\bcurl\b/g)).toHaveLength(1);
        expect(run).not.toMatch(/\bwget\b/);
        expect(run.match(/https?:\/\/[^\s"'\\]+/g) ?? []).toEqual([
            'https://github.com/taiki-e/cargo-llvm-cov/releases/download/v${LLVM_COV_VERSION}/cargo-llvm-cov-x86_64-unknown-linux-gnu.tar.gz',
        ]);
        expect(run).not.toContain('--url');
        expect(run.match(/--output\b/g)).toHaveLength(1);
        expect(getRunLines(step)).toContain(
            '"https://github.com/taiki-e/cargo-llvm-cov/releases/download/v${LLVM_COV_VERSION}/cargo-llvm-cov-x86_64-unknown-linux-gnu.tar.gz" \\'
        );
        expect(getRunLines(step)).toContain('--output "$archive"');
        expect(run).toContain('sha256sum --check -');
        expect(run).toContain('mkdir -p "$HOME/.cargo/bin"');
        expect(run).toContain('tar -xzf "$archive" -C "$HOME/.cargo/bin" cargo-llvm-cov');
        expect(run).toContain('cargo llvm-cov --version');
        expect(normalizeShellContinuations(jobRuns(job))).not.toMatch(/\bcargo\s+install\b/);
    });

    it('user sees cargo-audit installed from one checksum-verified Linux archive', () => {
        const job = getJob(readWorkflow('security.yml'), 'audits');
        const step = getNamedStep(job, 'Install cargo-audit');
        const run = getRun(step);

        expect(step.env).toMatchObject({
            CARGO_AUDIT_VERSION: '0.22.2',
            CARGO_AUDIT_SHA256: 'ab28a1bdb54db4d5d8ad5981cf1f959410370b3d28250dbd35f6a44248620e39',
            CARGO_AUDIT_MEMBER: 'cargo-audit-x86_64-unknown-linux-gnu-v0.22.2/cargo-audit',
        });
        expect(run.match(/\bcurl\b/g)).toHaveLength(1);
        expect(run).not.toMatch(/\bwget\b/);
        expect(run.match(/https?:\/\/[^\s"'\\]+/g) ?? []).toEqual([
            'https://github.com/rustsec/rustsec/releases/download/cargo-audit/v${CARGO_AUDIT_VERSION}/cargo-audit-x86_64-unknown-linux-gnu-v${CARGO_AUDIT_VERSION}.tgz',
        ]);
        expect(run).not.toContain('--url');
        expect(run.match(/--output\b/g)).toHaveLength(1);
        expect(getRunLines(step)).toContain(
            '"https://github.com/rustsec/rustsec/releases/download/cargo-audit/v${CARGO_AUDIT_VERSION}/cargo-audit-x86_64-unknown-linux-gnu-v${CARGO_AUDIT_VERSION}.tgz" \\'
        );
        expect(getRunLines(step)).toContain('--output "$archive"');
        expect(run).toContain('sha256sum --check -');
        expect(run).toContain('tar -xzf "$archive" -C "$extract_dir" "$CARGO_AUDIT_MEMBER"');
        expect(run).toContain(
            'install -m 0755 "$extract_dir/$CARGO_AUDIT_MEMBER" "$HOME/.cargo/bin/cargo-audit"'
        );
        expect(run).toContain('cargo-audit --version');
        expect(normalizeShellContinuations(jobRuns(job))).not.toMatch(/\bcargo\s+install\b/);
    });

    it('user sees cargo-audit 0.22.2 invoked with the supported file argument', () => {
        const job = getJob(readWorkflow('security.yml'), 'audits');
        const step = getNamedStep(job, 'Audit Rust dependencies');

        expect(getRun(step).trim()).toBe(
            'cargo-audit audit --file apps/desktop/src-tauri/Cargo.lock'
        );
        expect(getRun(step)).not.toContain('--manifest-path');
    });
});

describe('user prepares pnpm before restoring its cache', () => {
    it('user sees setup-node disable caching on Windows and restore pnpm on Ubuntu', () => {
        const security = readWorkflow('security.yml');
        const auditsNode = getActionStep(getJob(security, 'audits'), 'actions/setup-node');
        const codeqlNode = getActionStep(getJob(security, 'codeql'), 'actions/setup-node');
        const e2eNode = getActionStep(
            getJob(readWorkflow('e2e-smoke.yml'), 'desktop-e2e-smoke-windows'),
            'actions/setup-node'
        );

        expect(auditsNode.with).toEqual({
            'node-version': 22,
            cache: 'pnpm',
        });
        expect(codeqlNode.with).toEqual({
            'node-version': 22,
            'package-manager-cache': false,
        });
        expect(e2eNode.with).toEqual({
            'node-version': 22,
            'package-manager-cache': false,
        });
    });

    it('user sees audit dependencies restored only after pnpm is ready', () => {
        const job = getJob(readWorkflow('security.yml'), 'audits');
        const pnpm = getActionStep(job, 'pnpm/action-setup');
        const node = getActionStep(job, 'actions/setup-node');

        expect(getActionIndex(job, 'pnpm/action-setup')).toBeLessThan(
            getActionIndex(job, 'actions/setup-node')
        );
        expect(pnpm.if).toBeUndefined();
        expect(node.if).toBeUndefined();
        expect(node.with?.cache).toBe('pnpm');
        expect(node.with).not.toHaveProperty('package-manager-cache');
    });

    it('user sees the Windows CodeQL setup run only after pnpm is ready', () => {
        const workflow = readWorkflow('security.yml');
        const job = getJob(workflow, 'codeql');
        const pnpm = getActionStep(job, 'pnpm/action-setup');
        const node = getActionStep(job, 'actions/setup-node');

        expect(getActionIndex(job, 'pnpm/action-setup')).toBeLessThan(
            getActionIndex(job, 'actions/setup-node')
        );
        expect(pnpm.if).toBe("steps.gate.outputs.run == 'true' && matrix.language == 'rust'");
        expect(node.if).toBe("steps.gate.outputs.run == 'true' && matrix.language == 'rust'");
        expect(node.with?.cache).toBeUndefined();
        expect(node.with?.['package-manager-cache']).toBe(false);
        expectMatrixEntries(
            job,
            ['language', 'os'],
            [
                {
                    language: 'javascript-typescript',
                    os: 'ubuntu-latest',
                },
                {
                    language: 'rust',
                    os: 'windows-latest',
                },
            ]
        );
    });
});

describe('user runs desktop E2E from one freshly built application', () => {
    it('user sees the app built once before either E2E execution path', () => {
        const job = getJob(readWorkflow('e2e-smoke.yml'), 'desktop-e2e-smoke-windows');
        const node = getActionStep(job, 'actions/setup-node');
        const build = getNamedStep(job, 'Build desktop smoke app');
        const buildIndex = getStepIndex(job, 'Build desktop smoke app');
        const runIndex = getStepIndex(job, 'Run desktop smoke tests');
        const updateIndex = getStepIndex(job, 'Regenerate visual baselines');
        const run = getNamedStep(job, 'Run desktop smoke tests');
        const update = getNamedStep(job, 'Regenerate visual baselines');

        expect(node.with?.cache).toBeUndefined();
        expect(node.with?.['package-manager-cache']).toBe(false);
        expect(build.if).toBeUndefined();
        expect(buildIndex).toBeGreaterThan(getStepIndex(job, 'Install frontend dependencies'));
        expect(buildIndex).toBeGreaterThan(getStepIndex(job, 'Verify preinstalled tauri-driver'));
        expect(buildIndex).toBeGreaterThan(getStepIndex(job, 'Configure Edge WebDriver'));
        expect(buildIndex).toBeLessThan(runIndex);
        expect(buildIndex).toBeLessThan(updateIndex);
        expect(getRun(build).trim()).toBe(
            'pnpm tauri build --debug --no-bundle -- --profile ci-check'
        );
        expect(build.env).toMatchObject({
            CARGO_TARGET_DIR: '${{ github.workspace }}/${{ env.TOUCHAI_CARGO_TARGET_DIR }}',
            TEMP: '${{ runner.temp }}',
            TMP: '${{ runner.temp }}',
        });

        const skipBuildSteps = job.steps.filter(
            (step) =>
                step.env !== undefined &&
                Object.prototype.hasOwnProperty.call(step.env, 'TOUCHAI_E2E_SKIP_BUILD')
        );

        expect(skipBuildSteps.map((step) => step.name)).toEqual([
            'Run desktop smoke tests',
            'Regenerate visual baselines',
        ]);
        expect(run.env?.TOUCHAI_E2E_SKIP_BUILD).toBe('1');
        expect(update.env?.TOUCHAI_E2E_SKIP_BUILD).toBe('1');
        expect(build.env?.TOUCHAI_E2E_SKIP_BUILD).toBeUndefined();
    });

    it('user sees every E2E specification, visual path, and diagnostic preserved', () => {
        const job = getJob(readWorkflow('e2e-smoke.yml'), 'desktop-e2e-smoke-windows');
        const run = getNamedStep(job, 'Run desktop smoke tests');
        const update = getNamedStep(job, 'Regenerate visual baselines');
        const wdio = readFileSync(
            resolve(repositoryRoot, 'apps/desktop/e2e-tests/wdio.conf.js'),
            'utf8'
        );
        const specs = Array.from(
            wdio.matchAll(/path\.join\(__dirname, 'test\/specs\/([^']+)'\)/g),
            (match) => match[1] ?? ''
        );

        expect(run.id).toBe('tests');
        expect(run.if).toBe('${{ !inputs.update_visual_baselines }}');
        expect(getRun(run).trim()).toBe('pnpm test:e2e');
        expect(update.if).toBe('${{ inputs.update_visual_baselines }}');
        expect(getRun(update).trim()).toBe('pnpm --filter @touchai/desktop test:e2e:visual:update');
        expect(specs).toEqual([
            'app-start.e2e.js',
            'product-font.e2e.js',
            'main-window-visual.e2e.js',
            'search-smoke.e2e.js',
            'settings-smoke.e2e.js',
            'prompt-compose.e2e.js',
            'window-size.e2e.js',
            'clipboard-paste.e2e.js',
        ]);
        expect(wdio).toContain('autoSaveBaseline: updateVisualBaselines');
        expect(wdio).toContain('compareOptions');

        const gather = getNamedStep(job, 'Gather the diff images');
        expect(gather.if).toBe('${{ !cancelled() && !inputs.update_visual_baselines }}');
        expect(gather.shell).toBe('pwsh');
        expect(gather['continue-on-error']).toBeUndefined();

        const publish = getNamedStep(job, 'Publish the diff images');
        expect(publish.if).toBe('${{ !cancelled() && !inputs.update_visual_baselines }}');
        expect(publish.shell).toBeUndefined();
        expect(publish['continue-on-error']).toBeUndefined();
        expect(publish['working-directory']).toBe('apps/desktop');
        expect(publish.env).toMatchObject({
            UI_PREVIEW_TOKEN: '${{ secrets.UI_PREVIEW_TOKEN }}',
        });

        const summarise = getNamedStep(job, 'Summarise the visual differences');
        expect(summarise.if).toBe('${{ !cancelled() && !inputs.update_visual_baselines }}');
        expect(summarise.shell).toBeUndefined();
        expect(summarise['continue-on-error']).toBeUndefined();
        expect(summarise.env?.VISUAL_TESTS_OUTCOME).toBe('${{ steps.tests.outcome }}');

        const uploadBaselines = getNamedStep(job, 'Upload visual baselines');
        expect(uploadBaselines.if).toBe('${{ inputs.update_visual_baselines }}');
        expect(uploadBaselines['continue-on-error']).toBeUndefined();
        expect(uploadBaselines.uses).toMatch(/^actions\/upload-artifact@/);
        expect(uploadBaselines.with).toEqual({
            name: 'visual-baselines',
            path: 'apps/desktop/e2e-tests/__snapshots__/',
            'if-no-files-found': 'error',
        });

        const uploadDiffs = getNamedStep(job, 'Upload diff artifacts');
        expect(uploadDiffs.if).toBe('${{ failure() && !inputs.update_visual_baselines }}');
        expect(uploadDiffs['continue-on-error']).toBeUndefined();
        expect(uploadDiffs.uses).toMatch(/^actions\/upload-artifact@/);
        expect(uploadDiffs.with).toEqual({
            name: 'app-visual-diffs',
            path: '${{ runner.temp }}/visual-diffs/',
            'if-no-files-found': 'ignore',
        });
    });

    it('user sees the runner-provided tauri-driver used without compilation', () => {
        const job = getJob(readWorkflow('e2e-smoke.yml'), 'desktop-e2e-smoke-windows');
        const verify = getNamedStep(job, 'Verify preinstalled tauri-driver');
        const workflowSource = JSON.stringify(job);

        expect(verify.shell).toBe('pwsh');
        expect(getRun(verify)).toContain('$driver = Get-Command tauri-driver -ErrorAction Stop');
        expect(getRun(verify)).toContain('tauri-driver --version');
        expect(workflowSource).not.toMatch(
            /cargo\s+install|quickinstall|cargo-binstall|install-action/i
        );
    });
});

describe('user records the UI preview from the supported macOS ffmpeg', () => {
    it('user sees ffmpeg installed only through ffmpeg@7 with explicit tool paths', () => {
        const workflow = readWorkflow('ui-preview.yml');
        const record = getJob(workflow, 'record');
        const explore = getJob(workflow, 'explore');
        const install = getNamedStep(record, 'Install macOS dependencies');
        const lines = getRunLines(install);
        const macPackages = lines.filter((line) => line.startsWith('brew install '));
        const ffmpegExport = 'echo "UI_PREVIEW_FFMPEG=$ffmpeg7" >> "$GITHUB_ENV"';
        const ffprobeExport = 'echo "UI_PREVIEW_FFPROBE=$ffprobe7" >> "$GITHUB_ENV"';
        const firstConditional = lines.findIndex((line) => /^(?:if|elif|else)\b/.test(line));

        expect(macPackages).toEqual(['brew install ffmpeg@7']);
        expect(lines).toContain('ffmpeg7="$(brew --prefix ffmpeg@7)/bin/ffmpeg"');
        expect(lines).toContain('ffprobe7="$(brew --prefix ffmpeg@7)/bin/ffprobe"');
        expect(lines).toContain(ffmpegExport);
        expect(lines).toContain(ffprobeExport);
        expect(firstConditional).toBeGreaterThan(lines.indexOf(ffmpegExport));
        expect(firstConditional).toBeGreaterThan(lines.indexOf(ffprobeExport));
        expect(getRun(install)).toContain("grep -q ' ass '");
        expectMatrixEntries(
            record,
            ['platform', 'os', 'binary'],
            [
                {
                    platform: 'linux',
                    os: 'ubuntu-24.04',
                    binary: 'TouchAI',
                },
                {
                    platform: 'macos',
                    os: 'macos-15',
                    binary: 'TouchAI',
                },
                {
                    platform: 'windows',
                    os: 'windows-latest',
                    binary: 'TouchAI.exe',
                },
            ]
        );
        expectMatrixEntries(
            explore,
            ['platform', 'os', 'binary'],
            [
                {
                    platform: 'linux',
                    os: 'ubuntu-24.04',
                    binary: 'TouchAI',
                },
                {
                    platform: 'macos',
                    os: 'macos-15',
                    binary: 'TouchAI',
                },
                {
                    platform: 'windows',
                    os: 'windows-latest',
                    binary: 'TouchAI.exe',
                },
            ]
        );
        expect(
            explore.steps.some(
                (step) =>
                    step.uses?.startsWith('actions/checkout@') &&
                    step.with?.repository === '${{ needs.detect.outputs.head_repo }}'
            )
        ).toBe(true);
        expect(record.steps.some((step) => step.uses?.startsWith('actions/checkout@'))).toBe(true);
        expect(JSON.stringify(record)).not.toContain('head_repo');
        expect(JSON.stringify(record)).not.toContain('secrets.');
        expect(JSON.stringify(explore)).not.toContain('secrets.');
    });
});

describe('user keeps the existing Rust coverage validation', () => {
    it('user sees the same tools, conditional steps, command, report, artifact, and floors', () => {
        const workflow = readWorkflow('ci.yml');
        const job = getJob(workflow, 'rust-coverage');
        const toolchain = getNamedStep(job, 'Install Rust stable');
        const cache = getNamedStep(job, 'Rust cache');
        const coverage = getNamedStep(job, 'Run Rust coverage');
        const resolveReport = getNamedStep(job, 'Locate Rust coverage report');
        const summarize = getNamedStep(job, 'Summarize coverage');
        const upload = getNamedStep(job, 'Upload coverage artifact');
        const floors = JSON.parse(
            readFileSync(
                resolve(repositoryRoot, 'apps/desktop/src-tauri/coverage-floors.json'),
                'utf8'
            )
        ) as { lines: number; regions: number };

        expect(toolchain.with?.components).toBe('llvm-tools-preview');
        expect(cache.uses).toMatch(/^swatinem\/rust-cache@/);
        for (const step of [
            getNamedStep(job, 'Install cargo-llvm-cov'),
            cache,
            coverage,
            resolveReport,
            summarize,
            upload,
        ]) {
            expect(step.if).toBe("needs.changes.outputs.docs_only != 'true'");
        }
        expect(getRun(coverage).trim()).toBe('pnpm test:coverage:rust');
        expect(getRun(resolveReport)).toContain('summarize-coverage.mjs --resolve-rust');
        expect(getRun(summarize)).toContain('summarize-coverage.mjs --kind rust');
        expect(upload.with).toMatchObject({
            name: 'rust-coverage-report',
            path: '${{ env.RUST_COVERAGE_REPORT }}',
            'if-no-files-found': 'error',
        });
        expect(floors).toEqual({ lines: 63, regions: 64 });
    });
});

describe('user runs dependency audits on their existing policy', () => {
    it('user sees npm and Rust audits only on the schedule or manual dispatch', () => {
        const workflow = readWorkflow('security.yml');
        const job = getJob(workflow, 'audits');
        const npmAudit = getNamedStep(job, 'Audit npm dependencies');
        const rustAudit = getNamedStep(job, 'Audit Rust dependencies');

        expect(workflow.on.schedule).toEqual([{ cron: '0 5 * * 1' }]);
        expect(workflow.on).toHaveProperty('workflow_dispatch');
        expect(job.if).toBe(
            "github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'"
        );
        expect(getRun(npmAudit).trim()).toBe('pnpm audit --prod --audit-level high');
        expect(getRun(rustAudit)).not.toContain('--ignore');
        expect(getRun(rustAudit)).not.toContain('|| true');
        expect(rustAudit['continue-on-error']).toBeUndefined();
    });
});
