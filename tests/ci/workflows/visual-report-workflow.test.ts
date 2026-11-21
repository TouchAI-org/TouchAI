import { describe, expect, it } from 'vitest';

import { readWorkflow, type WorkflowJob } from './workflow-test-helpers';

const REPORT_STEP = 'Post the report on the pull request';

/**
 * GitHub ANDs an implicit `success()` into an `if` that names no status function, so a
 * step guarded only by an output check is skipped after the comparison step fails —
 * which is the one run whose report a reviewer needs.
 */
function expectReportRunsAfterFailure(workflowFile: string, jobId: string) {
    const job = readWorkflow(workflowFile).jobs[jobId] as WorkflowJob;

    expect(job).toBeDefined();

    const reportSteps = job.steps.filter((step) => step.name === REPORT_STEP);

    expect(reportSteps).toHaveLength(1);
    expect(reportSteps[0]?.if).toBe("${{ !cancelled() && steps.app.outputs.token != '' }}");
}

describe('user reads the visual report after a failed comparison', () => {
    it('user still gets the app layer report when an E2E baseline differs', () => {
        expectReportRunsAfterFailure('e2e-smoke.yml', 'desktop-e2e-smoke-windows');
    });

    it('user still gets the component layer report when a component baseline differs', () => {
        expectReportRunsAfterFailure('visual-components.yml', 'component-visual');
    });
});
