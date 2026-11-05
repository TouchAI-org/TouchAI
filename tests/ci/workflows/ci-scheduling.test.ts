import { truthy } from '@actions/expressions/result';
import { describe, expect, it } from 'vitest';

import {
    evaluateExpression,
    interpolate,
    readWorkflow,
    type Workflow,
    type WorkflowJob,
} from './workflow-test-helpers';

interface OrdinaryWorkflow {
    filename: string;
    workflowName: string;
}

interface TriggerCase {
    filename: string;
    workflowName: string;
    eventName: string;
    mergeGroupHeadSha?: string;
}

interface WindowsSelectionCase {
    expectation: 'selected' | 'skipped';
    scenario: string;
    eventName: string;
    ref: string;
    docsOnly: string;
    desktopChanged: string;
}

const ordinaryWorkflows: OrdinaryWorkflow[] = [
    {
        filename: 'ci.yml',
        workflowName: 'CI',
    },
    {
        filename: 'security.yml',
        workflowName: 'Security',
    },
    {
        filename: 'e2e-smoke.yml',
        workflowName: 'Desktop E2E Smoke',
    },
    {
        filename: 'visual-components.yml',
        workflowName: 'Component Visual Tests',
    },
];

const nonPullRequestTriggerCases: TriggerCase[] = [
    ...ordinaryWorkflows.map(({ filename, workflowName }) => ({
        filename,
        workflowName,
        eventName: 'push',
    })),
    {
        filename: 'ci.yml',
        workflowName: 'CI',
        eventName: 'merge_group',
        mergeGroupHeadSha: 'merge-group-head',
    },
    {
        filename: 'e2e-smoke.yml',
        workflowName: 'Desktop E2E Smoke',
        eventName: 'merge_group',
        mergeGroupHeadSha: 'merge-group-head',
    },
    {
        filename: 'visual-components.yml',
        workflowName: 'Component Visual Tests',
        eventName: 'merge_group',
        mergeGroupHeadSha: 'merge-group-head',
    },
    {
        filename: 'security.yml',
        workflowName: 'Security',
        eventName: 'workflow_dispatch',
    },
    {
        filename: 'e2e-smoke.yml',
        workflowName: 'Desktop E2E Smoke',
        eventName: 'workflow_dispatch',
    },
    {
        filename: 'visual-components.yml',
        workflowName: 'Component Visual Tests',
        eventName: 'workflow_dispatch',
    },
    {
        filename: 'security.yml',
        workflowName: 'Security',
        eventName: 'schedule',
    },
];

const windowsSelectionCases: WindowsSelectionCase[] = [
    {
        expectation: 'selected',
        scenario: 'a desktop-changing main push is not docs-only',
        eventName: 'push',
        ref: 'refs/heads/main',
        docsOnly: 'false',
        desktopChanged: 'true',
    },
    {
        expectation: 'skipped',
        scenario: 'the event is a pull request',
        eventName: 'pull_request',
        ref: 'refs/pull/42/merge',
        docsOnly: 'false',
        desktopChanged: 'true',
    },
    {
        expectation: 'skipped',
        scenario: 'the push is not on main',
        eventName: 'push',
        ref: 'refs/heads/feature',
        docsOnly: 'false',
        desktopChanged: 'true',
    },
    {
        expectation: 'skipped',
        scenario: 'the main push is docs-only',
        eventName: 'push',
        ref: 'refs/heads/main',
        docsOnly: 'true',
        desktopChanged: 'true',
    },
    {
        expectation: 'skipped',
        scenario: 'non-desktop files changed',
        eventName: 'push',
        ref: 'refs/heads/main',
        docsOnly: 'false',
        desktopChanged: 'false',
    },
];

function concurrencyContext(
    workflow: Workflow,
    options: {
        eventName: string;
        runId: string;
        pullRequestNumber?: number;
        mergeGroupHeadSha?: string;
        ref?: string;
    }
) {
    const event: Record<string, unknown> = {};

    if (options.pullRequestNumber !== undefined) {
        event.pull_request = { number: options.pullRequestNumber };
    }

    if (options.mergeGroupHeadSha !== undefined) {
        event.merge_group = { head_sha: options.mergeGroupHeadSha };
    }

    return {
        github: {
            workflow: workflow.name,
            event_name: options.eventName,
            run_id: options.runId,
            ref: options.ref ?? 'refs/heads/main',
            event,
        },
    };
}

function concurrencyGroup(workflow: Workflow, context: Record<string, unknown>) {
    return interpolate(workflow.concurrency.group, context);
}

function cancellationEnabled(workflow: Workflow, context: Record<string, unknown>) {
    return (
        evaluateExpression(
            String(workflow.concurrency['cancel-in-progress']),
            context
        ).coerceString() === 'true'
    );
}

function normalizeNeeds(job: WorkflowJob) {
    if (job.needs === undefined) {
        return [];
    }

    return Array.isArray(job.needs) ? job.needs : [job.needs];
}

function workflowJob(workflow: Workflow, jobId: string) {
    const job = workflow.jobs[jobId];

    if (job === undefined) {
        throw new Error(`Workflow job ${jobId} is missing.`);
    }

    return job;
}

function workflowCondition(source: string | undefined, context: Record<string, unknown>) {
    if (typeof source !== 'string') {
        throw new Error('Workflow condition is missing.');
    }

    return truthy(evaluateExpression(source, context));
}

describe('user updates or starts required workflow runs', () => {
    it.each(ordinaryWorkflows)(
        'user sees newer $workflowName pull request runs share a group and cancel older runs when the pull request is updated',
        ({ filename }) => {
            const workflow = readWorkflow(filename);
            const older = concurrencyContext(workflow, {
                eventName: 'pull_request',
                pullRequestNumber: 726,
                runId: '1001',
            });
            const newer = concurrencyContext(workflow, {
                eventName: 'pull_request',
                pullRequestNumber: 726,
                runId: '1002',
            });

            expect(concurrencyGroup(workflow, newer)).toBe(concurrencyGroup(workflow, older));
            expect(cancellationEnabled(workflow, older)).toBe(true);
            expect(cancellationEnabled(workflow, newer)).toBe(true);
        }
    );

    it.each(ordinaryWorkflows)(
        'user sees different pull requests remain independent when $workflowName runs for both',
        ({ filename }) => {
            const workflow = readWorkflow(filename);
            const first = concurrencyContext(workflow, {
                eventName: 'pull_request',
                pullRequestNumber: 726,
                runId: '1001',
            });
            const second = concurrencyContext(workflow, {
                eventName: 'pull_request',
                pullRequestNumber: 727,
                runId: '1002',
            });

            expect(concurrencyGroup(workflow, first)).not.toBe(concurrencyGroup(workflow, second));
        }
    );

    it('user sees differently named workflows remain independent when they run for the same pull request', () => {
        const groups = ordinaryWorkflows.map(({ filename }) => {
            const workflow = readWorkflow(filename);
            const context = concurrencyContext(workflow, {
                eventName: 'pull_request',
                pullRequestNumber: 726,
                runId: '1001',
            });

            return concurrencyGroup(workflow, context);
        });

        expect(new Set(groups).size).toBe(ordinaryWorkflows.length);
    });

    it.each(nonPullRequestTriggerCases)(
        'user sees separate $eventName runs remain independent without cancellation when they share a ref for $workflowName',
        ({ filename, eventName, mergeGroupHeadSha }) => {
            const workflow = readWorkflow(filename);

            expect(Object.keys(workflow.on)).toContain(eventName);

            const first = concurrencyContext(workflow, {
                eventName,
                mergeGroupHeadSha,
                runId: '2001',
            });
            const second = concurrencyContext(workflow, {
                eventName,
                mergeGroupHeadSha,
                runId: '2002',
            });

            expect
                .soft(concurrencyGroup(workflow, first))
                .not.toBe(concurrencyGroup(workflow, second));
            expect(cancellationEnabled(workflow, first)).toBe(false);
            expect(cancellationEnabled(workflow, second)).toBe(false);
        }
    );

    it('user sees unsupported triggers remain undeclared when an ordinary workflow is inspected', () => {
        const unsupportedTriggers = [
            { filename: 'ci.yml', eventName: 'workflow_dispatch' },
            { filename: 'ci.yml', eventName: 'schedule' },
            { filename: 'security.yml', eventName: 'merge_group' },
            { filename: 'e2e-smoke.yml', eventName: 'schedule' },
            { filename: 'visual-components.yml', eventName: 'schedule' },
        ];

        for (const { filename, eventName } of unsupportedTriggers) {
            expect(Object.keys(readWorkflow(filename).on)).not.toContain(eventName);
        }
    });
});

describe('user waits for the Windows desktop build', () => {
    it('user sees the Windows build wait only for change classification when selecting its dependencies', () => {
        const workflow = readWorkflow('ci.yml');

        expect(normalizeNeeds(workflowJob(workflow, 'build-windows'))).toEqual(['changes']);
    });

    it.each(windowsSelectionCases)(
        'user sees the Windows build $expectation when $scenario',
        ({ eventName, ref, docsOnly, desktopChanged, expectation }) => {
            const workflow = readWorkflow('ci.yml');
            const context = {
                github: {
                    event_name: eventName,
                    ref,
                },
                needs: {
                    changes: {
                        outputs: {
                            docs_only: docsOnly,
                            desktop_changed: desktopChanged,
                        },
                    },
                },
            };

            expect(workflowCondition(workflowJob(workflow, 'build-windows').if, context)).toBe(
                expectation === 'selected'
            );
        }
    );

    it('user receives the same Windows installer packaging behavior when the Windows build completes', () => {
        const workflow = readWorkflow('ci.yml');
        const steps = workflowJob(workflow, 'build-windows').steps;
        const tauriBuild = steps.find((step) => step.uses?.startsWith('tauri-apps/tauri-action@'));
        const installerUpload = steps.find((step) => step.name === 'Upload Windows installer');

        expect(tauriBuild?.with?.projectPath).toBe('apps/desktop');
        expect(installerUpload?.with?.path).toBe(
            'apps/desktop/src-tauri/target/release/bundle/msi/*.msi'
        );
        expect(steps.some((step) => step.uses?.startsWith('actions/download-artifact@'))).toBe(
            false
        );
    });
});

describe('user evaluates job conditions with GitHub Actions truthiness', () => {
    it('user sees a nonempty textual false output select work when the job condition is evaluated', () => {
        const context = {
            needs: {
                changes: {
                    outputs: {
                        desktop_changed: 'false',
                    },
                },
            },
        };

        expect(workflowCondition('needs.changes.outputs.desktop_changed', context)).toBe(true);
    });

    it('user sees boolean false, empty, and zero outputs skip work when job conditions are evaluated', () => {
        expect(workflowCondition('false', {})).toBe(false);
        expect(
            workflowCondition('needs.changes.outputs.empty', {
                needs: { changes: { outputs: { empty: '' } } },
            })
        ).toBe(false);
        expect(
            workflowCondition('needs.changes.outputs.zero', {
                needs: { changes: { outputs: { zero: 0 } } },
            })
        ).toBe(false);
    });
});

describe('user relies on required workflow reporting', () => {
    it('user sees the final CI gate wait for every CI job when required jobs finish', () => {
        const workflow = readWorkflow('ci.yml');
        const required = workflowJob(workflow, 'ci-required');

        expect([...normalizeNeeds(required)].sort()).toEqual(
            [
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
            ].sort()
        );
        expect(required.if).toBe('always()');
    });

    it('user sees the final E2E gate wait for its jobs and always report when they finish', () => {
        const workflow = readWorkflow('e2e-smoke.yml');
        const required = workflowJob(workflow, 'e2e-required');

        expect([...normalizeNeeds(required)].sort()).toEqual(
            ['changes', 'desktop-e2e-smoke-windows'].sort()
        );
        expect(required.if).toBe('always()');
    });

    it('user sees all four required check contexts remain published when required workflows complete', () => {
        const ci = readWorkflow('ci.yml');
        const e2e = readWorkflow('e2e-smoke.yml');

        expect(workflowJob(ci, 'conventional-commits').name).toBe('Conventional Commits');
        expect(workflowJob(ci, 'dependency-review').name).toBe('Dependency Review');
        expect(workflowJob(ci, 'ci-required').name).toBe('CI Required');
        expect(workflowJob(e2e, 'e2e-required').name).toBe('E2E Required');
    });
});

describe('user starts required workflows for pull requests', () => {
    it.each(ordinaryWorkflows)(
        'user sees $workflowName required checks start without path filters when a pull request opens',
        ({ filename }) => {
            const workflow = readWorkflow(filename);
            const events = Object.entries(workflow.on);

            expect(workflow.on).toHaveProperty('pull_request');
            expect(events.length).toBeGreaterThan(0);

            for (const [, configuration] of events) {
                if (
                    configuration !== null &&
                    typeof configuration === 'object' &&
                    !Array.isArray(configuration)
                ) {
                    expect(configuration).not.toHaveProperty('paths');
                    expect(configuration).not.toHaveProperty('paths-ignore');
                }
            }
        }
    );
});
