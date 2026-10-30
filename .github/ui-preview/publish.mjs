/**
 * Uploads the evidence for every platform and updates the one preview comment.
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
import { platformLabel, PLATFORMS } from './lib/platform.mjs';

const MAX_SHOTS_PER_PLATFORM = 10;

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

function findManifestFiles(root) {
    const files = [];
    const queue = [root];

    while (queue.length > 0) {
        const current = queue.shift();
        let entries;

        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {
            const full = path.join(current, entry.name);

            if (entry.isDirectory()) {
                if (entry.name !== 'node_modules' && entry.name !== '.git') {
                    queue.push(full);
                }
                continue;
            }

            if (entry.name === 'manifest.json') {
                files.push(full);
            }
        }
    }

    return files.sort();
}

function platformFromPath(file) {
    const lower = String(file).toLowerCase();

    for (const platform of PLATFORMS) {
        if (lower.includes(platform)) {
            return platform;
        }
    }

    return 'linux';
}

function loadManifests(outDir, expectedPlatforms) {
    const found = new Map();

    for (const file of findManifestFiles(outDir)) {
        let manifest;

        try {
            manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (error) {
            console.log(`ignoring unreadable manifest ${file}: ${error.message}`);
            continue;
        }

        const platform = PLATFORMS.includes(manifest.platform)
            ? manifest.platform
            : platformFromPath(file);
        const current = found.get(platform);

        if (
            !current ||
            (!current.manifest.video && manifest.video) ||
            (current.manifest.failure && !manifest.failure)
        ) {
            found.set(platform, {
                platform,
                file,
                manifest,
                evidenceDir: path.join(path.dirname(file), 'evidence'),
            });
        }
    }

    return expectedPlatforms.map((platform) => found.get(platform) ?? { platform, missing: true });
}

function selectShots(manifest, available) {
    const shots = [];

    for (const scene of manifest.scenes ?? []) {
        for (const shot of scene.shots ?? []) {
            if (shots.length >= MAX_SHOTS_PER_PLATFORM) {
                return shots;
            }

            if (available.has(shot.file)) {
                shots.push({ scene, shot });
            }
        }
    }

    return shots;
}

function shotCount(manifest) {
    return (manifest.scenes ?? []).reduce((total, scene) => total + (scene.shots?.length ?? 0), 0);
}

/**
 * A warning that every platform reported is a property of the run, such as the
 * planner falling back to the default scene, so it is shown once. A warning
 * from one platform keeps its label, because that is the part that matters.
 */
function collectWarnings(entries) {
    const present = entries.filter((entry) => !entry.missing);
    const byText = new Map();

    for (const entry of present) {
        for (const warning of entry.manifest.warnings ?? []) {
            const text = String(warning);
            const platforms = byText.get(text) ?? new Set();
            platforms.add(entry.platform);
            byText.set(text, platforms);
        }
    }

    return [...byText].map(([warning, platforms]) =>
        present.length > 1 && platforms.size === present.length
            ? warning
            : `${[...platforms].map(platformLabel).join(', ')}: ${warning}`
    );
}

async function main() {
    const [owner, repo] = String(env('GITHUB_REPOSITORY')).split('/');
    const token = env('GH_TOKEN');
    const uploadToken = env('ATTACHMENT_TOKEN');
    const outDir = path.resolve(env('UI_PREVIEW_OUT', 'ui-preview-out'));
    const pr = Number(env('UI_PREVIEW_PR'));
    const serverUrl = env('GITHUB_SERVER_URL', 'https://github.com');
    const runUrl = `${serverUrl}/${owner}/${repo}/actions/runs/${env('GITHUB_RUN_ID')}`;
    const artifactUrl = env('UI_PREVIEW_ARTIFACT_URL');
    const repositoryId = Number(env('UI_PREVIEW_REPOSITORY_ID', '0'));
    const sha = env('UI_PREVIEW_SHA');
    const trigger = env('UI_PREVIEW_TRIGGER', 'pull request');
    const dryRun = String(env('UI_PREVIEW_DRY_RUN', '')) === '1';
    const expectedPlatforms = env('UI_PREVIEW_PLATFORMS', 'linux,macos,windows')
        .split(',')
        .map((platform) => platform.trim())
        .filter((platform) => PLATFORMS.includes(platform));

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
    const manifests = loadManifests(outDir, expectedPlatforms);
    const present = manifests.filter((entry) => !entry.missing);

    if (present.length === 0) {
        const body = buildPreviewComment({
            sha,
            runUrl,
            trigger,
            failure: 'the recording jobs did not produce a manifest, so no evidence exists',
            platforms: expectedPlatforms.map((platform) => ({
                platform,
                label: platformLabel(platform),
                failure: 'no evidence artifact was produced',
                artifactUrl,
            })),
        });
        await write(body);
        return;
    }

    const first = present[0].manifest;
    const platforms = [];
    const unseen = [first.unseen];
    const warnings = collectWarnings(manifests);
    const missing = manifests
        .filter((entry) => entry.missing)
        .map((entry) => platformLabel(entry.platform));
    let truncated = false;

    // Publishing media needs a user credential and the repository id. When
    // either is missing the comment still renders, but it says so, because a
    // link-only comment looks like a bug in the recording.
    if (!dryRun && (!uploadToken || repositoryId === 0)) {
        const hasMedia = present.some(
            (entry) => entry.manifest.video || shotCount(entry.manifest) > 0
        );

        if (hasMedia) {
            warnings.push(
                'Media could not be uploaded, so this comment links the workflow artifact instead. Check `ATTACHMENT_TOKEN` and the repository id.'
            );
        }
    }

    if (missing.length > 0) {
        unseen.push(`No evidence was produced for ${missing.join(', ')}.`);
    }

    for (const entry of manifests) {
        const label = platformLabel(entry.platform);

        if (entry.missing) {
            platforms.push({
                platform: entry.platform,
                label,
                failure: 'the recording job did not produce a manifest',
                artifactUrl,
            });
            continue;
        }

        const { manifest, evidenceDir, file } = entry;
        const leak = findSecret(fs.readFileSync(file, 'utf8'));
        const validation = leak
            ? {
                  ok: false,
                  errors: ['the manifest contains a credential-shaped string'],
                  assets: { shots: [], video: null },
              }
            : validateEvidence(evidenceDir, manifest);
        const available = new Set(validation.assets.shots);
        const selected = selectShots(manifest, available);
        const assets = {};
        let videoUrl = '';

        if (shotCount(manifest) > MAX_SHOTS_PER_PLATFORM) {
            truncated = true;
        }

        const uploadErrors = [];

        if (!dryRun && validation.ok && uploadToken && repositoryId !== 0) {
            for (const { shot } of selected) {
                try {
                    const absolute = path.join(evidenceDir, shot.file);
                    const data = fs.readFileSync(absolute);
                    const url = await uploadWithRetry(client, {
                        token: uploadToken,
                        name: `${entry.platform}-${shot.file}`,
                        contentType:
                            MIME_TYPES[path.extname(shot.file)] ?? 'application/octet-stream',
                        data,
                        repositoryId,
                    });
                    assets[shot.file] = url;
                    console.log(`uploaded ${entry.platform}/${shot.file}`);
                } catch (error) {
                    uploadErrors.push(`${shot.file}: ${error.message}`);
                    console.log(
                        `${entry.platform}: upload failed for ${shot.file}: ${error.message}`
                    );
                }
            }

            if (validation.assets.video) {
                try {
                    const filePath = path.join(evidenceDir, validation.assets.video);
                    const data = fs.readFileSync(filePath);
                    videoUrl = await uploadWithRetry(client, {
                        token: uploadToken,
                        name: `${entry.platform}-${validation.assets.video}`,
                        contentType: MIME_TYPES['.mp4'],
                        data,
                        repositoryId,
                    });
                    console.log(`uploaded ${entry.platform}/${validation.assets.video}`);
                } catch (error) {
                    uploadErrors.push(`${validation.assets.video}: ${error.message}`);
                    console.log(
                        `${entry.platform}: upload failed for ${validation.assets.video}: ${error.message}`
                    );
                }
            }

            if (uploadErrors.length > 0) {
                warnings.push(`${label}: media upload failed for ${uploadErrors.join('; ')}`);
            }
        } else if (dryRun) {
            for (const { shot } of selected) {
                assets[shot.file] =
                    `https://github.com/user-attachments/assets/local-${entry.platform}-${path.basename(shot.file)}`;
            }

            if (validation.assets.video) {
                videoUrl = `https://github.com/user-attachments/assets/local-${entry.platform}-${path.basename(validation.assets.video)}`;
            }
        } else if (validation.ok) {
            console.log(
                `${entry.platform}: no upload credential, so the comment links the artifact`
            );
        }

        const renderedScenes = (manifest.scenes ?? [])
            .map((scene) => ({
                ...scene,
                shots: (scene.shots ?? []).filter((shot) => assets[shot.file]),
            }))
            .filter((scene) => scene.shots.length > 0);
        const failure = leak
            ? 'the evidence contains a credential-shaped string, so nothing was published'
            : !validation.ok
              ? `the evidence failed validation: ${validation.errors.slice(0, 3).join('; ')}`
              : manifest.failure
                ? `${manifest.failure.step}: ${manifest.failure.message}`
                : '';

        platforms.push({
            platform: entry.platform,
            label,
            captureMode: manifest.captureMode,
            display: manifest.display,
            scale: manifest.scale,
            videoUrl,
            scenes: renderedScenes,
            assets,
            checks: manifest.checks ?? [],
            skippedSteps: manifest.skippedSteps ?? [],
            failure,
            artifactUrl,
        });
    }

    if (truncated) {
        unseen.push(
            `Only the first ${MAX_SHOTS_PER_PLATFORM} key screenshots per platform are shown.`
        );
    }

    const body = buildPreviewComment({
        sha: first.sha ?? sha,
        runUrl: first.runUrl || runUrl,
        trigger: first.trigger || trigger,
        summary: first.summary,
        mismatch: first.mismatch,
        unseen: unseen.filter(Boolean).join(' '),
        platforms,
        warnings,
        artifactUrl,
        note:
            (first.trigger || trigger) === 'native validation'
                ? 'This native validation run exercises the preview pipeline itself; the clips below are the feature demonstration for this pull request.'
                : '',
    });

    if (dryRun) {
        fs.writeFileSync(path.join(outDir, 'comment.md'), body);
        console.log(`dry run: wrote ${path.join(outDir, 'comment.md')}`);
        return;
    }

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
