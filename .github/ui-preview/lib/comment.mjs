/**
 * Builds the single preview comment and finds the one comment it may edit.
 *
 * Two rules keep editing precise:
 * - Only a comment written by the token's own account is a candidate, so a
 *   contributor cannot hijack the marker in their own comment.
 * - Only the oldest candidate that starts with the marker is used, so a stale
 *   duplicate from a previous identity is never edited by accident.
 */

export const MARKER = '<!-- touchai-ui-preview -->';

export function hasMarker(body) {
    return String(body ?? '')
        .trimStart()
        .startsWith(MARKER);
}

/**
 * @param {Array<{ id: number, body?: string, user?: { login?: string } }>} comments
 * @param {string} login
 */
export function findOwnPreviewComment(comments, login) {
    if (!login) {
        return null;
    }

    const owned = (comments ?? [])
        .filter((comment) => comment?.user?.login === login && hasMarker(comment.body))
        .sort((left, right) => Number(left.id) - Number(right.id));

    return owned[0] ?? null;
}

function statusLabel(status) {
    if (status === 'pass') {
        return 'pass';
    }

    if (status === 'fail') {
        return '**fail**';
    }

    return 'not checked';
}

function renderChecks(checks) {
    const rows = (checks ?? []).map((check) => {
        const detail = check.detail ? `: ${check.detail}` : '';
        return `- ${check.name} (${statusLabel(check.status)})${detail}`;
    });

    if (rows.length === 0) {
        return '- No checks were recorded.';
    }

    return rows.join('\n');
}

function screenshotAlt(sceneTitle, shot) {
    const title = String(sceneTitle ?? '').replace(/[[\]]/g, '');
    const caption = String(shot.caption ?? '').replace(/[[\]]/g, '');
    return [title, caption].filter(Boolean).join(': ') || 'UI preview screenshot';
}

/**
 * Key screenshots are rendered as images inside one collapsed block. The video
 * stays visible, and the collapsed block keeps a multi-step preview readable.
 */
function renderScreenshots(scenes, assets) {
    const rendered = (scenes ?? []).flatMap((scene) =>
        (scene.shots ?? [])
            .filter((shot) => assets[shot.file])
            .map((shot) => ({ scene: scene.title, shot }))
    );

    if (rendered.length === 0) {
        return '';
    }

    const lines = [`<details><summary>Key screenshots (${rendered.length})</summary>`, ''];

    for (const { scene, shot } of rendered) {
        lines.push(`![${screenshotAlt(scene, shot)}](${assets[shot.file]})`);
        lines.push('');
        lines.push(shot.caption ? `${scene}: ${shot.caption}` : scene, '');
    }

    lines.push('</details>');
    return lines.join('\n');
}

/**
 * @param {object} input
 * @param {string} input.sha
 * @param {string} input.runUrl
 * @param {string} input.trigger
 * @param {string} [input.summary]
 * @param {string} [input.mismatch]
 * @param {string} [input.unseen]
 * @param {Array<object>} [input.scenes]
 * @param {Array<object>} [input.checks]
 * @param {Record<string, string>} [input.assets]
 * @param {string} [input.videoUrl]
 * @param {string} [input.artifactUrl]
 * @param {string} [input.failure]
 * @param {Array<{ scene?: string, step?: string, error?: string }>} [input.skippedSteps]
 * @param {string} [input.note]
 */
export function buildPreviewComment(input) {
    const lines = [
        MARKER,
        '## UI preview',
        '',
        `\`${input.sha.slice(0, 7)}\` · ${input.trigger} · [run](${input.runUrl})`,
    ];

    if (input.summary) {
        lines.push('', `**What changed:** ${input.summary}`);
    }

    if (input.mismatch) {
        lines.push('', `**Description does not match the diff:** ${input.mismatch}`);
    }

    if (input.failure) {
        lines.push(
            '',
            `**Recording stopped:** ${input.failure}`,
            '',
            'The steps below are the evidence that exists. This preview does not claim the change works.'
        );
    }

    if (input.videoUrl) {
        lines.push('', input.videoUrl);
    } else if (input.artifactUrl) {
        lines.push('', `Video and screenshots: [workflow artifact](${input.artifactUrl})`);
    }

    const screenshots = renderScreenshots(input.scenes, input.assets ?? {});

    if (screenshots) {
        lines.push('', screenshots);
    }

    if (input.unseen) {
        lines.push('', `**Not shown:** ${input.unseen}`);
    }

    if (input.skippedSteps?.length) {
        lines.push(
            '',
            `<details><summary>${input.skippedSteps.length} step(s) did not run</summary>`,
            '',
            input.skippedSteps
                .map(
                    (item) =>
                        `- ${item.scene ? `${item.scene}: ` : ''}${item.step ?? 'step'} - ${item.error ?? 'failed'}`
                )
                .join('\n'),
            '',
            '</details>'
        );
    }

    lines.push(
        '',
        '<details><summary>Checks</summary>',
        '',
        renderChecks(input.checks),
        '',
        '</details>'
    );

    if (input.note) {
        lines.push('', input.note);
    }

    lines.push(
        '',
        '<sub>Updated for each commit. Advisory only, and rendered from a Linux WebKitGTK build; Windows and macOS may differ. Ask a maintainer to add `status:ui-preview-skip` to silence this pull request.</sub>'
    );

    return `${lines.join('\n')}\n`;
}

/**
 * The waiting comment is written before any build starts, so a contributor sees
 * why nothing happened and what unblocks it.
 */
export function buildWaitingComment(input) {
    return [
        MARKER,
        '## UI preview',
        '',
        `\`${input.sha.slice(0, 7)}\` · waiting for a maintainer`,
        '',
        'This pull request changes interface files. The preview builds pull-request code, so a maintainer has to start it first.',
        '',
        'A maintainer can start the preview by commenting `/ui-preview`, or by adding the `status:ui-preview-approved` label. The approval covers later commits on this pull request.',
        '',
        'Nothing is built or recorded until a maintainer does one of those.',
        '',
        '<sub>Advisory only. Add `status:ui-preview-skip` to silence this pull request.</sub>',
    ].join('\n');
}

/**
 * Written the moment a run starts, so the old evidence is not mistaken for
 * this commit's result while the build and the recording are still going.
 */
export function buildRecordingComment(input) {
    return [
        MARKER,
        '## UI preview',
        '',
        `\`${input.sha.slice(0, 7)}\` · recording`,
        '',
        'This commit is being built and recorded. The evidence below replaces this note when the run finishes.',
        '',
        '<sub>Advisory only. Add `status:ui-preview-skip` to silence this pull request.</sub>',
    ].join('\n');
}

export function buildSkippedComment(input) {
    return [
        MARKER,
        '## UI preview',
        '',
        `\`${input.sha.slice(0, 7)}\` · skipped`,
        '',
        'A maintainer set `status:ui-preview-skip`, so this pull request does not get a preview. Remove the label to re-enable it.',
    ].join('\n');
}

export function isUnchanged(existingBody, nextBody) {
    return (
        String(existingBody ?? '').replace(/\r\n/g, '\n') ===
        String(nextBody ?? '').replace(/\r\n/g, '\n')
    );
}
