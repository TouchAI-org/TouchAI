import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { readWorkflow, type WorkflowJob } from './workflow-test-helpers';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDirectory, '../../..');

type GateEnvironment = Record<string, string | undefined>;

interface GateResult {
    status: number | null;
    output: string;
}

const ciResultVariables = [
    'CHANGES_RESULT',
    'WORKFLOW_LINT_RESULT',
    'CONVENTIONAL_COMMITS_RESULT',
    'DEPENDENCY_REVIEW_RESULT',
    'FRONTEND_QUALITY_RESULT',
    'FRONTEND_TESTS_RESULT',
    'CI_TESTS_RESULT',
    'SITE_BUILD_RESULT',
    'RUST_CHECKS_RESULT',
    'BUILD_WINDOWS_RESULT',
    'RELEASE_NOTES_RESULT',
] as const;

const e2eResultVariables = ['CHANGES_RESULT', 'DESKTOP_E2E_RESULT'] as const;

const ciRequiredJobs = [
    { name: 'changes', variable: 'CHANGES_RESULT', label: 'change detection' },
    {
        name: 'conventional-commits',
        variable: 'CONVENTIONAL_COMMITS_RESULT',
        label: 'Conventional Commits',
    },
    {
        name: 'dependency-review',
        variable: 'DEPENDENCY_REVIEW_RESULT',
        label: 'Dependency Review',
    },
    {
        name: 'workflow-lint',
        variable: 'WORKFLOW_LINT_RESULT',
        label: 'workflow validation',
    },
    {
        name: 'release-notes-check',
        variable: 'RELEASE_NOTES_RESULT',
        label: 'release notes validation',
    },
    {
        name: 'frontend-quality',
        variable: 'FRONTEND_QUALITY_RESULT',
        label: 'frontend quality',
    },
    {
        name: 'frontend-tests',
        variable: 'FRONTEND_TESTS_RESULT',
        label: 'frontend coverage',
    },
    { name: 'ci-tests', variable: 'CI_TESTS_RESULT', label: 'CI contract tests' },
    { name: 'site-build', variable: 'SITE_BUILD_RESULT', label: 'site build' },
    { name: 'rust-checks', variable: 'RUST_CHECKS_RESULT', label: 'Rust checks' },
] as const;

const ciObservedJobs = [
    {
        name: 'workflow-lint',
        variable: 'WORKFLOW_LINT_RESULT',
        label: 'workflow validation',
    },
    {
        name: 'conventional-commits',
        variable: 'CONVENTIONAL_COMMITS_RESULT',
        label: 'Conventional Commits',
    },
    {
        name: 'dependency-review',
        variable: 'DEPENDENCY_REVIEW_RESULT',
        label: 'Dependency Review',
    },
    {
        name: 'release-notes-check',
        variable: 'RELEASE_NOTES_RESULT',
        label: 'release notes validation',
    },
    {
        name: 'frontend-quality',
        variable: 'FRONTEND_QUALITY_RESULT',
        label: 'frontend quality',
    },
    {
        name: 'frontend-tests',
        variable: 'FRONTEND_TESTS_RESULT',
        label: 'frontend coverage',
    },
    { name: 'ci-tests', variable: 'CI_TESTS_RESULT', label: 'CI contract tests' },
    { name: 'site-build', variable: 'SITE_BUILD_RESULT', label: 'site build' },
    { name: 'rust-checks', variable: 'RUST_CHECKS_RESULT', label: 'Rust checks' },
    {
        name: 'build-windows',
        variable: 'BUILD_WINDOWS_RESULT',
        label: 'Windows build',
    },
] as const;

let cachedBash: string | undefined;

function gitBashExecutable() {
    if (process.platform !== 'win32') {
        return 'bash';
    }

    if (cachedBash) {
        return cachedBash;
    }

    const override = process.env.GIT_BASH_PATH;

    if (override) {
        if (!existsSync(override)) {
            throw new Error(`GIT_BASH_PATH does not point to an existing file: ${override}`);
        }

        cachedBash = override;
        return cachedBash;
    }

    const gitExecPath = spawnSync('git', ['--exec-path'], {
        encoding: 'utf8',
        env: process.env,
        windowsHide: true,
    });

    if (gitExecPath.error || gitExecPath.status !== 0) {
        const detail = gitExecPath.error?.message ?? gitExecPath.stderr.trim();
        throw new Error(`Unable to locate Git for Windows for required-gate tests: ${detail}`);
    }

    const execPath = gitExecPath.stdout.trim();
    const gitRoot = resolve(execPath, '../../..');
    const candidates = [resolve(gitRoot, 'bin/bash.exe'), resolve(gitRoot, 'usr/bin/bash.exe')];
    const bash = candidates.find((candidate) => existsSync(candidate));

    if (!bash) {
        throw new Error(
            `Unable to locate Git for Windows bash for required-gate tests. git --exec-path returned ${execPath}; checked ${candidates.join(', ')}.`
        );
    }

    cachedBash = bash;
    return bash;
}

function requiredGateScript(filename: string, jobId: string, stepName: string) {
    const job = readWorkflow(filename).jobs[jobId] as WorkflowJob | undefined;
    const step = job?.steps.find((candidate) => candidate.name === stepName);

    if (typeof step?.run !== 'string') {
        throw new Error(`${filename} ${jobId} does not define the ${stepName} bash script.`);
    }

    return step.run;
}

function shellEnvironment(environment: GateEnvironment) {
    const inherited = [
        'HOME',
        'PATH',
        'PATHEXT',
        'SYSTEMROOT',
        'SystemRoot',
        'TEMP',
        'TMP',
        'USERPROFILE',
        'WINDIR',
    ].reduce<Record<string, string>>((result, key) => {
        const value = process.env[key];

        if (value !== undefined) {
            result[key] = value;
        }

        return result;
    }, {});
    const declared = Object.fromEntries(
        Object.entries(environment).filter(
            (entry): entry is [string, string] => entry[1] !== undefined
        )
    );

    return {
        ...inherited,
        ...declared,
        LC_ALL: 'C',
    };
}

function runRequiredGate(
    filename: string,
    jobId: string,
    stepName: string,
    environment: GateEnvironment
) {
    const result = spawnSync(
        gitBashExecutable(),
        ['--noprofile', '--norc', '-c', requiredGateScript(filename, jobId, stepName)],
        {
            cwd: repositoryRoot,
            encoding: 'utf8',
            env: shellEnvironment(environment),
            timeout: 10_000,
            windowsHide: true,
        }
    );

    if (result.error) {
        throw result.error;
    }

    return {
        status: result.status,
        output: `${result.stdout}${result.stderr}`,
    } satisfies GateResult;
}

function completeEnvironment(
    defaults: GateEnvironment,
    overrides: GateEnvironment = {}
): GateEnvironment {
    const result = { ...defaults, ...overrides };

    for (const [key, value] of Object.entries(result)) {
        if (value === undefined) {
            delete result[key];
        }
    }

    return result;
}

function ciEnvironment(overrides: GateEnvironment = {}) {
    return completeEnvironment(
        {
            EVENT_NAME: 'pull_request',
            DOCS_ONLY: 'false',
            DESKTOP_CHANGED: 'false',
            SITE_CHANGED: 'false',
            RELEASE_NOTES_CHANGED: 'false',
            ...Object.fromEntries(ciResultVariables.map((variable) => [variable, 'skipped'])),
        },
        overrides
    );
}

function e2eEnvironment(overrides: GateEnvironment = {}) {
    return completeEnvironment(
        {
            DOCS_ONLY: 'false',
            DESKTOP_CHANGED: 'false',
            ...Object.fromEntries(e2eResultVariables.map((variable) => [variable, 'skipped'])),
        },
        overrides
    );
}

function ciAllApplicableSuccess(overrides: GateEnvironment = {}) {
    return ciEnvironment({
        DOCS_ONLY: 'false',
        DESKTOP_CHANGED: 'true',
        SITE_CHANGED: 'true',
        RELEASE_NOTES_CHANGED: 'true',
        CHANGES_RESULT: 'success',
        WORKFLOW_LINT_RESULT: 'success',
        CONVENTIONAL_COMMITS_RESULT: 'success',
        DEPENDENCY_REVIEW_RESULT: 'success',
        FRONTEND_QUALITY_RESULT: 'success',
        FRONTEND_TESTS_RESULT: 'success',
        CI_TESTS_RESULT: 'success',
        SITE_BUILD_RESULT: 'success',
        RUST_CHECKS_RESULT: 'success',
        BUILD_WINDOWS_RESULT: 'skipped',
        RELEASE_NOTES_RESULT: 'success',
        ...overrides,
    });
}

function runCi(environment: GateEnvironment) {
    return runRequiredGate('ci.yml', 'ci-required', 'Verify required CI jobs', environment);
}

function runE2e(environment: GateEnvironment) {
    return runRequiredGate(
        'e2e-smoke.yml',
        'e2e-required',
        'Verify required E2E jobs',
        environment
    );
}

function expectGateFailure(result: GateResult, fragments: string[]) {
    expect(result.status).toBe(1);

    for (const fragment of fragments) {
        expect(result.output).toContain(fragment);
    }
}

describe('user completes required CI validation', () => {
    it('user sees a docs-only pull request skip heavyweight work while retaining PR review gates', () => {
        const result = runCi(
            ciEnvironment({
                DOCS_ONLY: 'true',
                DESKTOP_CHANGED: 'false',
                SITE_CHANGED: 'false',
                CHANGES_RESULT: 'success',
                CONVENTIONAL_COMMITS_RESULT: 'success',
                DEPENDENCY_REVIEW_RESULT: 'success',
            })
        );

        expect(result.status).toBe(0);
        expect(result.output).not.toContain('One or more required CI jobs did not pass.');
    });

    it('user sees a release-notes-only pull request require its lightweight validator', () => {
        const result = runCi(
            ciEnvironment({
                DOCS_ONLY: 'true',
                DESKTOP_CHANGED: 'false',
                SITE_CHANGED: 'false',
                RELEASE_NOTES_CHANGED: 'true',
                CHANGES_RESULT: 'success',
                CONVENTIONAL_COMMITS_RESULT: 'success',
                RELEASE_NOTES_RESULT: 'success',
            })
        );

        expect(result.status).toBe(0);
        expect(result.output).toContain('release-notes-check -> success');
    });

    it('user sees a release-notes-only pull request fail when its validator is skipped', () => {
        const result = runCi(
            ciEnvironment({
                DOCS_ONLY: 'true',
                DESKTOP_CHANGED: 'false',
                SITE_CHANGED: 'false',
                RELEASE_NOTES_CHANGED: 'true',
                CHANGES_RESULT: 'success',
                CONVENTIONAL_COMMITS_RESULT: 'success',
                RELEASE_NOTES_RESULT: 'skipped',
            })
        );

        expectGateFailure(result, [
            'release-notes-check -> skipped',
            'One or more required CI jobs did not pass.',
        ]);
    });

    it('user sees site-only work require repository checks and the site build without desktop validation', () => {
        const result = runCi(
            ciEnvironment({
                EVENT_NAME: 'push',
                DOCS_ONLY: 'false',
                DESKTOP_CHANGED: 'false',
                SITE_CHANGED: 'true',
                CHANGES_RESULT: 'success',
                WORKFLOW_LINT_RESULT: 'success',
                CI_TESTS_RESULT: 'success',
                SITE_BUILD_RESULT: 'success',
            })
        );

        expect(result.status).toBe(0);
    });

    it('user sees every applicable CI job pass for a full pull request', () => {
        const result = runCi(ciAllApplicableSuccess());

        expect(result.status).toBe(0);
        expect(result.output).toContain('rust-checks -> success');
        expect(result.output).toContain('site-build -> success');
    });

    it('user sees push runs ignore PR-only checks but require the main Windows build after desktop changes', () => {
        const result = runCi(
            ciEnvironment({
                EVENT_NAME: 'push',
                DOCS_ONLY: 'false',
                DESKTOP_CHANGED: 'true',
                SITE_CHANGED: 'false',
                CHANGES_RESULT: 'success',
                WORKFLOW_LINT_RESULT: 'success',
                CI_TESTS_RESULT: 'success',
                FRONTEND_QUALITY_RESULT: 'success',
                FRONTEND_TESTS_RESULT: 'success',
                RUST_CHECKS_RESULT: 'success',
                BUILD_WINDOWS_RESULT: 'success',
            })
        );

        expect(result.status).toBe(0);
        expect(result.output).toContain('build-windows -> success');
        expect(result.output).not.toContain('conventional-commits -> success');
        expect(result.output).not.toContain('dependency-review -> success');
    });

    it('user sees a Windows build skipped on a main desktop push fail the required CI gate', () => {
        const result = runCi(
            ciEnvironment({
                EVENT_NAME: 'push',
                DOCS_ONLY: 'false',
                DESKTOP_CHANGED: 'true',
                SITE_CHANGED: 'false',
                CHANGES_RESULT: 'success',
                WORKFLOW_LINT_RESULT: 'success',
                CI_TESTS_RESULT: 'success',
                FRONTEND_QUALITY_RESULT: 'success',
                FRONTEND_TESTS_RESULT: 'success',
                RUST_CHECKS_RESULT: 'success',
                BUILD_WINDOWS_RESULT: 'skipped',
            })
        );

        expectGateFailure(result, [
            'build-windows -> skipped',
            'One or more required CI jobs did not pass.',
        ]);
    });
});

describe('user cannot hide a failed or cancelled CI job behind routing', () => {
    const statuses = [
        { status: 'skipped', result: 'skipped', outcome: 'is skipped' },
        { status: 'failed', result: 'failure', outcome: 'is marked failed' },
        { status: 'cancelled', result: 'cancelled', outcome: 'is cancelled' },
        { status: 'missing', result: undefined, outcome: 'is missing' },
    ] as const;

    for (const job of ciRequiredJobs) {
        it.each(
            statuses.map((status) => ({
                ...status,
                jobLabel: job.label,
                variable: job.variable,
            }))
        )(
            'user sees a full pull request fail when the required $jobLabel check $outcome',
            ({ result, variable }) => {
                const gate = runCi(ciAllApplicableSuccess({ [variable]: result }));

                expectGateFailure(gate, [
                    `${job.name} -> ${result ?? ''}`,
                    'One or more required CI jobs did not pass.',
                ]);
            }
        );
    }

    it.each(statuses)(
        'user sees a desktop-changing main push fail when the required Windows build check $outcome',
        ({ result }) => {
            const gate = runCi(
                ciEnvironment({
                    EVENT_NAME: 'push',
                    DOCS_ONLY: 'false',
                    DESKTOP_CHANGED: 'true',
                    SITE_CHANGED: 'false',
                    CHANGES_RESULT: 'success',
                    WORKFLOW_LINT_RESULT: 'success',
                    CI_TESTS_RESULT: 'success',
                    FRONTEND_QUALITY_RESULT: 'success',
                    FRONTEND_TESTS_RESULT: 'success',
                    RUST_CHECKS_RESULT: 'success',
                    BUILD_WINDOWS_RESULT: result,
                })
            );

            expectGateFailure(gate, [
                `build-windows -> ${result ?? ''}`,
                'One or more required CI jobs did not pass.',
            ]);
        }
    );

    for (const job of ciObservedJobs) {
        it.each(
            (['failure', 'cancelled'] as const).map((result) => ({
                result,
                outcome: result === 'failure' ? 'failed' : 'cancelled',
                jobLabel: job.label,
                variable: job.variable,
            }))
        )(
            'user sees a docs-only push fail when $jobLabel unexpectedly $outcome',
            ({ result, variable }) => {
                const gate = runCi(
                    ciEnvironment({
                        EVENT_NAME: 'push',
                        DOCS_ONLY: 'true',
                        DESKTOP_CHANGED: 'false',
                        SITE_CHANGED: 'false',
                        CHANGES_RESULT: 'success',
                        [variable]: result,
                    })
                );

                expectGateFailure(gate, [
                    `${job.name} unexpectedly ended with ${result}.`,
                    'One or more required CI jobs did not pass.',
                ]);
            }
        );
    }
});

describe('user completes required E2E validation', () => {
    it('user sees docs-only work skip Windows E2E while the final gate reports success', () => {
        const result = runE2e(
            e2eEnvironment({
                DOCS_ONLY: 'true',
                DESKTOP_CHANGED: 'false',
                CHANGES_RESULT: 'success',
                DESKTOP_E2E_RESULT: 'skipped',
            })
        );

        expect(result.status).toBe(0);
    });

    it('user sees unrelated site-only work skip Windows E2E while the final gate reports success', () => {
        const result = runE2e(
            e2eEnvironment({
                DOCS_ONLY: 'false',
                DESKTOP_CHANGED: 'false',
                CHANGES_RESULT: 'success',
                DESKTOP_E2E_RESULT: 'skipped',
            })
        );

        expect(result.status).toBe(0);
    });

    it('user sees a desktop change require and pass Windows E2E', () => {
        const result = runE2e(
            e2eEnvironment({
                DOCS_ONLY: 'false',
                DESKTOP_CHANGED: 'true',
                CHANGES_RESULT: 'success',
                DESKTOP_E2E_RESULT: 'success',
            })
        );

        expect(result.status).toBe(0);
        expect(result.output).toContain('desktop-e2e-smoke-windows -> success');
    });

    const e2eRequiredJobs = [
        { name: 'changes', variable: 'CHANGES_RESULT', label: 'change detection' },
        {
            name: 'desktop-e2e-smoke-windows',
            variable: 'DESKTOP_E2E_RESULT',
            label: 'Windows E2E smoke',
        },
    ] as const;
    const statuses = [
        { status: 'skipped', result: 'skipped', outcome: 'is skipped' },
        { status: 'failed', result: 'failure', outcome: 'is marked failed' },
        { status: 'cancelled', result: 'cancelled', outcome: 'is cancelled' },
        { status: 'missing', result: undefined, outcome: 'is missing' },
    ] as const;

    for (const job of e2eRequiredJobs) {
        it.each(
            statuses.map((status) => ({
                ...status,
                jobLabel: job.label,
                variable: job.variable,
            }))
        )(
            'user sees desktop work fail when the required $jobLabel check $outcome',
            ({ result, variable }) => {
                const gate = runE2e(
                    e2eEnvironment({
                        DOCS_ONLY: 'false',
                        DESKTOP_CHANGED: 'true',
                        CHANGES_RESULT: 'success',
                        DESKTOP_E2E_RESULT: 'success',
                        [variable]: result,
                    })
                );

                expectGateFailure(gate, [
                    `${job.name} -> ${result ?? ''}`,
                    'One or more required E2E jobs did not pass.',
                ]);
            }
        );
    }

    it.each([
        { result: 'failure' as const, outcome: 'failed' },
        { result: 'cancelled' as const, outcome: 'cancelled' },
    ])('user sees a docs-only push fail when Windows E2E unexpectedly $outcome', ({ result }) => {
        const gate = runE2e(
            e2eEnvironment({
                DOCS_ONLY: 'true',
                DESKTOP_CHANGED: 'false',
                CHANGES_RESULT: 'success',
                DESKTOP_E2E_RESULT: result,
            })
        );

        expectGateFailure(gate, [
            `desktop-e2e-smoke-windows unexpectedly ended with ${result}.`,
            'One or more required E2E jobs did not pass.',
        ]);
    });
});

describe('user cannot bypass required gates with malformed change classification', () => {
    it.each([
        {
            output: 'docs_only',
            value: undefined,
            state: 'missing',
            classification: 'documentation classification',
        },
        {
            output: 'docs_only',
            value: 'invalid',
            state: 'invalid',
            classification: 'documentation classification',
        },
        {
            output: 'desktop_changed',
            value: undefined,
            state: 'missing',
            classification: 'desktop classification',
        },
        {
            output: 'desktop_changed',
            value: 'invalid',
            state: 'invalid',
            classification: 'desktop classification',
        },
        {
            output: 'site_changed',
            value: undefined,
            state: 'missing',
            classification: 'site classification',
        },
        {
            output: 'site_changed',
            value: 'invalid',
            state: 'invalid',
            classification: 'site classification',
        },
        {
            output: 'release_notes_changed',
            value: undefined,
            state: 'missing',
            classification: 'release notes classification',
        },
        {
            output: 'release_notes_changed',
            value: 'invalid',
            state: 'invalid',
            classification: 'release notes classification',
        },
    ])(
        'user sees CI fail when the $state $classification is not true or false',
        ({ output, value }) => {
            const environment = ciAllApplicableSuccess();
            const variable = output.toUpperCase();
            environment[variable] = value;
            const result = runCi(environment);

            expectGateFailure(result, [
                `Invalid changes output ${output}`,
                "expected 'true' or 'false'",
            ]);
        }
    );

    it.each([
        {
            output: 'docs_only',
            value: undefined,
            state: 'missing',
            classification: 'documentation classification',
        },
        {
            output: 'docs_only',
            value: 'yes',
            state: 'invalid',
            classification: 'documentation classification',
        },
        {
            output: 'desktop_changed',
            value: undefined,
            state: 'missing',
            classification: 'desktop classification',
        },
        {
            output: 'desktop_changed',
            value: 'yes',
            state: 'invalid',
            classification: 'desktop classification',
        },
    ])(
        'user sees E2E fail when the $state $classification is not true or false',
        ({ output, value }) => {
            const environment = e2eEnvironment({
                DOCS_ONLY: 'false',
                DESKTOP_CHANGED: 'true',
                CHANGES_RESULT: 'success',
                DESKTOP_E2E_RESULT: 'success',
            });
            environment[output.toUpperCase()] = value;
            const result = runE2e(environment);

            expectGateFailure(result, [
                `Invalid changes output ${output}`,
                "expected 'true' or 'false'",
            ]);
        }
    );
});
