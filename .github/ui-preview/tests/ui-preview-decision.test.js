import { describe, expect, it } from 'vitest';

import {
    APPROVED_LABEL,
    decide,
    DECISION,
    FORCE_LABEL,
    isPreviewCommand,
} from '../lib/decision.mjs';

const base = {
    eventName: 'pull_request_target',
    action: 'opened',
    labels: [],
    draft: false,
    maintainer: false,
    hasUiChange: true,
    isPullRequestComment: false,
    commentBody: '',
    commentAuthorMaintainer: false,
    manualForce: false,
};

describe('user opens a pull request that changes the interface', () => {
    it('user gets a preview when a maintainer wrote it', () => {
        const result = decide({ ...base, maintainer: true });

        expect(result.decision).toBe(DECISION.run);
    });

    it('user sees a waiting comment when an outside contributor wrote it', () => {
        const result = decide(base);

        expect(result.decision).toBe(DECISION.awaitingApproval);
    });

    it('user gets no preview when no interface file changed', () => {
        const result = decide({ ...base, maintainer: true, hasUiChange: false });

        expect(result.decision).toBe(DECISION.none);
    });

    it('user gets no preview while the pull request is a draft', () => {
        const result = decide({ ...base, maintainer: true, draft: true });

        expect(result.decision).toBe(DECISION.none);
    });

    it('user gets a preview once the draft becomes ready for review', () => {
        const result = decide({
            ...base,
            maintainer: true,
            draft: true,
            action: 'ready_for_review',
        });

        expect(result.decision).toBe(DECISION.run);
    });
});

describe('user works with an approval label', () => {
    it('user gets a preview on a later commit after approval', () => {
        const result = decide({
            ...base,
            action: 'synchronize',
            labels: ['status:ui-preview-approved'],
        });

        expect(result.decision).toBe(DECISION.run);
    });

    it('user gets a preview when a maintainer forces it with the ui-preview label', () => {
        const result = decide({ ...base, labels: ['ui-preview'], hasUiChange: false });

        expect(result.decision).toBe(DECISION.run);
    });

    it('user gets a preview on a draft when a maintainer forces it', () => {
        const result = decide({ ...base, labels: ['ui-preview'], draft: true });

        expect(result.decision).toBe(DECISION.run);
    });

    it('user gets no preview when the skip label is set, even with approval', () => {
        const result = decide({
            ...base,
            maintainer: true,
            labels: ['status:ui-preview-approved', 'status:ui-preview-skip'],
        });

        expect(result.decision).toBe(DECISION.skipped);
    });

    it('user gets one run when the command path writes the approval label', () => {
        const result = decide({
            ...base,
            action: 'labeled',
            actor: 'touchai-ui-preview[bot]',
            labelName: 'status:ui-preview-approved',
            labels: ['status:ui-preview-approved'],
        });

        expect(result.decision).toBe(DECISION.none);
    });

    it('user gets a preview when a maintainer adds the approval label', () => {
        const result = decide({
            ...base,
            action: 'labeled',
            actor: 'hiqiancheng',
            labelName: APPROVED_LABEL,
            labels: [APPROVED_LABEL],
            labelActorMaintainer: true,
        });

        expect(result.decision).toBe(DECISION.run);
    });

    it('user waits when an outside collaborator adds the approval label', () => {
        const result = decide({
            ...base,
            action: 'labeled',
            actor: 'triage-user',
            labelName: APPROVED_LABEL,
            labels: [APPROVED_LABEL],
            labelActorMaintainer: false,
        });

        expect(result.decision).toBe(DECISION.awaitingApproval);
    });

    it('user waits when an outside collaborator adds the force label', () => {
        const result = decide({
            ...base,
            action: 'labeled',
            actor: 'triage-user',
            labelName: FORCE_LABEL,
            labels: [FORCE_LABEL],
            labelActorMaintainer: false,
        });

        expect(result.decision).toBe(DECISION.awaitingApproval);
    });
});

describe('user comments a command on a pull request', () => {
    it('user gets a preview when a maintainer comments the command', () => {
        const result = decide({
            ...base,
            eventName: 'issue_comment',
            isPullRequestComment: true,
            commentBody: '/ui-preview',
            commentAuthorMaintainer: true,
        });

        expect(result.decision).toBe(DECISION.run);
        expect(result.addApprovedLabel).toBe(true);
    });

    it('user gets no preview when an outside contributor comments the command', () => {
        const result = decide({
            ...base,
            eventName: 'issue_comment',
            isPullRequestComment: true,
            commentBody: '/ui-preview',
            commentAuthorMaintainer: false,
        });

        expect(result.decision).toBe(DECISION.none);
    });

    it('user gets no preview for a command on a plain issue', () => {
        const result = decide({
            ...base,
            eventName: 'issue_comment',
            isPullRequestComment: false,
            commentBody: '/ui-preview',
            commentAuthorMaintainer: true,
        });

        expect(result.decision).toBe(DECISION.none);
    });

    it('user gets no preview for a comment that only mentions the command', () => {
        const result = decide({
            ...base,
            eventName: 'issue_comment',
            isPullRequestComment: true,
            commentBody: 'please run /ui-preview on this',
            commentAuthorMaintainer: true,
        });

        expect(result.decision).toBe(DECISION.none);
    });
});

describe('user triggers a manual run', () => {
    it('user gets a preview for a pull request with no interface change when forcing', () => {
        const result = decide({
            ...base,
            eventName: 'workflow_dispatch',
            hasUiChange: false,
            manualForce: true,
        });

        expect(result.decision).toBe(DECISION.run);
    });

    it('user gets no preview for a manual run without a UI change or force', () => {
        const result = decide({
            ...base,
            eventName: 'workflow_dispatch',
            hasUiChange: false,
            manualForce: false,
        });

        expect(result.decision).toBe(DECISION.none);
    });
});

describe('user writes the command in different shapes', () => {
    it('user triggers the preview with the command alone', () => {
        expect(isPreviewCommand('/ui-preview')).toBe(true);
    });

    it('user triggers the preview with a trailing explanation', () => {
        expect(isPreviewCommand('/ui-preview please')).toBe(true);
    });

    it('user does not trigger it from a quoted line', () => {
        expect(isPreviewCommand('> /ui-preview')).toBe(false);
    });

    it('user does not trigger it from a longer word', () => {
        expect(isPreviewCommand('/ui-previewer')).toBe(false);
    });
});
