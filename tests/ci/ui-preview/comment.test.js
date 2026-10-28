import { describe, expect, it } from 'vitest';

import {
    buildPreviewComment,
    buildRecordingComment,
    buildSkippedComment,
    buildWaitingComment,
    findOwnPreviewComment,
    hasMarker,
    isUnchanged,
    MARKER,
} from '../../../.github/ui-preview/lib/comment.mjs';

const baseComment = {
    sha: 'a1b2c3d4e5f6',
    runUrl: 'https://github.com/TouchAI-org/TouchAI/actions/runs/1',
    trigger: 'maintainer pull request',
};

describe('user reads the preview comment', () => {
    it('user sees the marker first so the comment can be found again', () => {
        const body = buildPreviewComment(baseComment);

        expect(body.startsWith(MARKER)).toBe(true);
    });

    it('user sees the short commit, the trigger, and the run link', () => {
        const body = buildPreviewComment(baseComment);

        expect(body).toContain('`a1b2c3d`');
        expect(body).toContain('maintainer pull request');
        expect(body).toContain('actions/runs/1');
    });

    it('user sees a video player when a video url exists', () => {
        const body = buildPreviewComment({
            ...baseComment,
            videoUrl: 'https://github.com/user-attachments/assets/video',
        });

        expect(body).toContain('\nhttps://github.com/user-attachments/assets/video\n');
    });

    it('user sees screenshots as images inside one collapsed block', () => {
        const body = buildPreviewComment({
            ...baseComment,
            scenes: [
                {
                    title: 'Shortcuts',
                    shots: [{ file: 'a.png', caption: 'Shortcuts section' }],
                },
            ],
            assets: { 'a.png': 'https://github.com/user-attachments/assets/a' },
        });

        expect(body).toContain('<details><summary>Key screenshots (1)</summary>');
        expect(body).toContain(
            '![Shortcuts: Shortcuts section](https://github.com/user-attachments/assets/a)'
        );
        expect(body).not.toContain('\nhttps://github.com/user-attachments/assets/a\n');
        expect(body).not.toContain('<img');
        expect(body).toContain('Shortcuts section');
    });

    it('user never sees a screenshot that failed to upload', () => {
        const body = buildPreviewComment({
            ...baseComment,
            scenes: [{ title: 'Shortcuts', shots: [{ file: 'a.png', caption: 'x' }] }],
            assets: {},
        });

        expect(body).not.toContain('user-attachments');
        expect(body).not.toContain('### Shortcuts');
    });

    it('user sees a failure instead of a success claim when recording stopped', () => {
        const body = buildPreviewComment({
            ...baseComment,
            failure: 'Settings: click',
        });

        expect(body).toContain('**Recording stopped:** Settings: click');
        expect(body).toContain('does not claim the change works');
    });

    it('user sees the checks collapsed so the media stays first', () => {
        const body = buildPreviewComment({
            ...baseComment,
            checks: [{ name: 'Renderer console errors', status: 'pass' }],
        });

        expect(body).toContain('<details><summary>Checks</summary>');
        expect(body).toContain('Renderer console errors (pass)');
    });

    it('user sees a failed check marked as failed', () => {
        const body = buildPreviewComment({
            ...baseComment,
            checks: [
                { name: 'Locale key parity', status: 'fail', detail: 'missing in en-US: a.b' },
            ],
        });

        expect(body).toContain('Locale key parity (**fail**): missing in en-US: a.b');
    });

    it('user sees which steps did not run, collapsed below the media', () => {
        const body = buildPreviewComment({
            ...baseComment,
            skippedSteps: [
                {
                    scene: 'Shortcuts',
                    step: "click [data-testid='settings-nav-usage']",
                    error: 'element was not visible',
                },
            ],
        });

        expect(body).toContain('<details><summary>1 step(s) did not run</summary>');
        expect(body).toContain('Shortcuts: click');
        expect(body).toContain('element was not visible');
    });
});

describe('user reads the waiting and skipped comments', () => {
    it('user sees that the commit is being recorded instead of the previous evidence', () => {
        const body = buildRecordingComment({ sha: 'a1b2c3d4e5f6' });

        expect(body.startsWith(MARKER)).toBe(true);
        expect(body).toContain('`a1b2c3d`');
        expect(body).toContain('recording');
        expect(body).toContain('replaces this note');
    });

    it('user sees how to approve when a maintainer has not approved yet', () => {
        const body = buildWaitingComment({ sha: 'a1b2c3d4e5f6' });

        expect(body).toContain('/ui-preview');
        expect(body).toContain('status:ui-preview-approved');
        expect(hasMarker(body)).toBe(true);
    });

    it('user sees why nothing ran when a maintainer skipped the pull request', () => {
        const body = buildSkippedComment({ sha: 'a1b2c3d4e5f6' });

        expect(body).toContain('skipped');
        expect(body).toContain('status:ui-preview-skip');
        expect(hasMarker(body)).toBe(true);
    });
});

describe('user opens a pull request with existing comments', () => {
    const comments = [
        {
            id: 1,
            user: { login: 'contributor' },
            body: `${MARKER}\n## UI preview\n\nfake`,
        },
        {
            id: 2,
            user: { login: 'touchai-ui-preview[bot]' },
            body: 'unrelated',
        },
        {
            id: 3,
            user: { login: 'touchai-ui-preview[bot]' },
            body: `${MARKER}\n## UI preview\n\nreal`,
        },
    ];

    it('user gets the bot comment and never a contributor comment with the same marker', () => {
        const found = findOwnPreviewComment(comments, 'touchai-ui-preview[bot]');

        expect(found?.id).toBe(3);
    });

    it('user gets no match when the token account owns no preview comment', () => {
        expect(findOwnPreviewComment(comments, 'someone-else')).toBeNull();
    });

    it('user gets no match when the login is unknown', () => {
        expect(findOwnPreviewComment(comments, '')).toBeNull();
    });

    it('user keeps the oldest preview comment when a duplicate exists', () => {
        const duplicates = [
            { id: 9, user: { login: 'bot[bot]' }, body: `${MARKER}\nsecond` },
            { id: 4, user: { login: 'bot[bot]' }, body: `${MARKER}\nfirst` },
        ];

        expect(findOwnPreviewComment(duplicates, 'bot[bot]')?.id).toBe(4);
    });
});

describe('user pushes a commit that changes nothing visible', () => {
    it('user sees no edit when the rendered comment is identical', () => {
        expect(isUnchanged('a\r\nb', 'a\nb')).toBe(true);
    });

    it('user sees an edit when the comment changed', () => {
        expect(isUnchanged('a', 'b')).toBe(false);
    });
});
