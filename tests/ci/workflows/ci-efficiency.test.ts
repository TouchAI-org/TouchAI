import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { readWorkflow, type WorkflowJob, type WorkflowStep } from './workflow-test-helpers';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDirectory, '../../..');

function job(workflow: ReturnType<typeof readWorkflow>, id: string): WorkflowJob {
    const definition = workflow.jobs[id];

    if (definition === undefined) {
        throw new Error(`Workflow job ${id} is missing.`);
    }

    return definition;
}

function step(jobDefinition: WorkflowJob, name: string): WorkflowStep {
    const definition = jobDefinition.steps.find((candidate) => candidate.name === name);

    if (definition === undefined) {
        throw new Error(`Workflow step ${name} is missing.`);
    }

    return definition;
}

function normalizedRun(definition: WorkflowStep): string {
    return (definition.run ?? '').replace(/\s+/g, ' ').trim();
}

describe('user runs Rust validation once without losing target or coverage checks', () => {
    it('user sees one Rust job own formatting, all-target coverage, report, and artifact', () => {
        const workflow = readWorkflow('ci.yml');
        const rustChecks = job(workflow, 'rust-checks');
        const packageJson = JSON.parse(
            readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8')
        ) as {
            scripts: Record<string, string>;
        };
        const desktopPackageJson = JSON.parse(
            readFileSync(resolve(repositoryRoot, 'apps/desktop/package.json'), 'utf8')
        ) as {
            scripts: Record<string, string>;
        };

        expect(workflow.jobs).not.toHaveProperty('rust-coverage');
        expect(rustChecks.name).toBe('Rust Checks');
        expect(step(rustChecks, 'Install Rust stable').with?.components).toBe('llvm-tools-preview');
        expect(
            rustChecks.steps.filter((candidate) =>
                candidate.uses?.startsWith('swatinem/rust-cache@')
            )
        ).toHaveLength(1);
        expect(String(step(rustChecks, 'Rust cache').with?.workspaces ?? '').trim()).toBe(
            'apps/desktop/src-tauri -> target'
        );
        expect(normalizedRun(step(rustChecks, 'Check Rust formatting'))).toBe(
            'cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --all -- --check'
        );
        expect(normalizedRun(step(rustChecks, 'Run Rust coverage'))).toBe(
            'pnpm test:coverage:rust'
        );
        expect(rustChecks.steps.map((candidate) => candidate.name)).not.toContain(
            'Check Rust targets'
        );
        expect(rustChecks.steps.map((candidate) => candidate.name)).not.toContain('Run Rust tests');

        const rootCoverageCommand = packageJson.scripts['test:coverage:rust'];
        const coverageCommand = desktopPackageJson.scripts['test:coverage:rust'];
        expect(rootCoverageCommand).toBe('pnpm --filter @touchai/desktop test:coverage:rust');
        expect(coverageCommand).toContain('cargo llvm-cov');
        expect(coverageCommand).toContain('--all-targets');
        expect(coverageCommand).not.toMatch(/--no-(?:run|report)\b/);

        const requiredNeeds = job(workflow, 'ci-required').needs;
        expect(Array.isArray(requiredNeeds) ? requiredNeeds : [requiredNeeds]).toContain(
            'rust-checks'
        );
        expect(Array.isArray(requiredNeeds) ? requiredNeeds : [requiredNeeds]).not.toContain(
            'rust-coverage'
        );
    });
});

describe('user installs only dependencies each optimized job needs', () => {
    it('user sees commit policy checks install only root dependencies while keeping title and range validation', () => {
        const commits = job(readWorkflow('ci.yml'), 'conventional-commits');

        expect(step(commits, 'Install dependencies').run?.trim()).toBe(
            'pnpm install --frozen-lockfile --filter . --ignore-scripts'
        );
        expect(
            commits.steps.find((candidate) => candidate.uses?.startsWith('actions/checkout@'))
                ?.with?.['fetch-depth']
        ).toBe(0);
        expect(normalizedRun(step(commits, 'Validate pull request title'))).toContain(
            'pnpm exec commitlint --verbose'
        );
        expect(normalizedRun(step(commits, 'Validate commit messages'))).toContain(
            '--from "${{ github.event.pull_request.base.sha }}"'
        );
        expect(normalizedRun(step(commits, 'Validate commit messages'))).toContain(
            '--to "${{ github.event.pull_request.head.sha }}"'
        );
    });

    it('user sees site build install only the selected workspace dependency graph', () => {
        const siteBuild = job(readWorkflow('ci.yml'), 'site-build');

        expect(step(siteBuild, 'Install dependencies').run?.trim()).toBe(
            'pnpm install --frozen-lockfile --filter @touchai/site...'
        );
        expect(normalizedRun(step(siteBuild, 'Build site'))).toBe('pnpm site:build');
    });

    it('user sees the coverage merge install only desktop dependencies and retain patch coverage history', () => {
        const aggregate = job(readWorkflow('ci.yml'), 'frontend-tests');
        const checkout = aggregate.steps.find((candidate) =>
            candidate.uses?.startsWith('actions/checkout@')
        );

        expect(normalizedRun(step(aggregate, 'Install dependencies'))).toBe(
            'pnpm install --frozen-lockfile --filter @touchai/desktop...'
        );
        expect(checkout?.with?.['fetch-depth']).toBe(0);
        expect(normalizedRun(step(aggregate, 'Check patch coverage'))).toContain('--floor 85');
        expect(
            normalizedRun(step(aggregate, 'Merge frontend shard reports with coverage'))
        ).toContain('--merge-reports=.vitest-reports');
    });
});
