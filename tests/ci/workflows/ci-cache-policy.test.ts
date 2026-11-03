import { describe, expect, it } from 'vitest';

import { readWorkflow, type Workflow, type WorkflowStep } from './workflow-test-helpers';

const mainOnlySaveIf = "${{ github.ref == 'refs/heads/main' }}";
const temporaryEquivalenceJob = 'frontend-equivalence-baseline';
const temporaryEquivalenceJobName = 'TEMPORARY Frontend Equivalence Baseline (Measurement Only)';

interface RustCacheStep {
    job: string;
    step: WorkflowStep;
}

function rustCacheSteps(workflow: Workflow): RustCacheStep[] {
    return Object.entries(workflow.jobs).flatMap(([job, definition]) =>
        definition.steps
            .filter((step) => step.uses?.startsWith('swatinem/rust-cache@'))
            .map((step) => ({ job, step }))
    );
}

function cacheContracts(workflow: Workflow) {
    return rustCacheSteps(workflow).map(({ job, step }) => ({
        job,
        workspaces: step.with?.workspaces,
        saveIf: step.with?.['save-if'],
    }));
}

describe('user reviews cache writes and CI job scope', () => {
    it('user sees ordinary Rust validation restore caches while only main saves them', () => {
        expect(cacheContracts(readWorkflow('ci.yml'))).toEqual([
            {
                job: 'rust-checks',
                workspaces: 'apps/desktop/src-tauri -> target',
                saveIf: mainOnlySaveIf,
            },
            {
                job: 'build-windows',
                workspaces: 'apps/desktop/src-tauri -> target',
                saveIf: mainOnlySaveIf,
            },
        ]);
    });

    it('user sees desktop end-to-end validation restore its cache while only main saves it', () => {
        expect(cacheContracts(readWorkflow('e2e-smoke.yml'))).toEqual([
            {
                job: 'desktop-e2e-smoke-windows',
                workspaces: 'apps/desktop/src-tauri -> target/e2e',
                saveIf: mainOnlySaveIf,
            },
        ]);
    });

    it('user sees security analysis keep its existing main-only cache policy', () => {
        expect(cacheContracts(readWorkflow('security.yml'))).toEqual([
            {
                job: 'codeql',
                workspaces: 'apps/desktop/src-tauri -> ../../../rust-target/ci-check',
                saveIf: mainOnlySaveIf,
            },
        ]);
    });

    it('user sees UI preview keep its specialized cache without a save policy', () => {
        const caches = rustCacheSteps(readWorkflow('ui-preview.yml'));

        expect(caches.map(({ job, step }) => ({ job, workspaces: step.with?.workspaces }))).toEqual(
            [
                {
                    job: 'explore',
                    workspaces: 'apps/desktop/src-tauri -> ../../../.ui-preview-target',
                },
            ]
        );
        expect(caches[0]?.step.with).not.toHaveProperty('save-if');
    });

    it('user sees no temporary frontend measurement job in CI', () => {
        const workflow = readWorkflow('ci.yml');

        expect(workflow.jobs).not.toHaveProperty(temporaryEquivalenceJob);
        expect(Object.values(workflow.jobs).map((job) => job.name)).not.toContain(
            temporaryEquivalenceJobName
        );
    });

    it('user sees every required CI check remain attached to the final gate', () => {
        const requiredGate = readWorkflow('ci.yml').jobs['ci-required'];

        expect(requiredGate?.needs).toEqual([
            'changes',
            'workflow-lint',
            'conventional-commits',
            'dependency-review',
            'frontend-quality',
            'frontend-tests',
            'ci-tests',
            'site-build',
            'rust-checks',
            'architecture',
            'build-windows',
        ]);
    });
});
