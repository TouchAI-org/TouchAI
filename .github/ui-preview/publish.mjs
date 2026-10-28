/**
 * Uploads the evidence and updates the one preview comment.
 *
 * Two credentials, two jobs:
 * - ATTACHMENT_TOKEN belongs to a user and is used for the asset POST only,
 *   because the upload endpoint rejects App tokens.
 * - GH_TOKEN is the App installation token and is used for the comment only.
 *
 * Runs trusted code only; it never checks out the pull request.
 */

import fs from 'node:fs';
import path from 'node:path';

import { buildPreviewComment, findOwnPreviewComment, isUnchanged } from './lib/comment.mjs';
import { findSecret, MIME_TYPES, validateEvidence } from './lib/evidence.mjs';
import { createClient, resolveBotLogin } from './lib/github.mjs';

const MAX_SHOTS = 10;

function env(name, fallback = '') {
    return process.env[name] ?? fallback;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function uploadWithRetry(client, options) {
    let lastError = null;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
            return await client.uploadAsset(options);
        } catch (error) {
            lastError = error;

            if (error.status === 404 || error.status === 401 || error.status === 403) {
                break;
            }

            await sleep(attempt * 2000);
        }
    }

    throw lastError;
}

async function main() {
    const [owner, repo] = String(env('GITHUB_REPOSITORY')).split('/');
    const token = env('GH_TOKEN');
    const uploadToken = env('ATTACHMENT_TOKEN');
    const outDir = path.resolve(env('UI_PREVIEW_OUT', 'ui-preview-out'));
    const evidenceDir = path.join(outDir, 'evidence');
    const pr = Number(env('UI_PREVIEW_PR'));
    const serverUrl = env('GITHUB_SERVER_URL', 'https://github.com');
    const runUrl = `${serverUrl}/${owner}/${repo}/actions/runs/${env('GITHUB_RUN_ID')}`;
    const artifactUrl = env('UI_PREVIEW_ARTIFACT_URL');
    const repositoryId = Number(env('UI_PREVIEW_REPOSITORY_ID', '0'));
    const sha = env('UI_PREVIEW_SHA');
    const trigger = env('UI_PREVIEW_TRIGGER', 'pull request');
    const dryRun = String(env('UI_PREVIEW_DRY_RUN', '')) === '1';

    if (!owner || !repo || !pr) {
        throw new Error('GITHUB_REPOSITORY and UI_PREVIEW_PR are required');
    }

    if (!token && !dryRun) {
        throw new Error('GITHUB_REPOSITORY, GH_TOKEN, and UI_PREVIEW_PR are required');
    }

    const client = token ? createClient({ token, owner, repo }) : null;
    const botLogin = client ? await resolveBotLogin(client, env('UI_PREVIEW_BOT_LOGIN')) : '';
    const comments = client ? await client.listComments(pr) : [];
    const existing = findOwnPreviewComment(comments, botLogin);

    const manifestPath = path.join(outDir, 'manifest.json');

    if (!fs.existsSync(manifestPath)) {
        const body = buildPreviewComment({
            sha,
            runUrl,
            trigger,
            failure: 'the recording job did not produce a manifest, so no evidence exists',
            checks: [],
            artifactUrl,
        });
        await write(body);
        return;
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    const leak = findSecret(fs.readFileSync(manifestPath, 'utf8'));

    if (leak) {
        await write(
            buildPreviewComment({
                sha: manifest.sha ?? sha,
                runUrl,
                trigger,
                failure:
                    'the evidence contains a credential-shaped string, so nothing was published',
                checks: [],
                artifactUrl,
            })
        );
        throw new Error(`refusing to publish: a credential-shaped string (${leak.sample})`);
    }

    const validation = validateEvidence(evidenceDir, manifest);

    if (!validation.ok) {
        const body = buildPreviewComment({
            sha: manifest.sha ?? sha,
            runUrl,
            trigger,
            summary: manifest.summary,
            failure: `the evidence failed validation: ${validation.errors.slice(0, 3).join('; ')}`,
            checks: manifest.checks ?? [],
            artifactUrl,
        });
        await write(body);
        return;
    }

    const assets = {};
    const shots = [];

    for (const scene of manifest.scenes ?? []) {
        for (const shot of scene.shots ?? []) {
            if (shots.length < MAX_SHOTS) {
                shots.push({ scene, shot });
            }
        }
    }

    if (dryRun) {
        const body = buildPreviewComment({
            sha: manifest.sha ?? sha,
            runUrl,
            trigger,
            summary: manifest.summary,
            mismatch: manifest.mismatch,
            unseen: manifest.unseen,
            scenes: manifest.scenes,
            checks: manifest.checks ?? [],
            skippedSteps: manifest.skippedSteps ?? [],
            assets: Object.fromEntries(
                validation.assets.shots.map((file) => [
                    file,
                    `https://github.com/user-attachments/assets/local-${path.basename(file)}`,
                ])
            ),
            videoUrl: validation.assets.video
                ? `https://github.com/user-attachments/assets/local-${path.basename(validation.assets.video)}`
                : '',
            artifactUrl,
            failure: manifest.failure
                ? `${manifest.failure.step}: ${manifest.failure.message}`
                : '',
        });
        fs.writeFileSync(path.join(outDir, 'comment.md'), body);
        console.log(`dry run: wrote ${path.join(outDir, 'comment.md')}`);
        return;
    }

    if (!uploadToken) {
        console.log('ATTACHMENT_TOKEN is not set; publishing links instead of media');
    } else if (repositoryId === 0) {
        console.log('the repository id is missing; publishing links instead of media');
    } else {
        for (const { shot } of shots) {
            const file = path.join(evidenceDir, shot.file);
            const data = fs.readFileSync(file);
            const url = await uploadWithRetry(client, {
                token: uploadToken,
                name: shot.file,
                contentType: MIME_TYPES[path.extname(shot.file)] ?? 'application/octet-stream',
                data,
                repositoryId,
            });
            assets[shot.file] = url;
            console.log(`uploaded ${shot.file}`);
        }

        if (validation.assets.video) {
            const file = path.join(evidenceDir, validation.assets.video);
            const data = fs.readFileSync(file);
            assets[validation.assets.video] = await uploadWithRetry(client, {
                token: uploadToken,
                name: validation.assets.video,
                contentType: MIME_TYPES['.mp4'],
                data,
                repositoryId,
            });
            console.log(`uploaded ${validation.assets.video}`);
        }
    }

    const renderedScenes = (manifest.scenes ?? [])
        .map((scene) => ({
            ...scene,
            shots: (scene.shots ?? []).filter((shot) => assets[shot.file]),
        }))
        .filter((scene) => scene.shots.length > 0);

    const body = buildPreviewComment({
        sha: manifest.sha ?? sha,
        runUrl: manifest.runUrl || runUrl,
        trigger: manifest.trigger || trigger,
        summary: manifest.summary,
        mismatch: manifest.mismatch,
        unseen: [
            manifest.unseen,
            renderedScenes.length === 0 && !validation.assets.video
                ? 'The evidence is in the workflow artifact because no media could be uploaded.'
                : '',
            shots.length > MAX_SHOTS ? `Only the first ${MAX_SHOTS} screenshots are shown.` : '',
        ]
            .filter(Boolean)
            .join(' '),
        scenes: renderedScenes,
        checks: manifest.checks ?? [],
        skippedSteps: manifest.skippedSteps ?? [],
        assets,
        videoUrl: validation.assets.video ? assets[validation.assets.video] : '',
        artifactUrl,
        failure: manifest.failure ? `${manifest.failure.step}: ${manifest.failure.message}` : '',
    });

    await write(body);

    async function write(nextBody) {
        if (existing && isUnchanged(existing.body, nextBody)) {
            console.log('the preview comment is already current');
            return;
        }

        if (existing) {
            await client.updateComment(existing.id, nextBody);
            console.log(`updated comment ${existing.id}`);
        } else {
            const created = await client.createComment(pr, nextBody);
            console.log(`created comment ${created.id}`);
        }
    }
}

main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exit(1);
});
