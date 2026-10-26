/**
 * Uploads the visual diff images and records where each one landed.
 *
 * The images have to be reachable from a pull request comment, and the artifact
 * endpoint is not: it needs authentication, so `![](artifact-url)` renders nothing.
 * GitHub's attachment store is the one place that serves an image publicly from this
 * repository, and the upload endpoint behind it is the same one the web UI uses when a
 * file is pasted into a comment.
 *
 * Two behaviours of that endpoint are undocumented and were measured rather than
 * assumed:
 *
 * 1. A fresh upload is not readable yet. Its URL answers 404 until some comment
 *    references it, and then serves the image anonymously. The report embeds the URL in
 *    the comment it posts, which is what activates it. Deleting that comment later does
 *    not revoke the URL.
 * 2. It requires a user token. Installation tokens and `GITHUB_TOKEN` get 404, because
 *    an attachment has an author and a bot has none.
 *
 * The request shape mirrors `.github/ui-preview/lib/github.mjs` from the UI preview
 * work rather than importing it: that module belongs to a different workflow, and
 * coupling this suite to its internal structure would make either one harder to change.
 * The endpoint is the shared thing, and it is one call.
 *
 * Usage: node scripts/ci/publish-evidence.mjs <images-dir> <output.json>
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const UPLOADS = 'https://uploads.github.com';

const [imagesDir, outputPath] = process.argv.slice(2);

if (!imagesDir || !outputPath) {
    throw new Error('usage: publish-evidence.mjs <images-dir> <output.json>');
}

const token = process.env.UI_PREVIEW_TOKEN ?? '';
const repositoryId = Number(process.env.UI_PREVIEW_REPOSITORY_ID ?? '0');

/**
 * Writes an empty map when uploading is not possible, so the caller has one shape to
 * read. The report then falls back to linking the artifact, which is a worse report
 * but not a failed run: a fork pull request and a missing secret both land here, and
 * neither is a reason to fail the visual comparison itself.
 */
const giveUp = (reason) => {
    console.log(`Not uploading the diff images: ${reason}`);
    writeFileSync(outputPath, '{}\n', 'utf8');
    process.exit(0);
};

if (!token) {
    giveUp('UI_PREVIEW_TOKEN is not set');
}

if (repositoryId === 0) {
    giveUp('UI_PREVIEW_REPOSITORY_ID is not set');
}

if (!existsSync(imagesDir)) {
    giveUp(`${imagesDir} does not exist`);
}

const images = readdirSync(imagesDir).filter((name) => /\.(png|webp)$/i.test(name));

if (images.length === 0) {
    giveUp('no images were produced');
}

/**
 * One upload, with the retry the endpoint needs: it is rate limited and answers 5xx
 * under load, and losing one image leaves a table cell pointing at nothing.
 */
const upload = async (name) => {
    const data = readFileSync(path.join(imagesDir, name));
    const url = new URL(`${UPLOADS}/user-attachments/assets`);
    url.searchParams.set('name', name);
    url.searchParams.set('content_type', 'image/png');
    url.searchParams.set('repository_id', String(repositoryId));

    let lastError = null;

    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                Accept: 'application/vnd.github+json',
                // `token`, not `Bearer`: the upload host rejects the other spelling.
                Authorization: `token ${token}`,
                'Content-Type': 'application/octet-stream',
                'User-Agent': 'touchai-visual-tests',
            },
            body: data,
        });

        const text = await response.text();

        if (response.ok) {
            const parsed = JSON.parse(text);

            if (!parsed.url) {
                throw new Error(`upload of ${name} returned no url`);
            }

            return parsed.url;
        }

        lastError = new Error(
            `upload of ${name} failed with ${response.status}: ${text.slice(0, 200)}`
        );

        // 401, 403 and 404 mean the credential or the repository is wrong, and a retry
        // cannot fix either.
        if ([401, 403, 404].includes(response.status)) {
            break;
        }

        await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
    }

    throw lastError;
};

const urls = {};

for (const name of images) {
    try {
        urls[name] = await upload(name);
        console.log(`uploaded ${name}`);
    } catch (error) {
        // A partial map is still worth having: the images that did upload render, and
        // the rest fall back to the artifact link for that row.
        console.error(String(error.message ?? error));
    }
}

writeFileSync(outputPath, `${JSON.stringify(urls, null, 2)}\n`, 'utf8');
console.log(`recorded ${Object.keys(urls).length} of ${images.length} image(s).`);
