/**
 * Decides whether this pull request gets a preview, and writes the waiting,
 * skipped, or recording comment.
 *
 * Runs trusted code only: it never checks out the pull request. The App token it
 * receives can read the pull request and write one issue comment.
 */

import fs from 'node:fs';

import {
    buildRecordingComment,
    buildSkippedComment,
    buildWaitingComment,
    findOwnPreviewComment,
    isUnchanged,
} from './lib/comment.mjs';
import { APPROVED_LABEL, classifyFiles, decide, DECISION, FORCE_LABEL } from './lib/decision.mjs';
import { createClient, resolveBotLogin } from './lib/github.mjs';

function readEvent() {
    const eventPath = process.env.GITHUB_EVENT_PATH;

    if (!eventPath || !fs.existsSync(eventPath)) {
        return {};
    }

    return JSON.parse(fs.readFileSync(eventPath, 'utf8'));
}

function writeOutputs(values) {
    const outputPath = process.env.GITHUB_OUTPUT;
    const lines = Object.entries(values).map(([key, value]) => `${key}=${value ?? ''}`);
    const text = `${lines.join('\n')}\n`;

    if (outputPath) {
        fs.appendFileSync(outputPath, text);
    }

    console.log(text.trim());
}

function isMaintainerPermission(permission) {
    return ['admin', 'maintain', 'write'].includes(permission);
}

async function main() {
    const [owner, repo] = String(process.env.GITHUB_REPOSITORY ?? '').split('/');
    const token = process.env.GH_TOKEN;
    const eventName = process.env.GITHUB_EVENT_NAME;
    const event = readEvent();
    const serverUrl = process.env.GITHUB_SERVER_URL ?? 'https://github.com';
    const runUrl = `${serverUrl}/${owner}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`;

    if (!owner || !repo || !token) {
        throw new Error('GITHUB_REPOSITORY and GH_TOKEN are required');
    }

    const client = createClient({ token, owner, repo });
    const botLogin = await resolveBotLogin(client, process.env.UI_PREVIEW_BOT_LOGIN);
    const dryRun = String(process.env.UI_PREVIEW_DRY_RUN ?? '') === '1';
    const dispatchPr = Number(process.env.INPUT_PR ?? 0);
    const manualForce = String(process.env.INPUT_FORCE ?? '') === 'true';

    const isComment = eventName === 'issue_comment';
    const isDispatch = eventName === 'workflow_dispatch';
    const isPullRequestComment = Boolean(event?.issue?.pull_request);
    const prNumber = isComment
        ? Number(event?.issue?.number ?? 0)
        : isDispatch
          ? dispatchPr
          : Number(event?.pull_request?.number ?? 0);

    if (!prNumber) {
        writeOutputs({ decision: DECISION.none, reason: 'no pull request number' });
        return;
    }

    const pull = await client.getPullRequest(prNumber);
    const files = await client.listPullRequestFiles(prNumber);
    const classification = classifyFiles(files);
    const labels = (pull.labels ?? []).map((label) =>
        typeof label === 'string' ? label : label.name
    );
    const labelName = event?.label?.name;
    const labelActor = String(event?.sender?.login ?? '');
    const labelActorIsBot = labelActor.endsWith('[bot]');
    const gatedLabel =
        eventName === 'pull_request_target' &&
        event?.action === 'labeled' &&
        [FORCE_LABEL, APPROVED_LABEL].includes(labelName);
    const labelActorMaintainer =
        !gatedLabel ||
        labelActorIsBot ||
        (labelActor.length > 0 && isMaintainerPermission(await client.getPermission(labelActor)));

    let maintainer = false;
    let commentAuthorMaintainer = false;

    if (isComment) {
        const commentAuthor = String(event?.comment?.user?.login ?? '');
        commentAuthorMaintainer =
            commentAuthor.length > 0 &&
            isMaintainerPermission(await client.getPermission(commentAuthor));
    } else {
        maintainer = isMaintainerPermission(await client.getPermission(pull.user?.login ?? ''));
    }

    const result = decide({
        eventName,
        action: event?.action,
        actor: event?.sender?.login ?? event?.comment?.user?.login,
        labelName: event?.label?.name,
        labels,
        draft: Boolean(pull.draft),
        maintainer,
        hasUiChange: classification.hasUiChange,
        isPullRequestComment,
        commentBody: event?.comment?.body,
        commentAuthorMaintainer,
        labelActorMaintainer,
        manualForce,
    });

    console.log(`decision: ${result.decision} (${result.reason})`);
    console.log(`ui files: ${classification.ui.length}`);

    if (gatedLabel && !labelActorIsBot && !labelActorMaintainer && !dryRun) {
        await client.removeLabel(prNumber, labelName);
        console.log(`removed ${labelName}: only a maintainer may apply it`);
    }

    if (result.decision === DECISION.awaitingApproval && !dryRun) {
        const body = buildWaitingComment({ sha: pull.head.sha });
        const comments = await client.listComments(prNumber);
        const existing = findOwnPreviewComment(comments, botLogin);

        if (existing && isUnchanged(existing.body, body)) {
            console.log('the waiting comment is already current');
        } else if (existing) {
            await client.updateComment(existing.id, body);
        } else {
            await client.createComment(prNumber, body);
        }
    }

    if (result.decision === DECISION.skipped && !dryRun) {
        const comments = await client.listComments(prNumber);
        const existing = findOwnPreviewComment(comments, botLogin);

        if (existing) {
            const body = buildSkippedComment({ sha: pull.head.sha });

            if (!isUnchanged(existing.body, body)) {
                await client.updateComment(existing.id, body);
            }
        }
    }

    if (result.decision === DECISION.run && result.addApprovedLabel && !dryRun) {
        await client.addLabels(prNumber, ['status:ui-preview-approved']);
    }

    if (result.decision === DECISION.run && !dryRun) {
        const comments = await client.listComments(prNumber);
        const existing = findOwnPreviewComment(comments, botLogin);
        const body = buildRecordingComment({ sha: pull.head.sha });

        if (existing && !isUnchanged(existing.body, body)) {
            await client.updateComment(existing.id, body);
        }
    }

    if (dryRun) {
        console.log('dry run: no comment or label was written');
    }

    writeOutputs({
        decision: result.decision,
        reason: result.reason,
        pr: prNumber,
        title: pull.title ?? '',
        sha: pull.head.sha,
        head_repo: pull.head.repo?.full_name ?? '',
        head_ref: pull.head.ref ?? '',
        base_ref: pull.base?.ref ?? '',
        base_sha: pull.base?.sha ?? '',
        run_url: runUrl,
        trigger: isComment
            ? 'maintainer request'
            : isDispatch
              ? 'manual run'
              : maintainer
                ? 'maintainer pull request'
                : 'approved pull request',
        touched_i18n: classification.touchedI18n,
        touched_window: classification.touchedWindow,
        touched_settings: classification.touchedSettings,
        touched_search: classification.touchedSearch,
    });
}

main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exit(1);
});
